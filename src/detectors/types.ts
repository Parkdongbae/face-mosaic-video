export interface FaceBox {
  x: number
  y: number
  width: number
  height: number
  score: number
  /** 확대(타일) 검출에서만 잡혔고 전체 화면 검출에서는 잡히지 않았으면 true */
  tileOnly?: boolean
}

/** 검출기에 넣을 수 있는 이미지. 둘 다 width/height 를 가진 CanvasImageSource 다. */
export type DetectSource = ImageBitmap | OffscreenCanvas

/** 원본 이미지 안의 일부 영역(타일 검출용), 원본 픽셀 좌표 */
export interface SourceRegion {
  x: number
  y: number
  width: number
  height: number
}

export interface DetectionOutput {
  boxes: FaceBox[]
  /** 이미지 로딩을 뺀, 전처리+추론+후처리 시간(ms) */
  ms: number
}

export type DetectorKind = 'mediapipe' | 'onnx'
export type NormalizationVariant = 'rgb128' | 'bgr128' | 'rgb01' | 'bgrmean' | 'bgr255'
export type AnchorOrder = 'anchor-major' | 'anchor-minor'

export interface OnnxTuning {
  variant?: NormalizationVariant
  anchorOrder?: AnchorOrder
  inputSize?: number
  nmsThreshold?: number
}

export interface DetectorConfig {
  id: string
  label: string
  kind: DetectorKind
  family?: 'yunet' | 'scrfd'
  modelPath: string
  scoreThreshold: number
  color: string
  note: string
}

export interface FaceDetectorAdapter {
  readonly config: DetectorConfig
  /** 모델·런타임 로딩. 프레임 투입 전에 한 번 호출한다. */
  init(): Promise<void>
  /**
   * 입력 이미지(원본 해상도)의 픽셀 좌표로 상자를 돌려준다.
   * region 을 주면 그 부분만 잘라 검출한다(지원하는 검출기만, 좌표는 여전히 원본 기준).
   */
  detect(source: DetectSource, region?: SourceRegion): Promise<DetectionOutput>
  diagnostics?(): DetectorDiagnostics | null
  updateTuning?(tuning: OnnxTuning): void
  dispose(): void
}

export interface DetectorDiagnostics {
  inputNames: string[]
  outputNames: string[]
  inputDims: number[][]
  outputDims: number[][]
}
