import { describe, expect, it } from 'vitest'
import { keepFaces, rejectReason, rejectReasons } from '../src/core/false-positive'
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

  it('확대 검출에서만 잡혔더라도 몇 번 안 잡힌 것은 판단을 미루고 남긴다(고개 숙인 진짜 얼굴일 수 있다)', () => {
    // 실제 교실 영상에서 폭 90~120px 얼굴이 전체 화면 검출에서는 절반쯤만 잡혔다.
    const few = track({ frames: every(0, 9, 3), width: 92, height: 106, score: 0.75, tile: true })
    expect(few.points).toHaveLength(4)
    expect(rejectReason(few, 1920, 1080, 'normal')).toBeNull()
  })

  it('화면을 가득 채울 만큼 큰데 점수가 낮은 상자는 뺀다(벽·책상을 얼굴로 본 것)', () => {
    const wall = track({ frames: every(0, 30), width: 1222, height: 1080, score: 0.4 })
    expect(rejectReason(wall, 1920, 1080, 'normal')).toBe('giant')
    const desk = track({ frames: every(0, 30), width: 440, height: 520, score: 0.55 })
    expect(rejectReason(desk, 1920, 1080, 'normal')).toBe('giant')
    // 카메라 바로 앞의 또렷한 얼굴은 점수가 높으므로 남긴다
    const selfie = track({ frames: every(0, 30), width: 480, height: 620, score: 0.93 })
    expect(rejectReason(selfie, 1920, 1080, 'normal')).toBeNull()
    // 가까이에서 고개를 돌려 점수가 조금 떨어진 얼굴도 남긴다(큰 얼굴을 놓치는 쪽이 더 위험하다)
    const turned = track({ frames: every(0, 30), width: 480, height: 620, score: 0.72 })
    expect(rejectReason(turned, 1920, 1080, 'normal')).toBeNull()
  })

  it('화면 가장자리에 걸려 잘린 얼굴은 모양이 길쭉해도 남긴다', () => {
    // 오른쪽 끝에 반쯤 걸린 얼굴: 폭 60, 높이 170 (비율 0.35)
    const edge: FaceTrack = {
      id: 900,
      points: every(0, 30).map((frame) => ({ frame, box: { x: 1860, y: 300, width: 60, height: 170 }, score: 0.8 })),
    }
    expect(rejectReason(edge, 1920, 1080, 'normal')).toBeNull()
    // 화면 안쪽에 있는 같은 모양의 상자는 얼굴이 아니다
    const inner: FaceTrack = { id: 901, points: edge.points.map((point) => ({ ...point, box: { ...point.box, x: 900 } })) }
    expect(rejectReason(inner, 1920, 1080, 'normal')).toBe('shape')
  })

  it('가로로 너무 납작하거나 세로로 너무 긴 상자는 뺀다', () => {
    expect(rejectReason(track({ frames: every(0, 30), width: 160, height: 60, score: 0.8 }), W, H, 'normal')).toBe('shape')
    expect(rejectReason(track({ frames: every(0, 30), width: 30, height: 120, score: 0.8 }), W, H, 'normal')).toBe('shape')
  })

  it('한두 번 잠깐 잡힌 낮은 점수는 빼고, 점수가 높으면 남긴다', () => {
    expect(rejectReason(track({ frames: [10, 11], width: 60, height: 80, score: 0.45 }), W, H, 'normal')).toBe('sporadic')
    expect(rejectReason(track({ frames: [10], width: 60, height: 80, score: 0.85 }), W, H, 'normal')).toBeNull()
    expect(rejectReason(track({ frames: [10], width: 60, height: 80, score: 0.6 }), W, H, 'normal')).toBe('sporadic')
  })

  it('두 번만 잡혔어도 떨어진 시점에 0.5점 이상으로 잡힌 것은 남긴다(드물게 하는 확대 검출에서만 잡히는 작은 얼굴)', () => {
    // 타일 검출 두 차례(12프레임 간격)에 걸쳐 잡힌 작은 얼굴
    expect(rejectReason(track({ frames: [10, 22], width: 40, height: 52, score: 0.55, tile: true }), 1920, 1080, 'normal')).toBeNull()
    // 떨어져 잡혔어도 점수가 아주 낮으면 뺀다
    expect(rejectReason(track({ frames: [10, 22], width: 40, height: 52, score: 0.45, tile: true }), 1920, 1080, 'normal')).toBe('sporadic')
    // 점수가 0.5 이상이어도 거의 붙어서 두 번 잡힌 것은 잠깐 잡힌 것이다
    expect(rejectReason(track({ frames: [10, 12], width: 40, height: 52, score: 0.55 }), 1920, 1080, 'normal')).toBe('sporadic')
  })

  it('두 번 잡힌 사이는 프레임 수가 아니라 시간으로 잰다(프레임 속도가 달라도 같은 기준)', () => {
    const twice = (frames: number[]) => track({ frames, width: 40, height: 52, score: 0.55, tile: true })
    // 4프레임 간격: 30fps 에서는 0.13초(잠깐), 24fps 에서는 0.17초('보통'의 타일 검출이 이어서 두 번 잡은 것)
    expect(rejectReason(twice([10, 14]), 1920, 1080, 'normal', 30)).toBe('sporadic')
    expect(rejectReason(twice([10, 14]), 1920, 1080, 'normal', 24)).toBeNull()
    // 60fps 에서는 6프레임이 0.1초라 잠깐이고, 12프레임(0.2초)이면 남긴다
    expect(rejectReason(twice([10, 16]), 1920, 1080, 'normal', 60)).toBe('sporadic')
    expect(rejectReason(twice([10, 22]), 1920, 1080, 'normal', 60)).toBeNull()
  })

  it('장면이 바뀐 뒤 약한 검출로만 이어져 따로 뗀 구간은 앞 구간과 한 묶음으로 판단한다', () => {
    // 앞 구간: 전체 화면에서도 잡힌 진짜 얼굴. 뒤 구간: 확대 검출에서만 약하게 6번 잡힘(혼자 보면 '확대 검출에서만 잡힌 큰 상자')
    const head = track({ frames: every(0, 30, 2), width: 100, height: 120, score: 0.8 })
    const tail: FaceTrack = {
      id: 500,
      after: head.id,
      points: every(40, 70, 6).map((frame) => ({ frame, box: { x: 300, y: 200, width: 100, height: 120 }, score: 0.3, tile: true, weak: true })),
    }
    expect(rejectReason(tail, 1920, 1080, 'normal')).toBe('tile-only')
    expect(keepFaces([head, tail], 1920, 1080, 'normal').map((item) => item.id)).toEqual([head.id, tail.id])
    expect(rejectReasons([head, tail], 1920, 1080, 'normal').size).toBe(0)

    // 앞 구간이 얼굴이 아닌 것으로 빠지면 뒤 구간도 함께 빠진다
    const wall = track({ frames: every(0, 30, 2), width: 1222, height: 1080, score: 0.4 })
    const wallTail: FaceTrack = { ...tail, id: 501, after: wall.id }
    expect(keepFaces([wall, wallTail], 1920, 1080, 'normal')).toHaveLength(0)
    expect([...rejectReasons([wall, wallTail], 1920, 1080, 'normal').entries()]).toEqual([[wall.id, 'giant'], [501, 'giant']])

    // 앞 구간이 목록에 없으면 혼자 판단한다
    expect(keepFaces([tail], 1920, 1080, 'normal')).toHaveLength(0)
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
