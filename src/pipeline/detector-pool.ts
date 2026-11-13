import type { FaceBox, SourceRegion } from '../detectors/types'
import type { DetectRequest, DetectResponse } from './detect-worker'

interface Slot {
  worker: Worker
  busy: boolean
}

interface Job {
  resolve: (boxes: FaceBox[]) => void
  reject: (error: Error) => void
  slot: Slot
}

/** 이 컴퓨터에서 쓸 검출 워커 수. 해독·압축·화면용 코어를 남겨 둔다. */
export function recommendedPoolSize(cores: number): number {
  return Math.max(1, Math.min(4, Math.floor(cores / 2) - 1))
}

/**
 * 검출 워커 묶음. 프레임을 빈 워커에 맡기고, 빈 워커가 없으면 acquire() 에서 기다리게 해
 * 프레임이 쌓이지 않도록 한다(역압).
 */
export class DetectorPool {
  private readonly slots: Slot[] = []
  private readonly jobs = new Map<number, Job>()
  private waiters: Array<() => void> = []
  private nextId = 1
  private failure: Error | null = null

  private constructor() {}

  static async create(size: number, detectorId: string, scoreThreshold: number): Promise<DetectorPool> {
    const pool = new DetectorPool()
    // 워커가 여러 개면 워커마다 스레드 1개, 하나뿐이면 ONNX Runtime 이 여러 스레드를 쓰게 둔다.
    const threads = size > 1 ? 1 : 4
    try {
      await Promise.all(
        Array.from({ length: size }, () => {
          const worker = new Worker(new URL('./detect-worker.ts', import.meta.url), { type: 'module' })
          const slot: Slot = { worker, busy: false }
          pool.slots.push(slot)
          return new Promise<void>((resolve, reject) => {
            worker.onerror = (event) => {
              const error = new Error(`검출 워커 오류: ${event.message || '알 수 없는 오류'}`)
              reject(error)
              pool.fail(error)
            }
            worker.onmessage = (event: MessageEvent<DetectResponse>) => {
              const message = event.data
              if (message.type === 'ready') resolve()
              else if (message.type === 'error' && message.id === null) reject(new Error(message.message))
              else pool.receive(message)
            }
            const init: DetectRequest = { type: 'init', detectorId, scoreThreshold, threads }
            worker.postMessage(init)
          })
        }),
      )
    } catch (error) {
      pool.dispose()
      throw error
    }
    return pool
  }

  get size(): number {
    return this.slots.length
  }

  /** 빈 워커가 생길 때까지 기다린다. */
  async acquire(): Promise<void> {
    while (!this.failure && this.slots.every((slot) => slot.busy)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    if (this.failure) throw this.failure
  }

  /** bitmap 의 소유권은 워커로 넘어간다(워커가 닫는다). acquire() 뒤에 불러야 한다. */
  detect(bitmap: ImageBitmap, tiles: SourceRegion[]): Promise<FaceBox[]> {
    const slot = this.slots.find((item) => !item.busy)
    if (this.failure || !slot) {
      bitmap.close()
      return Promise.reject(this.failure ?? new Error('빈 검출 워커가 없습니다'))
    }
    slot.busy = true
    const id = this.nextId
    this.nextId += 1
    return new Promise<FaceBox[]>((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, slot })
      const request: DetectRequest = { type: 'detect', id, bitmap, tiles }
      slot.worker.postMessage(request, [bitmap])
    })
  }

  dispose(): void {
    for (const slot of this.slots) slot.worker.terminate()
    this.fail(new Error('검출을 중단했습니다'))
  }

  private receive(message: DetectResponse): void {
    if (message.type === 'ready' || message.id === null) return
    const job = this.jobs.get(message.id)
    if (!job) return
    this.jobs.delete(message.id)
    job.slot.busy = false
    if (message.type === 'result') job.resolve(message.boxes)
    else job.reject(new Error(message.message))
    this.wake()
  }

  private fail(error: Error): void {
    this.failure ??= error
    for (const job of this.jobs.values()) job.reject(this.failure)
    this.jobs.clear()
    this.wake()
  }

  private wake(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }
}
