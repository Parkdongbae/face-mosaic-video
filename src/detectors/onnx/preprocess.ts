import type { DetectSource, FaceBox, NormalizationVariant, SourceRegion } from '../types'
import { computeLetterbox, type LetterboxTransform } from './letterbox'

export type { NormalizationVariant }

interface VariantSpec {
  rgb: boolean
  offset: [number, number, number]
  scale: number
}

const VARIANTS: Record<NormalizationVariant, VariantSpec> = {
  rgb128: { rgb: true, offset: [127.5, 127.5, 127.5], scale: 1 / 128 },
  bgr128: { rgb: false, offset: [127.5, 127.5, 127.5], scale: 1 / 128 },
  rgb01: { rgb: true, offset: [0, 0, 0], scale: 1 / 255 },
  bgrmean: { rgb: false, offset: [104, 117, 123], scale: 1 },
  // YuNet: OpenCV FaceDetectorYN 은 BGR 0~255 값을 정규화 없이 그대로 넣는다.
  bgr255: { rgb: false, offset: [0, 0, 0], scale: 1 },
}

export interface PreparedInput {
  tensor: Float32Array
  transform: LetterboxTransform
  inputSize: number
}

/**
 * 원본 프레임을 모델 입력 크기 정사각형으로 letterbox 리사이즈하고 NCHW float32로 만든다.
 * 캔버스는 호출 쪽에서 재사용한다.
 */
export function prepareInput(
  source: DetectSource,
  inputSize: number,
  variant: NormalizationVariant,
  canvas: OffscreenCanvas,
  region?: SourceRegion,
): PreparedInput {
  const area = region ?? { x: 0, y: 0, width: source.width, height: source.height }
  const transform = computeLetterbox(area.width, area.height, inputSize, inputSize)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('OffscreenCanvas 2D 컨텍스트를 만들지 못했습니다')

  context.fillStyle = '#000'
  context.fillRect(0, 0, inputSize, inputSize)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    source,
    area.x,
    area.y,
    area.width,
    area.height,
    transform.padX,
    transform.padY,
    area.width * transform.scale,
    area.height * transform.scale,
  )

  const pixels = context.getImageData(0, 0, inputSize, inputSize).data
  const spec = VARIANTS[variant]
  const plane = inputSize * inputSize
  const tensor = new Float32Array(plane * 3)
  for (let i = 0; i < plane; i += 1) {
    const red = pixels[i * 4] ?? 0
    const green = pixels[i * 4 + 1] ?? 0
    const blue = pixels[i * 4 + 2] ?? 0
    const first = (spec.rgb ? red : blue) - spec.offset[0]
    const second = green - spec.offset[1]
    const third = (spec.rgb ? blue : red) - spec.offset[2]
    tensor[i] = first * spec.scale
    tensor[plane + i] = second * spec.scale
    tensor[plane * 2 + i] = third * spec.scale
  }
  return { tensor, transform, inputSize }
}

/**
 * 모델 입력 좌표의 상자를 원본 좌표로 되돌리고 원본 이미지 밖은 잘라 낸다.
 * offsetX/offsetY 는 잘라 낸 영역(타일)이 원본에서 시작하는 위치다.
 *
 * 타일 경계에서는 자르지 않는다. 타일 가장자리에 걸린 얼굴은 모델이 타일 밖까지 이어지는 상자를 내놓는데,
 * 타일에 맞춰 자르면 얼굴의 절반만 덮는 좁은 상자가 되고, 그 상자가 점수가 높으면 이웃 타일이 잡은
 * 온전한 상자를 밀어내 가림이 얼굴보다 좁아진다(실제 교실 영상에서 확인).
 */
export function mapBoxesToSource(
  boxes: FaceBox[],
  transform: LetterboxTransform,
  sourceWidth: number,
  sourceHeight: number,
  offsetX = 0,
  offsetY = 0,
): FaceBox[] {
  const result: FaceBox[] = []
  for (const box of boxes) {
    const x = (box.x - transform.padX) / transform.scale + offsetX
    const y = (box.y - transform.padY) / transform.scale + offsetY
    const w = box.width / transform.scale
    const h = box.height / transform.scale
    const left = Math.max(0, x)
    const top = Math.max(0, y)
    const right = Math.min(sourceWidth, x + w)
    const bottom = Math.min(sourceHeight, y + h)
    if (right - left < 2 || bottom - top < 2) continue
    result.push({ x: left, y: top, width: right - left, height: bottom - top, score: box.score })
  }
  return result
}
