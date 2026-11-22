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
  /** 처리하지 못한 오류로 워커가 더 일할 수 없다(내부 워커 실패·메모리 부족 등). detail 은 기록용. */
  | { type: 'crash'; message: string; detail: string }

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

// 처리하지 못한 오류(ONNX Runtime 이 안에서 띄운 워커의 실패, WASM 메모리 부족 등)는 이유가 비어 부모에 닿기 쉽다.
// 여기서 잡아 아는 만큼 자세히 알린다.
self.addEventListener('error', (event) => {
  event.preventDefault()
  const where = event.filename ? ` @ ${event.filename}:${event.lineno}:${event.colno}` : ''
  const stack = event.error instanceof Error && event.error.stack ? `\n${event.error.stack}` : ''
  post({ type: 'crash', message: event.message || String(event.error ?? ''), detail: `error${where}${stack}` })
})
self.addEventListener('unhandledrejection', (event) => {
  event.preventDefault()
  const reason: unknown = event.reason
  const message = reason instanceof Error ? reason.message : String(reason)
  post({ type: 'crash', message, detail: `unhandledrejection${reason instanceof Error && reason.stack ? `\n${reason.stack}` : ''}` })
})

// 요청을 받은 순서대로 하나씩 처리한다.
let chain: Promise<void> = Promise.resolve()
self.onmessage = (event: MessageEvent<DetectRequest>) => {
  chain = chain.then(() => handle(event.data))
}
