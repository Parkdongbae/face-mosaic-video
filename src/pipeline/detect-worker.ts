/// <reference lib="webworker" />
// 얼굴 검출 전용 워커. 분석 워커가 프레임을 한 장씩 넘기면 상자만 돌려준다.
// 받은 프레임은 검출이 끝나는 즉시 닫는다(모아 두지 않는다).
import { MOSAIC_DEFAULTS } from '../config/mosaic-defaults'
import { SCENE_SIGNATURE } from '../core/scene'
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
  | { type: 'result'; id: number; boxes: FaceBox[]; /** 장면 전환을 찾는 데 쓰는 아주 작은 흑백 그림(core/scene.ts) */ signature: Uint8Array }
  | { type: 'error'; id: number | null; message: string }

/** 타일 검출이 전체 화면 검출과 이만큼 겹치면 같은 얼굴이 양쪽에서 잡힌 것으로 본다 */
const TILE_CONFIRM_IOU = 0.3

let detector: FaceDetectorAdapter | null = null
let frameCanvas: OffscreenCanvas | null = null
let frameContext: OffscreenCanvasRenderingContext2D | null = null
let signatureCanvas: OffscreenCanvas | null = null

/** 프레임을 아주 작은 흑백 그림으로 줄인다(장면이 바뀌었는지 견주는 용도). */
function sceneSignature(frame: OffscreenCanvas): Uint8Array {
  const { width, height } = SCENE_SIGNATURE
  signatureCanvas ??= new OffscreenCanvas(width, height)
  const context = signatureCanvas.getContext('2d', { alpha: false, willReadFrequently: true })
  const signature = new Uint8Array(width * height)
  if (!context) return signature
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'medium'
  context.drawImage(frame, 0, 0, width, height)
  const pixels = context.getImageData(0, 0, width, height).data
  for (let i = 0; i < signature.length; i += 1) {
    signature[i] = ((pixels[i * 4] ?? 0) * 77 + (pixels[i * 4 + 1] ?? 0) * 150 + (pixels[i * 4 + 2] ?? 0) * 29) >> 8
  }
  return signature
}

function post(message: DetectResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, transfer)
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
    const signature = sceneSignature(frameCanvas)
    const full: FaceBox[] = [...(await detector.detect(frameCanvas)).boxes]
    if (tiles.length === 0) {
      post({ type: 'result', id, boxes: full, signature }, [signature.buffer])
      return
    }
    const fromTiles: FaceBox[] = []
    const limit = MOSAIC_DEFAULTS.tileMaxBoxRatio
    for (const tile of tiles) {
      for (const box of (await detector.detect(frameCanvas, tile)).boxes) {
        // 타일을 거의 다 채우는 상자는 버린다. 그만큼 큰 얼굴은 전체 화면 검출이 맡고,
        // 타일에서는 가장자리에 잘린 헛검출(책상·옷을 화면 가득한 얼굴로 본 것)이 대부분이다.
        if (box.width >= tile.width * limit || box.height >= tile.height * limit) continue
        fromTiles.push(box)
      }
    }
    // 전체 화면 검출과 겹치지 않는 타일 검출에는 표시를 남긴다(오검출 거르기에서 쓴다).
    for (const box of fromTiles) {
      if (full.every((other) => iou(box, other) < TILE_CONFIRM_IOU)) box.tileOnly = true
    }
    post({ type: 'result', id, boxes: nms([...full, ...fromTiles], MOSAIC_DEFAULTS.mergeIou), signature }, [signature.buffer])
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
