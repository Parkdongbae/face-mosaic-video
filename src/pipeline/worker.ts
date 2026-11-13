/// <reference lib="webworker" />
// 영상 처리 전용 워커. 화면이 멈추지 않도록 해독·검출·압축·분할을 모두 여기서 한다.
// 영상 데이터는 이 워커와 화면 사이에서만 오가며 네트워크로 나가지 않는다.
import { analyzeVideo } from './analyze'
import { renderVideo } from './render'
import { trackManualBox } from './manual-track'
import { buildKeyFrameIndex, splitVideo } from './split'
import { JobCanceledError, type ProgressInfo, type WorkerRequest, type WorkerResponse } from './types'

declare const self: DedicatedWorkerGlobalScope

let controller: AbortController | null = null

function post(message: WorkerResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer)
}

async function handle(request: WorkerRequest): Promise<void> {
  if (request.type === 'cancel') {
    controller?.abort()
    return
  }
  if (controller) {
    post({ type: 'error', message: '이미 처리 중인 작업이 있습니다.', canceled: false })
    return
  }
  controller = new AbortController()
  const hooks = {
    signal: controller.signal,
    onProgress: (progress: ProgressInfo) => post({ type: 'progress', progress }),
  }
  try {
    if (request.type === 'analyze') {
      const analysis = await analyzeVideo(request.file, request.settings, hooks)
      post({ type: 'analyzed', analysis })
    } else if (request.type === 'keyframes') {
      post({ type: 'keyframes', index: await buildKeyFrameIndex(request.file, hooks) })
    } else if (request.type === 'split') {
      const results = await splitVideo(request.file, request.pieces, request.handles, hooks)
      const buffers = results.map((item) => item.buffer)
      post(
        {
          type: 'split',
          pieces: results.map(({ index, videoPackets, audioPackets, bytes }) => ({ index, videoPackets, audioPackets, bytes })),
          buffers,
        },
        buffers.filter((item): item is ArrayBuffer => item !== null),
      )
    } else if (request.type === 'track') {
      const points = await trackManualBox(request.file, { timeUs: request.timeUs, box: request.box, spanSec: request.spanSec }, hooks)
      post({ type: 'tracked', points })
    } else {
      const writable = request.handle ? await request.handle.createWritable() : null
      const result = await renderVideo(request.file, request.analysis, request.settings, writable, hooks, request.range, request.edits)
      post({ type: 'rendered', stats: result.stats, buffer: result.buffer }, result.buffer ? [result.buffer] : [])
    }
  } catch (error) {
    const canceled = error instanceof JobCanceledError
    post({ type: 'error', message: error instanceof Error ? error.message : String(error), canceled })
  } finally {
    controller = null
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void handle(event.data)
}
