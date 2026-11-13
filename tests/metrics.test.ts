import { describe, expect, it } from 'vitest'
import { clampBox, iou, matchBoxes, nms } from '../src/harness/metrics'
import type { FaceBox } from '../src/detectors/types'

const box = (x: number, y: number, width: number, height: number, score = 0.9): FaceBox => ({
  x,
  y,
  width,
  height,
  score,
})

describe('iou', () => {
  it('같은 상자는 1', () => {
    expect(iou(box(10, 10, 20, 20), box(10, 10, 20, 20))).toBeCloseTo(1)
  })

  it('떨어진 상자는 0', () => {
    expect(iou(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBe(0)
  })

  it('절반 겹치면 1/3', () => {
    expect(iou(box(0, 0, 10, 10), box(5, 0, 10, 10))).toBeCloseTo(50 / 150)
  })
})

describe('matchBoxes', () => {
  it('겹치는 한 쌍을 매칭하고 나머지는 초과로 센다', () => {
    const result = matchBoxes([box(0, 0, 10, 10), box(50, 50, 10, 10)], [box(1, 1, 10, 10)], 0.5)
    expect(result.matched).toBe(1)
    expect(result.missed).toBe(0)
    expect(result.extra).toBe(1)
  })

  it('정답 두 개를 모두 놓치면 missed=2', () => {
    const result = matchBoxes([], [box(0, 0, 10, 10), box(40, 40, 10, 10)], 0.5)
    expect(result.missed).toBe(2)
    expect(result.matched).toBe(0)
  })

  it('한 예측이 두 정답과 겹쳐도 한 번만 매칭한다', () => {
    const result = matchBoxes([box(0, 0, 10, 10)], [box(0, 0, 10, 10), box(1, 0, 10, 10)], 0.5)
    expect(result.matched).toBe(1)
    expect(result.missed).toBe(1)
  })
})

describe('nms', () => {
  it('겹치는 낮은 점수 상자를 버린다', () => {
    const kept = nms([box(0, 0, 10, 10, 0.4), box(1, 0, 10, 10, 0.95), box(60, 60, 10, 10, 0.8)], 0.5)
    expect(kept).toHaveLength(2)
    expect(kept[0]?.score).toBe(0.95)
  })

  it('임계값 아래 겹침은 모두 남긴다', () => {
    const kept = nms([box(0, 0, 10, 10, 0.9), box(8, 0, 10, 10, 0.8)], 0.6)
    expect(kept).toHaveLength(2)
  })
})

describe('clampBox', () => {
  it('이미지 밖으로 나간 상자를 자른다', () => {
    expect(clampBox(box(-5, -5, 20, 20), 100, 100)).toMatchObject({ x: 0, y: 0, width: 15, height: 15 })
    expect(clampBox(box(95, 95, 20, 20), 100, 100)).toMatchObject({ x: 95, y: 95, width: 5, height: 5 })
  })
})
