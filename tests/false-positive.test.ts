import { describe, expect, it } from 'vitest'
import { keepFaces, rejectReason } from '../src/core/false-positive'
import { selectTracks, type PlanSource } from '../src/core/mask-plan'
import type { FaceTrack } from '../src/core/tracker'

interface Shape {
  frames: number[]
  width: number
  height: number
  score: number
  tile?: boolean
}

let nextId = 1
function track(shape: Shape): FaceTrack {
  const id = nextId
  nextId += 1
  return {
    id,
    points: shape.frames.map((frame) => ({
      frame,
      box: { x: 300, y: 200, width: shape.width, height: shape.height },
      score: shape.score,
      ...(shape.tile ? { tile: true } : {}),
    })),
  }
}
const every = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, index) => from + index * step)

// 시험 영상(1280×720)에서 실제로 나온 값들
const W = 1280
const H = 720

describe('얼굴이 아닌 것 거르기', () => {
  it('점수가 낮아도 전체 화면에서 꾸준히 잡힌 옆얼굴은 남긴다', () => {
    const profile = track({ frames: every(76, 113), width: 79, height: 105, score: 0.41 })
    expect(rejectReason(profile, W, H, 'normal')).toBeNull()
  })

  it('확대 검출에서만 잡힌 큰 상자(옷깃 무늬)는 점수가 높아도 뺀다', () => {
    const collar = track({ frames: every(39, 75, 3), width: 73, height: 56, score: 0.69, tile: true })
    expect(rejectReason(collar, W, H, 'normal')).toBe('tile-only')
  })

  it('확대 검출에서만 잡혀도 작은(멀리 있는) 얼굴은 남긴다', () => {
    const far = track({ frames: every(0, 90, 3), width: 24, height: 30, score: 0.55, tile: true })
    expect(rejectReason(far, W, H, 'normal')).toBeNull()
  })

  it('한 번이라도 전체 화면에서 잡혔으면 확대 검출만이라고 보지 않는다', () => {
    const mixed = track({ frames: every(0, 30, 3), width: 80, height: 100, score: 0.6, tile: true })
    delete mixed.points[4]!.tile
    expect(rejectReason(mixed, W, H, 'normal')).toBeNull()
  })

  it('가로로 너무 납작하거나 세로로 너무 긴 상자는 뺀다', () => {
    expect(rejectReason(track({ frames: every(0, 30), width: 160, height: 60, score: 0.8 }), W, H, 'normal')).toBe('shape')
    expect(rejectReason(track({ frames: every(0, 30), width: 30, height: 120, score: 0.8 }), W, H, 'normal')).toBe('shape')
  })

  it('한두 번 잠깐 잡힌 낮은 점수는 빼고, 점수가 높으면 남긴다', () => {
    expect(rejectReason(track({ frames: [10, 11], width: 60, height: 80, score: 0.45 }), W, H, 'normal')).toBe('sporadic')
    expect(rejectReason(track({ frames: [10], width: 60, height: 80, score: 0.85 }), W, H, 'normal')).toBeNull()
  })

  it('강하게: 최고 점수가 낮은 것도 뺀다', () => {
    const profile = track({ frames: every(76, 113), width: 79, height: 105, score: 0.41 })
    expect(rejectReason(profile, W, H, 'strong')).toBe('weak')
    expect(rejectReason(track({ frames: every(0, 30), width: 79, height: 105, score: 0.8 }), W, H, 'strong')).toBeNull()
  })

  it('거르지 않음: 모두 남긴다', () => {
    const collar = track({ frames: every(39, 75, 3), width: 73, height: 56, score: 0.69, tile: true })
    expect(keepFaces([collar], W, H, 'off')).toHaveLength(1)
  })

  it('가림 계획에 반영되고, 직접 추가한 얼굴은 거르지 않는다', () => {
    const collar = track({ frames: every(39, 75, 3), width: 73, height: 56, score: 0.69, tile: true })
    const face = track({ frames: every(0, 60), width: 100, height: 120, score: 0.9 })
    const source: PlanSource = {
      width: W,
      height: H,
      frameCount: 120,
      timestampsUs: Array.from({ length: 120 }, (_, frame) => Math.round((frame / 30) * 1e6)),
      tracks: [collar, face],
    }
    const manual = { id: -1, points: [{ timeUs: 0, box: { x: 10, y: 10, width: 200, height: 40 } }] }
    const edits = { manualTracks: [manual], removedTrackIds: [] }
    expect(selectTracks(source, [], edits).map((item) => item.id)).toEqual([face.id, -1])
    expect(selectTracks(source, [], edits, 'off').map((item) => item.id)).toEqual([collar.id, face.id, -1])
  })
})
