import { describe, expect, it } from 'vitest'
import { computeLetterbox, toModelBox, toSourceBox } from '../src/detectors/onnx/letterbox'

describe('computeLetterbox', () => {
  it('가로 영상은 위아래에 여백이 생긴다', () => {
    const transform = computeLetterbox(1920, 1080, 640, 640)
    expect(transform.scale).toBeCloseTo(1 / 3)
    expect(transform.padX).toBeCloseTo(0)
    expect(transform.padY).toBeCloseTo(140)
  })

  it('세로 영상은 좌우에 여백이 생긴다', () => {
    const transform = computeLetterbox(1080, 1920, 640, 640)
    expect(transform.padX).toBeCloseTo(140)
    expect(transform.padY).toBeCloseTo(0)
  })
})

describe('좌표 왕복', () => {
  it('원본 -> 모델 -> 원본이 같아야 한다', () => {
    const transform = computeLetterbox(1920, 1080, 640, 640)
    const original = { x: 800, y: 200, width: 120, height: 160, score: 0.9 }
    const modelSpace = toModelBox(original, transform)
    expect(modelSpace.x).toBeCloseTo(800 / 3)
    expect(modelSpace.y).toBeCloseTo(200 / 3 + 140)
    const restored = toSourceBox(modelSpace, transform)
    expect(restored.x).toBeCloseTo(original.x)
    expect(restored.y).toBeCloseTo(original.y)
    expect(restored.width).toBeCloseTo(original.width)
    expect(restored.height).toBeCloseTo(original.height)
  })
})
