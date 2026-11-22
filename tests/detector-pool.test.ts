import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 검출 코드(ONNX Runtime)와 워커는 가짜로 바꾼다. 검출 워커를 띄울 수 없을 때 지금 스레드에서 직접 검출하는 길로
// 제대로 넘어가는지만 본다(실제 검출 결과는 e2e 시험이 본다).
const state = vi.hoisted(() => ({
  created: [] as Array<{ threads: number; dispose: () => void; disposed: number }>,
  failCreate: null as Error | null,
  pending: null as Promise<unknown> | null,
}))

vi.mock('../src/pipeline/frame-detect', () => ({
  FrameDetector: {
    create: async (_detectorId: string, _scoreThreshold: number, threads: number) => {
      if (state.failCreate) throw state.failCreate
      const detector = {
        threads,
        disposed: 0,
        detect: async () => {
          if (state.pending) await state.pending
          return { boxes: [{ x: 1, y: 2, width: 30, height: 40, score: 0.9 }], signature: new Uint8Array(4) }
        },
        dispose: () => {
          detector.disposed += 1
        },
      }
      state.created.push(detector)
      return detector
    },
  },
}))

type Message = { type: string; threads?: number; id?: number }

class FakeWorker {
  static behavior: (worker: FakeWorker, message: Message) => void = () => {}
  static instances: FakeWorker[] = []
  onerror: ((event: { message: string }) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  terminated = false
  readonly inits: number[] = []

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(message: Message): void {
    if (message.type === 'init') this.inits.push(message.threads ?? 0)
    queueMicrotask(() => {
      if (!this.terminated) FakeWorker.behavior(this, message)
    })
  }

  terminate(): void {
    this.terminated = true
  }

  reply(data: unknown): void {
    this.onmessage?.({ data })
  }
}

/** 정상 워커: 준비되면 ready, 검출 요청에는 상자 하나를 돌려준다 */
const healthy = (worker: FakeWorker, message: Message) => {
  if (message.type === 'init') worker.reply({ type: 'ready' })
  else worker.reply({ type: 'result', id: message.id, boxes: [{ x: 5, y: 5, width: 50, height: 60, score: 0.8 }], signature: new Uint8Array(4) })
}

const bitmap = () => {
  const close = vi.fn()
  return { value: { width: 8, height: 8, close } as unknown as ImageBitmap, close }
}

async function loadPool() {
  return import('../src/pipeline/detector-pool')
}

beforeEach(() => {
  vi.resetModules()
  FakeWorker.instances = []
  FakeWorker.behavior = healthy
  state.created.length = 0
  state.failCreate = null
  state.pending = null
  vi.stubGlobal('Worker', FakeWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('검출 워커 묶음', () => {
  it('보통은 검출 워커를 띄워 쓴다(워커가 여럿이면 워커마다 스레드 1개, 하나면 4개)', async () => {
    const { DetectorPool } = await loadPool()
    const pool = await DetectorPool.create(2, 'yunet', 0.5)
    expect(pool.runsInline).toBe(false)
    expect(pool.size).toBe(2)
    expect(FakeWorker.instances.map((worker) => worker.inits)).toEqual([[1], [1]])
    const frame = bitmap()
    const result = await pool.detectFrame(frame.value, [])
    expect(result.boxes).toEqual([{ x: 5, y: 5, width: 50, height: 60, score: 0.8 }])
    pool.dispose()
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true)

    const single = await DetectorPool.create(1, 'yunet', 0.5)
    expect(FakeWorker.instances[2]?.inits).toEqual([4])
    single.dispose()
    expect(state.created).toHaveLength(0)
  })

  it('검출 워커를 띄울 수 없으면(워커 안의 워커를 막는 브라우저) 지금 스레드에서 직접 검출한다', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // 스크립트를 불러오지 못하면 브라우저는 이유 없는 오류 이벤트를 보낸다
    FakeWorker.behavior = (worker) => worker.onerror?.({ message: '' })
    const { DetectorPool } = await loadPool()
    const pool = await DetectorPool.create(4, 'yunet', 0.5)
    expect(pool.runsInline).toBe(true)
    expect(pool.size).toBe(1)
    expect(FakeWorker.instances).toHaveLength(4)
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true)
    // 지금 스레드에서는 ONNX Runtime 도 스레드 1개만 쓴다
    expect(state.created.map((detector) => detector.threads)).toEqual([1])
    expect(warn).toHaveBeenCalledOnce()

    await pool.acquire()
    const frame = bitmap()
    const result = await pool.detectFrame(frame.value, [])
    expect(result.boxes).toEqual([{ x: 1, y: 2, width: 30, height: 40, score: 0.9 }])
    // 넘겨받은 프레임은 검출이 끝나면 닫는다
    expect(frame.close).toHaveBeenCalledOnce()

    // 한 번 겪은 뒤로는 워커를 다시 띄워 보지 않고 바로 지금 스레드에서 검출한다
    const next = await DetectorPool.create(4, 'yunet', 0.5)
    expect(next.runsInline).toBe(true)
    expect(FakeWorker.instances).toHaveLength(4)
    warn.mockRestore()
  })

  it('검출 워커가 여러 스레드로는 준비되지 않으면(내부 워커가 막혀 멈춤) 스레드 1개로 다시 띄운다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    FakeWorker.behavior = (worker, message) => {
      if (message.type === 'init' && (message.threads ?? 1) > 1) return
      healthy(worker, message)
    }
    const { DetectorPool, WORKER_START_TIMEOUT_MS } = await loadPool()
    const creating = DetectorPool.create(1, 'yunet', 0.5)
    await vi.advanceTimersByTimeAsync(WORKER_START_TIMEOUT_MS)
    const pool = await creating
    expect(pool.runsInline).toBe(false)
    expect(FakeWorker.instances.map((worker) => worker.inits)).toEqual([[4], [1]])
    expect(FakeWorker.instances[0]?.terminated).toBe(true)

    // 다음부터는 처음부터 스레드 1개로 띄운다(다시 기다리지 않는다)
    const next = await DetectorPool.create(1, 'yunet', 0.5)
    expect(FakeWorker.instances[2]?.inits).toEqual([1])
    pool.dispose()
    next.dispose()
  })

  it('스레드 1개짜리 워커는 준비가 늦어도 기다린다(느린 컴퓨터를 막힌 환경으로 오판하지 않는다)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    FakeWorker.behavior = (worker, message) => {
      if (message.type === 'init') setTimeout(() => worker.reply({ type: 'ready' }), 45_000)
      else healthy(worker, message)
    }
    const { DetectorPool } = await loadPool()
    let settled = false
    const creating = DetectorPool.create(3, 'yunet', 0.5).then((pool) => {
      settled = true
      return pool
    })
    await vi.advanceTimersByTimeAsync(44_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2_000)
    const pool = await creating
    expect(pool.runsInline).toBe(false)
    expect(pool.size).toBe(3)
    expect(FakeWorker.instances.map((worker) => worker.inits)).toEqual([[1], [1], [1]])
    expect(FakeWorker.instances.some((worker) => worker.terminated)).toBe(false)
    expect(state.created).toHaveLength(0)
    pool.dispose()
  })

  it('워커는 떴지만 모델을 불러오지 못한 경우는 그대로 알린다(지금 스레드에서 해도 같다)', async () => {
    FakeWorker.behavior = (worker, message) => {
      if (message.type === 'init') worker.reply({ type: 'error', id: null, message: '모델 파일을 받지 못했습니다' })
    }
    const { DetectorPool } = await loadPool()
    await expect(DetectorPool.create(2, 'yunet', 0.5)).rejects.toThrow('모델 파일을 받지 못했습니다')
    expect(state.created).toHaveLength(0)
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true)
  })

  it('준비된 뒤에 워커가 죽으면 맡긴 일과 다음 요청이 모두 실패한다', async () => {
    FakeWorker.behavior = (worker, message) => {
      if (message.type === 'init') worker.reply({ type: 'ready' })
      else worker.onerror?.({ message: '메모리 부족' })
    }
    const { DetectorPool } = await loadPool()
    const pool = await DetectorPool.create(1, 'yunet', 0.5)
    await expect(pool.detectFrame(bitmap().value, [])).rejects.toThrow('검출 워커 오류: 메모리 부족')
    await expect(pool.acquire()).rejects.toThrow('메모리 부족')
    expect(state.created).toHaveLength(0)
  })

  it('지금 스레드에서도 검출기를 만들지 못하면 다른 브라우저를 권하는 오류를 낸다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    FakeWorker.behavior = (worker) => worker.onerror?.({ message: '' })
    state.failCreate = new Error('WASM 을 불러오지 못했습니다')
    const { DetectorPool } = await loadPool()
    await expect(DetectorPool.create(2, 'yunet', 0.5)).rejects.toThrow(/WASM 을 불러오지 못했습니다.*크롬·엣지·웨일/)
  })

  it('지금 스레드의 검출기는 진행 중인 검출이 끝난 뒤에 내려놓는다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    FakeWorker.behavior = (worker) => worker.onerror?.({ message: '' })
    const { DetectorPool } = await loadPool()
    const pool = await DetectorPool.create(2, 'yunet', 0.5)
    let finish: () => void = () => {}
    state.pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const frame = bitmap()
    const running = pool.detectFrame(frame.value, [])
    pool.dispose()
    await Promise.resolve()
    expect(state.created[0]?.disposed).toBe(0)
    finish()
    await running
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(state.created[0]?.disposed).toBe(1)
    expect(frame.close).toHaveBeenCalledOnce()
    // 닫은 뒤의 요청은 받지 않는다
    await expect(pool.acquire()).rejects.toThrow('검출을 중단했습니다')
  })
})
