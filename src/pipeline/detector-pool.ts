import type { SourceRegion } from '../detectors/types'
import type { DetectRequest, DetectResponse } from './detect-worker'
import type { FrameDetection } from './frame-detect'

export type { FrameDetection } from './frame-detect'

/** 검출을 맡는 자리 하나(검출 워커 하나, 또는 지금 스레드의 검출기) */
interface Slot {
  busy: boolean
  /** bitmap 의 소유권을 넘겨받는다(끝나면 닫는다). */
  detect(bitmap: ImageBitmap, tiles: SourceRegion[]): Promise<FrameDetection>
  /** 맡은 일을 모두 실패로 돌린다(워커가 죽었거나 묶음을 닫을 때). */
  cancel(error: Error): void
  close(): void
}

/** 검출 워커가 시작되지 못했다(스크립트를 불러오지 못했거나, 제한 시간 안에 준비되지 않았다). */
class WorkerStartError extends Error {
  readonly timedOut: boolean

  constructor(message: string, timedOut: boolean) {
    super(message)
    this.timedOut = timedOut
  }
}

/**
 * ONNX Runtime 이 여러 스레드를 쓰는 검출 워커가 이 시간 안에 준비되지 않으면, 내부 워커가 막혀 멈춘 것으로 보고
 * 스레드 1개로 다시 띄운다(보통 1~3초면 준비된다). 스레드 1개짜리 워커는 기다린다(느린 컴퓨터를 오판하지 않도록).
 */
export const WORKER_START_TIMEOUT_MS = 30_000

/** 검출 워커 대신 지금 스레드에서 검출할 때 진행 표시에 덧붙이는 안내 */
export const INLINE_DETECTION_NOTE =
  '이 브라우저에서는 얼굴 검출 워커를 띄울 수 없어 한 줄로 처리합니다(느립니다). 크롬·엣지·웨일에서 열면 더 빠릅니다.'

/**
 * 이 실행 환경(화면 또는 처리 워커)에서 겪은 제약. 한 번 겪으면 다음 묶음부터는 처음부터 피한다.
 * - threadsBlocked: ONNX Runtime 이 여러 스레드를 쓰지 못한다(여러 스레드는 ONNX Runtime 이 안에서 워커를 띄워야 한다).
 * - workersBlocked: 이곳에서 검출 워커를 띄울 수 없다.
 * 예: Claude 앱의 내장 브라우저는 워커 안에서 다시 워커를 띄우는 것을 막는다(스크립트를 불러오지 못하거나 멈춘다).
 */
const environment = { threadsBlocked: false, workersBlocked: false }

/** 이 컴퓨터에서 쓸 검출 워커 수. 해독·압축·화면용 코어를 남겨 둔다. */
export function recommendedPoolSize(cores: number): number {
  return Math.max(1, Math.min(4, Math.floor(cores / 2) - 1))
}

/**
 * 검출 워커 묶음. 프레임을 빈 워커에 맡기고, 빈 워커가 없으면 acquire() 에서 기다리게 해
 * 프레임이 쌓이지 않도록 한다(역압).
 *
 * 검출 워커를 띄울 수 없는 환경에서는 지금 스레드에서 직접 검출한다(runsInline). 결과는 같고 더 느리다.
 */
export class DetectorPool {
  private readonly slots: Slot[] = []
  private waiters: Array<() => void> = []
  private failure: Error | null = null
  private inline = false

  private constructor() {}

  static async create(size: number, detectorId: string, scoreThreshold: number): Promise<DetectorPool> {
    if (!environment.workersBlocked) {
      // 워커가 여러 개면 워커마다 스레드 1개, 하나뿐이면 ONNX Runtime 이 여러 스레드를 쓰게 둔다.
      let threads = size > 1 || environment.threadsBlocked ? 1 : 4
      for (;;) {
        try {
          return await DetectorPool.withWorkers(size, detectorId, scoreThreshold, threads)
        } catch (error) {
          if (!(error instanceof WorkerStartError)) throw error
          if (error.timedOut) {
            // 여러 스레드에 필요한 내부 워커가 막힌 환경에서는 준비되지 않고 멈춘다. 스레드 1개로 다시 띄운다.
            environment.threadsBlocked = true
            threads = 1
            continue
          }
          environment.workersBlocked = true
          console.warn(`[검출] ${error.message} 지금 스레드에서 직접 검출합니다(더 느립니다).`)
          break
        }
      }
    }
    return DetectorPool.inlinePool(detectorId, scoreThreshold)
  }

  get size(): number {
    return this.slots.length
  }

  /** 검출 워커를 쓰지 못해 지금 스레드에서 직접 검출하는지 */
  get runsInline(): boolean {
    return this.inline
  }

  /** 빈 워커가 생길 때까지 기다린다. */
  async acquire(): Promise<void> {
    while (!this.failure && this.slots.every((slot) => slot.busy)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    if (this.failure) throw this.failure
  }

  /** 상자만 필요할 때. bitmap 의 소유권은 넘어간다(검출이 끝나면 닫힌다). acquire() 뒤에 불러야 한다. */
  detect(bitmap: ImageBitmap, tiles: SourceRegion[]): Promise<FrameDetection['boxes']> {
    return this.detectFrame(bitmap, tiles).then((result) => result.boxes)
  }

  /** 상자와 장면 서명을 함께 받는다. bitmap 의 소유권은 넘어간다(검출이 끝나면 닫힌다). acquire() 뒤에 불러야 한다. */
  detectFrame(bitmap: ImageBitmap, tiles: SourceRegion[]): Promise<FrameDetection> {
    const slot = this.slots.find((item) => !item.busy)
    if (this.failure || !slot) {
      bitmap.close()
      return Promise.reject(this.failure ?? new Error('빈 검출 워커가 없습니다'))
    }
    slot.busy = true
    return slot.detect(bitmap, tiles).finally(() => {
      slot.busy = false
      this.wake()
    })
  }

  dispose(): void {
    for (const slot of this.slots) slot.close()
    this.fail(new Error('검출을 중단했습니다'))
  }

  private static async withWorkers(size: number, detectorId: string, scoreThreshold: number, threads: number): Promise<DetectorPool> {
    const pool = new DetectorPool()
    try {
      await Promise.all(Array.from({ length: size }, () => pool.startWorker(detectorId, scoreThreshold, threads)))
    } catch (error) {
      pool.dispose()
      throw error
    }
    return pool
  }

  /** 검출 워커 하나를 띄우고 준비될 때까지 기다린다. */
  private startWorker(detectorId: string, scoreThreshold: number, threads: number): Promise<void> {
    const worker = new Worker(new URL('./detect-worker.ts', import.meta.url), { type: 'module' })
    const jobs = new Map<number, { resolve: (result: FrameDetection) => void; reject: (error: Error) => void }>()
    let nextId = 1
    this.slots.push({
      busy: false,
      detect: (bitmap, tiles) =>
        new Promise<FrameDetection>((resolve, reject) => {
          const id = nextId
          nextId += 1
          jobs.set(id, { resolve, reject })
          const request: DetectRequest = { type: 'detect', id, bitmap, tiles }
          worker.postMessage(request, [bitmap])
        }),
      cancel: (error) => {
        for (const job of jobs.values()) job.reject(error)
        jobs.clear()
      },
      close: () => worker.terminate(),
    })

    return new Promise<void>((resolve, reject) => {
      let ready = false
      // 여러 스레드를 쓸 때만 제한 시간을 둔다. 스레드 1개면 막힐 내부 워커가 없으므로, 늦어도 기다린다.
      const timer =
        threads > 1
          ? setTimeout(() => {
              reject(new WorkerStartError(`검출 워커가 ${WORKER_START_TIMEOUT_MS / 1000}초 안에 준비되지 않았습니다.`, true))
            }, WORKER_START_TIMEOUT_MS)
          : undefined
      worker.onerror = (event) => {
        if (!ready) {
          // 스크립트를 불러오지 못한 경우 이유가 비어 있다(예: 워커 안에서 다시 워커를 띄우는 것을 막는 브라우저).
          clearTimeout(timer)
          reject(new WorkerStartError(`검출 워커를 시작하지 못했습니다${event.message ? `(${event.message})` : ''}.`, false))
          return
        }
        this.fail(new Error(`검출 워커 오류: ${event.message || '알 수 없는 오류'}`))
      }
      worker.onmessage = (event: MessageEvent<DetectResponse>) => {
        const message = event.data
        if (message.type === 'ready') {
          ready = true
          clearTimeout(timer)
          resolve()
          return
        }
        if (message.type === 'error' && message.id === null) {
          // 워커는 떴지만 모델을 불러오지 못했다. 지금 스레드에서 해도 같으므로 그대로 알린다.
          clearTimeout(timer)
          reject(new Error(message.message))
          return
        }
        const job = message.id === null ? undefined : jobs.get(message.id)
        if (!job || message.id === null) return
        jobs.delete(message.id)
        if (message.type === 'result') job.resolve({ boxes: message.boxes, signature: message.signature })
        else job.reject(new Error(message.message))
      }
      const init: DetectRequest = { type: 'init', detectorId, scoreThreshold, threads }
      worker.postMessage(init)
    })
  }

  /** 검출 워커 없이 지금 스레드에서 직접 검출하는 묶음(자리 1개). */
  private static async inlinePool(detectorId: string, scoreThreshold: number): Promise<DetectorPool> {
    // 검출 코드(ONNX Runtime)는 이때만 불러온다. 보통은 검출 워커 안에서만 쓰므로 화면·처리 워커의 파일을 키우지 않는다.
    const { FrameDetector } = await import('./frame-detect')
    let detector: Awaited<ReturnType<typeof FrameDetector.create>>
    try {
      // 지금 스레드에서는 ONNX Runtime 도 스레드 1개만 쓴다(여러 스레드에 필요한 내부 워커도 막혀 있을 수 있다).
      detector = await FrameDetector.create(detectorId, scoreThreshold, 1)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`얼굴 검출을 시작하지 못했습니다(${reason}). 크롬·엣지·웨일 최신 버전에서 다시 열어 주세요.`)
    }
    const pool = new DetectorPool()
    pool.inline = true
    let closed = false
    let running: Promise<unknown> = Promise.resolve()
    pool.slots.push({
      busy: false,
      detect: (bitmap, tiles) => {
        const job = (async () => {
          try {
            if (closed) throw new Error('검출을 중단했습니다')
            return await detector.detect(bitmap, tiles)
          } finally {
            bitmap.close()
          }
        })()
        running = job.catch(() => undefined)
        return job
      },
      cancel: () => {},
      close: () => {
        if (closed) return
        closed = true
        // 진행 중인 검출이 끝난 뒤에 모델을 내려놓는다.
        void running.then(() => detector.dispose())
      },
    })
    return pool
  }

  private fail(error: Error): void {
    this.failure ??= error
    for (const slot of this.slots) slot.cancel(this.failure)
    this.wake()
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
}
