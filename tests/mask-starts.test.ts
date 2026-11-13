import { describe, expect, it } from 'vitest'
import { maskStartFrames } from '../src/core/mask-plan'
import type { MaskBox } from '../src/core/tracker'

const box = (trackId: number, x: number, y = 100): MaskBox => ({ x, y, width: 80, height: 80, trackId })

function planOf(frameCount: number, spans: Array<{ id: number; from: number; to: number; x: number }>): MaskBox[][] {
  const plan: MaskBox[][] = Array.from({ length: frameCount }, () => [])
  for (const span of spans) {
    for (let frame = span.from; frame <= span.to; frame += 1) plan[frame]!.push(box(span.id, span.x))
  }
  return plan
}

describe('모자이크가 새로 생기는 지점 찾기', () => {
  it('이어지는 구간은 건너뛰고 시작 프레임만 돌려준다', () => {
    const plan = planOf(100, [
      { id: 1, from: 10, to: 40, x: 100 },
      { id: 2, from: 60, to: 90, x: 100 },
    ])
    expect(maskStartFrames(plan)).toEqual([10, 60])
  })

  it('이미 모자이크가 있는 화면에 다른 얼굴이 새로 나타나도 시작으로 친다', () => {
    const plan = planOf(100, [
      { id: 1, from: 0, to: 99, x: 100 },
      { id: 2, from: 30, to: 50, x: 600 },
    ])
    expect(maskStartFrames(plan)).toEqual([0, 30])
  })

  it('같은 자리에서 추적 번호만 바뀌어 이어지면 시작으로 치지 않는다', () => {
    const plan = planOf(100, [
      { id: 1, from: 10, to: 40, x: 100 },
      { id: 2, from: 41, to: 80, x: 105 },
    ])
    expect(maskStartFrames(plan)).toEqual([10])
  })

  it('모자이크가 없으면 빈 목록', () => {
    expect(maskStartFrames(planOf(20, []))).toEqual([])
  })
})
