import { describe, expect, it } from 'vitest'
import { computeLetterbox, toModelBox, toSourceBox } from '../src/detectors/onnx/letterbox'
import { mapBoxesToSource } from '../src/detectors/onnx/preprocess'

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

describe('모델 좌표의 상자를 원본 좌표로 되돌리기', () => {
  // 1920x1080 화면의 타일(x 732~1189, y 332~748)을 640x640 입력에 맞춘 경우
  const tile = { x: 732, y: 332, width: 457, height: 416 }
  const transform = computeLetterbox(tile.width, tile.height, 640, 640)

  it('타일 안의 상자는 타일 위치만큼 옮겨진다', () => {
    const inside = toModelBox({ x: 100, y: 100, width: 80, height: 100, score: 0.9 }, transform)
    const [box] = mapBoxesToSource([inside], transform, 1920, 1080, tile.x, tile.y)
    expect(box!.x).toBeCloseTo(832)
    expect(box!.y).toBeCloseTo(432)
    expect(box!.width).toBeCloseTo(80)
    expect(box!.height).toBeCloseTo(100)
  })

  it('타일 가장자리에 걸린 얼굴의 상자는 타일 경계에서 자르지 않는다(얼굴 절반만 가리지 않도록)', () => {
    // 타일 왼쪽 경계 밖으로 45px 나간 폭 100px 상자
    const straddling = toModelBox({ x: -45, y: 280, width: 100, height: 110, score: 0.76 }, transform)
    const [box] = mapBoxesToSource([straddling], transform, 1920, 1080, tile.x, tile.y)
    expect(box!.x).toBeCloseTo(687)
    expect(box!.width).toBeCloseTo(100)
  })

  it('원본 화면 밖으로 나간 부분은 잘라 낸다', () => {
    const edgeTile = { x: 1463, y: 0 }
    const outside = toModelBox({ x: 400, y: -30, width: 120, height: 150, score: 0.8 }, transform)
    const [box] = mapBoxesToSource([outside], transform, 1920, 1080, edgeTile.x, edgeTile.y)
    expect(box!.x).toBeCloseTo(1863)
    expect(box!.y).toBe(0)
    expect(box!.x + box!.width).toBe(1920)
    expect(box!.height).toBeCloseTo(120)
  })

  it('화면 안에 남는 부분이 거의 없는 상자는 버린다', () => {
    const gone = toModelBox({ x: -200, y: -200, width: 100, height: 100, score: 0.8 }, transform)
    expect(mapBoxesToSource([gone], transform, 1920, 1080, 0, 0)).toEqual([])
  })
})
