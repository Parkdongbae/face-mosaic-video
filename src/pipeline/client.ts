import type { Rect } from '../core/geometry'
import { NO_EDITS, type Edits } from '../core/mask-plan'
import type { KeyFrameIndex, SplitPiece } from '../core/split-plan'
import {
  JobCanceledError,
  type AnalysisResult,
  type JobSettings,
  type ProgressInfo,
  type RenderStats,
  type SplitPieceSummary,
  type TimeRange,
  type WorkerRequest,
  type WorkerResponse,
} from './types'

export interface RenderResult {
  stats: RenderStats
  buffer: ArrayBuffer | null
}

export interface SplitResult {
  pieces: SplitPieceSummary[]
  buffers: Array<ArrayBuffer | null>
}

type Done = Exclude<WorkerResponse, { type: 'progress' } | { type: 'error' }>
type ProgressListener = (progress: ProgressInfo) => void

interface Pending {
  expect: Done['type']
  resolve: (value: Done) => void
  reject: (error: Error) => void
}

/** 처리 워커와 주고받는 창구. 한 번에 한 작업만 실행한다. */
export class MosaicClient {
  private readonly worker: Worker
  private pending: Pending | null = null
  private onProgress: ProgressListener | null = null

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.receive(event.data)
    this.worker.onerror = (event) => {
      this.fail(new Error(`처리 중 오류가 났습니다: ${event.message || '알 수 없는 오류'}`))
    }
  }

  get busy(): boolean {
    return this.pending !== null
  }

  async analyze(file: Blob, settings: JobSettings, onProgress?: ProgressListener): Promise<AnalysisResult> {
    const done = await this.run({ type: 'analyze', file, settings }, 'analyzed', onProgress)
    if (done.type !== 'analyzed') throw new Error('처리 결과의 종류가 요청과 맞지 않습니다.')
    return done.analysis
  }

  async render(
    file: Blob,
    analysis: AnalysisResult,
    settings: JobSettings,
    handle: FileSystemFileHandle | null,
    onProgress?: ProgressListener,
    range: TimeRange | null = null,
    edits: Edits = NO_EDITS,
  ): Promise<RenderResult> {
    const done = await this.run({ type: 'render', file, analysis, settings, handle, range, edits }, 'rendered', onProgress)
    if (done.type !== 'rendered') throw new Error('처리 결과의 종류가 요청과 맞지 않습니다.')
    return { stats: done.stats, buffer: done.buffer }
  }

  /** 사용자가 표시한 얼굴을 앞뒤 프레임으로 따라가 상자 목록을 돌려준다(F-11). */
  async trackFace(
    file: Blob,
    timeUs: number,
    box: Rect,
    spanSec: number,
    onProgress?: ProgressListener,
  ): Promise<Array<{ timeUs: number; box: Rect }>> {
    const done = await this.run({ type: 'track', file, timeUs, box, spanSec }, 'tracked', onProgress)
    if (done.type !== 'tracked') throw new Error('처리 결과의 종류가 요청과 맞지 않습니다.')
    return done.points
  }

  /** 키프레임 위치와 누적 용량을 읽는다(분할 계획용). */
  async keyFrames(file: Blob): Promise<KeyFrameIndex> {
    const done = await this.run({ type: 'keyframes', file }, 'keyframes')
    if (done.type !== 'keyframes') throw new Error('처리 결과의 종류가 요청과 맞지 않습니다.')
    return done.index
  }

  /** 재압축 없이 조각으로 나눠 저장한다. */
  async split(
    file: Blob,
    pieces: SplitPiece[],
    handles: Array<FileSystemFileHandle | null>,
    onProgress?: ProgressListener,
  ): Promise<SplitResult> {
    const done = await this.run({ type: 'split', file, pieces, handles }, 'split', onProgress)
    if (done.type !== 'split') throw new Error('처리 결과의 종류가 요청과 맞지 않습니다.')
    return { pieces: done.pieces, buffers: done.buffers }
  }

  cancel(): void {
    if (this.pending) this.send({ type: 'cancel' })
  }

  dispose(): void {
    this.worker.terminate()
    this.fail(new JobCanceledError())
  }

  private run(request: WorkerRequest, expect: Done['type'], onProgress?: ProgressListener): Promise<Done> {
    return new Promise((resolve, reject) => {
      if (this.pending) {
        reject(new Error('이미 처리 중인 작업이 있습니다.'))
        return
      }
      this.pending = { expect, resolve, reject }
      this.onProgress = onProgress ?? null
      this.send(request)
    })
  }

  private send(request: WorkerRequest): void {
    this.worker.postMessage(request)
  }

  private fail(error: Error): void {
    const pending = this.pending
    this.pending = null
    this.onProgress = null
    pending?.reject(error)
  }

  private receive(message: WorkerResponse): void {
    if (message.type === 'progress') {
      this.onProgress?.(message.progress)
      return
    }
    const pending = this.pending
    if (!pending) return
    if (message.type === 'error') {
      this.fail(message.canceled ? new JobCanceledError() : new Error(message.message))
      return
    }
    this.pending = null
    this.onProgress = null
    if (message.type === pending.expect) pending.resolve(message)
    else pending.reject(new Error('처리 결과의 종류가 요청과 맞지 않습니다.'))
  }
}
