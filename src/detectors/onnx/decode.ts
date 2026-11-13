import type * as ort from 'onnxruntime-web'
import type { AnchorOrder, FaceBox, OnnxTuning } from '../types'

export type { AnchorOrder, OnnxTuning }

interface TensorLike {
  data: ArrayLike<number>
  dims: readonly number[]
}

export function readTensor(outputs: Record<string, ort.Tensor>, name: string): TensorLike {
  const tensor = outputs[name]
  if (!tensor) throw new Error(`출력 텐서 ${name} 를 찾지 못했습니다`)
  return { data: tensor.data as ArrayLike<number>, dims: tensor.dims }
}

/**
 * 출력 이름이 `<접두어>_<stride>` 꼴인 텐서를 stride 별로 묶는다.
 * 실제 모델에서 확인한 이름: YuNet = cls_8 / obj_8 / bbox_8, SCRFD(gnkps export) = score_8 / box_8.
 */
function strideGroups(
  outputs: Record<string, ort.Tensor>,
  scorePrefix: string,
  boxPrefix: string,
): Map<number, { scores: TensorLike; boxes: TensorLike }> {
  const completed = new Map<number, { scores: TensorLike; boxes: TensorLike }>()
  const pattern = new RegExp(`^${scorePrefix}_(\\d+)$`)
  for (const name of Object.keys(outputs)) {
    const match = pattern.exec(name)
    if (!match) continue
    const stride = Number(match[1])
    const boxName = `${boxPrefix}_${stride}`
    if (!outputs[boxName]) continue
    completed.set(stride, { scores: readTensor(outputs, name), boxes: readTensor(outputs, boxName) })
  }
  return completed
}

/** 점수 텐서가 로짓이면 시그모이드를 적용한다(모델 export 방식이 달라질 수 있음). */
function toProbabilities(scores: TensorLike): Float32Array {
  const out = new Float32Array(scores.data.length)
  let max = 0
  for (let i = 0; i < scores.data.length; i += 1) max = Math.max(max, scores.data[i] ?? 0)
  const needsSigmoid = max > 1.5
  for (let i = 0; i < scores.data.length; i += 1) {
    const value = scores.data[i] ?? 0
    out[i] = needsSigmoid ? 1 / (1 + Math.exp(-value)) : value
  }
  return out
}

function cellOf(index: number, anchors: number, featWidth: number, anchorOrder: AnchorOrder): { col: number; row: number } {
  if (anchorOrder === 'anchor-minor') {
    const col = Math.floor(index / anchors) % featWidth
    const row = Math.floor(index / (anchors * featWidth))
    return { col, row }
  }
  const cell = index % (featWidth * featWidth)
  return { col: cell % featWidth, row: Math.floor(cell / featWidth) }
}

export interface YunetDecodeOptions {
  inputSize: number
  scoreThreshold: number
  anchorOrder: AnchorOrder
}

/** YuNet(2023mar) 디코딩: 점수 = sqrt(cls*obj) (OpenCV FaceDetectorYN 과 같은 방식), bbox = (dx, dy, exp(w), exp(h)) * stride */
export function decodeYunet(outputs: Record<string, ort.Tensor>, options: YunetDecodeOptions): FaceBox[] {
  const boxes: FaceBox[] = []
  const groups = strideGroups(outputs, 'cls', 'bbox')
  for (const [stride, { scores, boxes: bbox }] of groups) {
    const objectness = outputs[`obj_${stride}`]
    if (!objectness) continue
    const objectnessTensor = readTensor(outputs, `obj_${stride}`)
    const probabilities = toProbabilities(scores)
    const objectnessProbabilities = toProbabilities(objectnessTensor)
    const count = Math.min(probabilities.length, objectnessProbabilities.length)
    const featWidth = Math.ceil(options.inputSize / stride)
    const anchors = Math.max(1, Math.round(count / (featWidth * featWidth)))
    for (let i = 0; i < count; i += 1) {
      const score = Math.sqrt(Math.min(1, Math.max(0, probabilities[i] ?? 0)) * Math.min(1, Math.max(0, objectnessProbabilities[i] ?? 0)))
      if (score < options.scoreThreshold) continue
      const { col, row } = cellOf(i, anchors, featWidth, options.anchorOrder)
      const centerX = ((bbox.data[i * 4] ?? 0) + col) * stride
      const centerY = ((bbox.data[i * 4 + 1] ?? 0) + row) * stride
      const width = Math.exp(bbox.data[i * 4 + 2] ?? 0) * stride
      const height = Math.exp(bbox.data[i * 4 + 3] ?? 0) * stride
      if (!Number.isFinite(width) || !Number.isFinite(height)) continue
      boxes.push({
        x: centerX - width / 2,
        y: centerY - height / 2,
        width,
        height,
        score,
      })
    }
  }
  return boxes
}

/**
 * SCRFD 디코딩: bbox = 앵커 중심에서 (왼쪽, 위, 오른쪽, 아래)까지의 거리.
 * 이 저장소의 gnkps export(box_8/16/32)는 거리에 stride 가 이미 곱해져 입력 픽셀 단위로 나온다
 * (시험 프레임에서 YuNet·MediaPipe 상자와 대조해 확인). 앵커 중심은 InsightFace 구현과 같이 (col, row) * stride.
 */
export function decodeScrfd(outputs: Record<string, ort.Tensor>, options: YunetDecodeOptions): FaceBox[] {
  const boxes: FaceBox[] = []
  const groups = strideGroups(outputs, 'score', 'box')
  for (const [stride, { scores, boxes: bbox }] of groups) {
    const probabilities = toProbabilities(scores)
    const featWidth = Math.ceil(options.inputSize / stride)
    const anchors = Math.max(1, Math.round(probabilities.length / (featWidth * featWidth)))
    for (let i = 0; i < probabilities.length; i += 1) {
      const score = probabilities[i] ?? 0
      if (score < options.scoreThreshold) continue
      const { col, row } = cellOf(i, anchors, featWidth, options.anchorOrder)
      const centerX = col * stride
      const centerY = row * stride
      const left = bbox.data[i * 4] ?? 0
      const top = bbox.data[i * 4 + 1] ?? 0
      const right = bbox.data[i * 4 + 2] ?? 0
      const bottom = bbox.data[i * 4 + 3] ?? 0
      boxes.push({
        x: centerX - left,
        y: centerY - top,
        width: left + right,
        height: top + bottom,
        score,
      })
    }
  }
  return boxes
}

export type OnnxModelFamily = 'yunet' | 'scrfd'
