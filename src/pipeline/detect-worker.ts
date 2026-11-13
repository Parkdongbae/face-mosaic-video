/// <reference lib="webworker" />
// 얼굴 검출 전용 워커. 분석 워커가 프레임을 한 장씩 넘기면 상자만 돌려준다.
// 받은 프레임은 검출이 끝나는 즉시 닫는다(모아 두지 않는다).
import { MOSAIC_DEFAULTS } from '../config/mosaic-defaults'
import { limitOrtThreads } from '../detectors/onnx/ort-env'
import { createDetector, findDetectorConfig } from '../detectors/registry'
import type { FaceBox, FaceDetectorAdapter, SourceRegion } from '../detectors/types'
import { iou, nms } from '../harness/metrics'

declare const self: DedicatedWorkerGlobalScope

export type DetectRequest =
  | { type: 'init'; detectorId: string; scoreThreshold: number; threads: number }
  | { type: 'detect'; id: number; bitmap: ImageBitmap; tiles: SourceRegion[] }

export type DetectResponse =
  | { type: 'ready' }
  | { type: 'result'; id: number; boxes: FaceBox[] }
  | { type: 'error'; id: number | null; message: string }

/** 타일 검출이 전체 화면 검출과 이만큼 겹치면 같은 얼굴이 양쪽에서 잡힌 것으로 본다 */
const TILE_CONFIRM_IOU = 0.3

let detector: FaceDetectorAdapter | null = null
let frameCanvas: OffscreenCanvas | null = null
let frameContext: OffscreenCanvasRenderingContext2D | null = null

function post(message: DetectResponse): void {
  self.postMessage(message)
}

async function handle(request: DetectRequest): Promise<void> {
  if (request.type === 'init') {
    try {
      limitOrtThreads(request.threads)
      detector = createDetector({ ...findDetectorConfig(request.detectorId), scoreThreshold: request.scoreThreshold })
      await detector.init()
      post({ type: 'ready' })
    } catch (error) {
      post({ type: 'error', id: null, message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  const { id, bitmap, tiles } = request
  try {
    if (!detector) throw new Error('검출기가 준비되지 않았습니다')
    // 넘겨받은 프레임은 그래픽 메모리에 있을 수 있다. 타일마다 다시 읽어 오지 않도록 한 번만 일반 캔버스로 옮긴다.
    if (!frameCanvas || frameCanvas.width !== bitmap.width || frameCanvas.height !== bitmap.height) {
      frameCanvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      frameContext = frameCanvas.getContext('2d', { alpha: false, willReadFrequently: true })
    }
    if (!frameContext) throw new Error('검출용 캔버스를 만들지 못했습니다')
    frameContext.drawImage(bitmap, 0, 0)
    const full: FaceBox[] = [...(await detector.detect(frameCanvas)).boxes]
    if (tiles.length === 0) {
      post({ type: 'result', id, boxes: full })
      return
    }
    const fromTiles: FaceBox[] = []
    for (const tile of tiles) fromTiles.push(...(await detector.detect(frameCanvas, tile)).boxes)
    // 전체 화면 검출과 겹치지 않는 타일 검출에는 표시를 남긴다(오검출 거르기에서 쓴다).
    for (const box of fromTiles) {
      if (full.every((other) => iou(box, other) < TILE_CONFIRM_IOU)) box.tileOnly = true
    }
    post({ type: 'result', id, boxes: nms([...full, ...fromTiles], MOSAIC_DEFAULTS.mergeIou) })
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
