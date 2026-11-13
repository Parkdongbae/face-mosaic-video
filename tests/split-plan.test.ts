import { describe, expect, it } from 'vitest'
import { pieceFileName, planByCount, planBySize, SplitNotPossibleError, type KeyFrameIndex } from '../src/core/split-plan'

/** 2초마다 키프레임, 초당 1MB 인 60초 영상 */
function uniformIndex(durationSec = 60, gapSec = 2, bytesPerSec = 1_000_000): KeyFrameIndex {
  const keyFrames = []
  for (let time = 0; time < durationSec; time += gapSec) keyFrames.push({ timeSec: time, bytesBefore: time * bytesPerSec })
  return { keyFrames, endSec: durationSec, totalBytes: durationSec * bytesPerSec }
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

describe('개수 분할', () => {
  it('전체 길이를 균등하게 나누고 키프레임에서 자른다', () => {
    const pieces = planByCount(uniformIndex(), 3)
    expect(pieces.map((piece) => [piece.startSec, piece.endSec])).toEqual([
      [0, 20],
      [20, 40],
      [40, 60],
    ])
    expect(pieces.map((piece) => piece.index)).toEqual([1, 2, 3])
  })

  it('목표 시각에서 가장 가까운 키프레임을 고른다', () => {
    const index: KeyFrameIndex = {
      keyFrames: [0, 7, 9, 22, 31].map((timeSec) => ({ timeSec, bytesBefore: timeSec * 100 })),
      endSec: 40,
      totalBytes: 4000,
    }
    // 목표 20초 → 22초(거리 2)가 9초(거리 11)보다 가깝다.
    expect(planByCount(index, 2).map((piece) => piece.startSec)).toEqual([0, 22])
  })

  it('조각의 길이 합과 용량 합이 원본과 같다', () => {
    const index = uniformIndex(125, 2.5, 800_000)
    const pieces = planByCount(index, 7)
    expect(sum(pieces.map((piece) => piece.endSec - piece.startSec))).toBeCloseTo(125, 9)
    expect(sum(pieces.map((piece) => piece.estimatedBytes))).toBe(index.totalBytes)
    for (let i = 1; i < pieces.length; i += 1) expect(pieces[i]!.startSec).toBe(pieces[i - 1]!.endSec)
  })

  it('키프레임이 모자라면 조각 수가 줄어든다', () => {
    const index: KeyFrameIndex = { keyFrames: [{ timeSec: 0, bytesBefore: 0 }, { timeSec: 30, bytesBefore: 3000 }], endSec: 60, totalBytes: 6000 }
    expect(planByCount(index, 5)).toHaveLength(2)
  })

  it('개수는 2~20 만 받는다', () => {
    expect(() => planByCount(uniformIndex(), 1)).toThrow(RangeError)
    expect(() => planByCount(uniformIndex(), 21)).toThrow(RangeError)
  })
})

describe('용량 분할', () => {
  it('어떤 조각도 상한을 넘지 않는다', () => {
    const index = uniformIndex(600, 2, 2_000_000) // 1.2GB
    const maxBytes = 500 * 1024 * 1024
    const pieces = planBySize(index, maxBytes)
    expect(pieces).toHaveLength(3)
    for (const piece of pieces) expect(piece.estimatedBytes).toBeLessThanOrEqual(maxBytes)
    expect(sum(pieces.map((piece) => piece.estimatedBytes))).toBe(index.totalBytes)
  })

  it('상한의 97%를 넘기 직전의 키프레임에서 자른다', () => {
    // 키프레임이 10MB 마다 있고 상한이 35MB → 한도 33.95MB → 30MB 지점에서 자른다.
    const index: KeyFrameIndex = {
      keyFrames: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ timeSec: i * 10, bytesBefore: i * 10_000_000 })),
      endSec: 70,
      totalBytes: 70_000_000,
    }
    expect(planBySize(index, 35_000_000).map((piece) => piece.estimatedBytes)).toEqual([30_000_000, 30_000_000, 10_000_000])
  })

  it('전체가 상한보다 작으면 한 조각', () => {
    expect(planBySize(uniformIndex(10), 1_000_000_000)).toHaveLength(1)
  })

  it('키프레임 간격 하나가 상한보다 크면 나눌 수 없다고 알린다', () => {
    const index: KeyFrameIndex = { keyFrames: [{ timeSec: 0, bytesBefore: 0 }, { timeSec: 100, bytesBefore: 900_000_000 }], endSec: 200, totalBytes: 1_800_000_000 }
    expect(() => planBySize(index, 500_000_000)).toThrow(SplitNotPossibleError)
  })

  it('용량이 고르지 않아도 상한을 지킨다', () => {
    const keyFrames = []
    let bytes = 0
    for (let i = 0; i < 200; i += 1) {
      keyFrames.push({ timeSec: i * 2, bytesBefore: bytes })
      bytes += 500_000 + ((i * 7919) % 13) * 400_000
    }
    const pieces = planBySize({ keyFrames, endSec: 400, totalBytes: bytes }, 50_000_000)
    for (const piece of pieces) expect(piece.estimatedBytes).toBeLessThanOrEqual(50_000_000)
    expect(sum(pieces.map((piece) => piece.estimatedBytes))).toBe(bytes)
  })
})

describe('조각 파일 이름', () => {
  it('두 자리 번호를 붙인다', () => {
    expect(pieceFileName('체육대회.mp4', 1, true)).toBe('체육대회_part01_mosaic.mp4')
    expect(pieceFileName('체육대회.mp4', 12, false)).toBe('체육대회_part12.mp4')
    expect(pieceFileName('a.b.avi', 3, false)).toBe('a.b_part03.mp4')
  })
})
