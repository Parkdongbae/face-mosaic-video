// 프레임 한 장에서 얼굴을 찾는다(전체 화면 + 타일). 장면 전환을 찾는 데 쓰는 작은 흑백 그림도 함께 만든다.
// 보통은 검출 워커(detect-worker.ts) 안에서 쓰고, 검출 워커를 띄울 수 없는 환경에서는 검출 워커 묶음(detector-pool.ts)이
// 지금 스레드에서 직접 쓴다. 어느 쪽이든 같은 코드로 같은 결과를 낸다.
import { MOSAIC_DEFAULTS } from '../config/mosaic-defaults'
import { SCENE_SIGNATURE } from '../core/scene'
import { limitOrtThreads } from '../detectors/onnx/ort-env'
import { createDetector, findDetectorConfig } from '../detectors/registry'
import type { FaceBox, FaceDetectorAdapter, SourceRegion } from '../detectors/types'
import { iou, nms } from '../harness/metrics'

/** 프레임 한 장의 검출 결과 */
export interface FrameDetection {
  boxes: FaceBox[]
  /** 장면 전환을 찾는 데 쓰는 아주 작은 흑백 그림(core/scene.ts) */
  signature: Uint8Array
}

/** 타일 검출이 전체 화면 검출과 이만큼 겹치면 같은 얼굴이 양쪽에서 잡힌 것으로 본다 */
const TILE_CONFIRM_IOU = 0.3

export class FrameDetector {
  private readonly detector: FaceDetectorAdapter
  private frameCanvas: OffscreenCanvas | null = null
  private frameContext: OffscreenCanvasRenderingContext2D | null = null
  private signatureCanvas: OffscreenCanvas | null = null

  private constructor(detector: FaceDetectorAdapter) {
    this.detector = detector
  }

  /**
   * 검출기를 만들고 모델을 불러온다.
   * threads: ONNX Runtime 이 쓸 스레드 수 상한. 2 이상이면 ONNX Runtime 이 안에서 워커를 더 띄운다.
   */
  static async create(detectorId: string, scoreThreshold: number, threads: number): Promise<FrameDetector> {
    limitOrtThreads(threads)
    const detector = createDetector({ ...findDetectorConfig(detectorId), scoreThreshold })
    await detector.init()
    return new FrameDetector(detector)
  }

  /** 전체 화면과 주어진 타일에서 얼굴을 찾는다. bitmap 은 닫지 않는다(부른 쪽이 닫는다). */
  async detect(bitmap: ImageBitmap, tiles: SourceRegion[]): Promise<FrameDetection> {
    // 넘겨받은 프레임은 그래픽 메모리에 있을 수 있다. 타일마다 다시 읽어 오지 않도록 한 번만 일반 캔버스로 옮긴다.
    if (!this.frameCanvas || this.frameCanvas.width !== bitmap.width || this.frameCanvas.height !== bitmap.height) {
      this.frameCanvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      this.frameContext = this.frameCanvas.getContext('2d', { alpha: false, willReadFrequently: true })
    }
    const frameCanvas = this.frameCanvas
    if (!this.frameContext) throw new Error('검출용 캔버스를 만들지 못했습니다')
    this.frameContext.drawImage(bitmap, 0, 0)
    const signature = this.sceneSignature(frameCanvas)
    const full: FaceBox[] = [...(await this.detector.detect(frameCanvas)).boxes]
    if (tiles.length === 0) return { boxes: full, signature }

    const fromTiles: FaceBox[] = []
    const limit = MOSAIC_DEFAULTS.tileMaxBoxRatio
    for (const tile of tiles) {
      for (const box of (await this.detector.detect(frameCanvas, tile)).boxes) {
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
    return { boxes: nms([...full, ...fromTiles], MOSAIC_DEFAULTS.mergeIou), signature }
  }

  /** 모델을 내려놓는다. 진행 중인 detect() 가 끝난 뒤에 불러야 한다. */
  dispose(): void {
    this.detector.dispose()
  }

  /** 프레임을 아주 작은 흑백 그림으로 줄인다(장면이 바뀌었는지 견주는 용도). */
  private sceneSignature(frame: OffscreenCanvas): Uint8Array {
    const { width, height } = SCENE_SIGNATURE
    this.signatureCanvas ??= new OffscreenCanvas(width, height)
    const context = this.signatureCanvas.getContext('2d', { alpha: false, willReadFrequently: true })
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
}
