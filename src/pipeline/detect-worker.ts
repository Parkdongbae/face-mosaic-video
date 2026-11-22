/// <reference lib="webworker" />
// 얼굴 검출 전용 워커. 분석 워커가 프레임을 한 장씩 넘기면 상자만 돌려준다.
// 받은 프레임은 검출이 끝나는 즉시 닫는다(모아 두지 않는다). 검출 자체는 frame-detect.ts 가 한다.
import type { FaceBox, SourceRegion } from '../detectors/types'
import { FrameDetector } from './frame-detect'

declare const self: DedicatedWorkerGlobalScope

export type DetectRequest =
  | { type: 'init'; detectorId: string; scoreThreshold: number; threads: number }
  | { type: 'detect'; id: number; bitmap: ImageBitmap; tiles: SourceRegion[] }

export type DetectResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; boxes: FaceBox[]; /** 장면 전환을 찾는 데 쓰는 아주 작은 흑백 그림(core/scene.ts) */ signature: Uint8Array }
  | { type: 'error'; id: number | null; message: string }

let detector: FrameDetector | null = null

function post(message: DetectResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer)
}

async function handle(request: DetectRequest): Promise<void> {
  if (request.type === 'init') {
    try {
      detector = await FrameDetector.create(request.detectorId, request.scoreThreshold, request.threads)
      post({ type: 'ready' })
    } catch (error) {
      post({ type: 'error', id: null, message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  const { id, bitmap, tiles } = request
  try {
    if (!detector) throw new Error('검출기가 준비되지 않았습니다')
    const { boxes, signature } = await detector.detect(bitmap, tiles)
    post({ type: 'result', id, boxes, signature }, [signature.buffer])
  } catch (error) {
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    bitmap.close()
  }
}

// 요청을 받은 순서대로 하나씩 처리한다.
let chain: Promise<void> = Promise.resolve()
self.onmessage = (event: MessageEvent<DetectRequest>) => {
  chain = chain.then(() => handle(event.data))
}
