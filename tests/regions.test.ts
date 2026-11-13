import { describe, expect, it } from 'vitest'
import { countOutside, planMasks, selectTracks, type Edits, type PlanSource } from '../src/core/mask-plan'
import { isTarget, polygonRegion, rectRegion, regionBounds, translateRegion, type Region } from '../src/core/regions'

const face = (x: number, y: number, size = 40) => ({ x: x - size / 2, y: y - size / 2, width: size, height: size })
const include = rectRegion({ x: 100, y: 100, width: 400, height: 300 })

describe('영역 규칙', () => {
  it('포함 영역이 없으면 화면 전체가 대상', () => {
    expect(isTarget(face(900, 600), [], 0)).toBe(true)
  })

  it('포함 영역을 그리면 그 안의 얼굴만 대상', () => {
    expect(isTarget(face(200, 200), [include], 0)).toBe(true)
    expect(isTarget(face(900, 600), [include], 0)).toBe(false)
  })

  it('다각형 영역도 중심점으로 판정한다', () => {
    const triangle = polygonRegion([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 0, y: 400 },
    ])
    expect(isTarget(face(100, 100), [triangle], 0)).toBe(true)
    expect(isTarget(face(350, 350), [triangle], 0)).toBe(false)
  })

  it('제외 영역은 포함 영역보다 우선한다', () => {
    const teacher = rectRegion({ x: 150, y: 150, width: 100, height: 100 }, true)
    expect(isTarget(face(200, 200), [include, teacher], 0)).toBe(false)
    expect(isTarget(face(400, 300), [include, teacher], 0)).toBe(true)
  })

  it('제외 영역만 있으면 그 밖의 화면 전체가 대상', () => {
    const teacher = rectRegion({ x: 150, y: 150, width: 100, height: 100 }, true)
    expect(isTarget(face(200, 200), [teacher], 0)).toBe(false)
    expect(isTarget(face(900, 600), [teacher], 0)).toBe(true)
  })

  it('구간을 정한 영역은 그 시간에만 적용된다', () => {
    const timed: Region = { ...include, startSec: 10, endSec: 20 }
    expect(isTarget(face(200, 200), [timed], 5)).toBe(false)
    expect(isTarget(face(200, 200), [timed], 10)).toBe(true)
    expect(isTarget(face(200, 200), [timed], 20)).toBe(true)
    expect(isTarget(face(200, 200), [timed], 20.5)).toBe(false)
  })

  it('제외 영역도 구간 밖에서는 적용되지 않는다', () => {
    const teacher: Region = { ...rectRegion({ x: 150, y: 150, width: 100, height: 100 }, true), startSec: 30, endSec: null }
    expect(isTarget(face(200, 200), [teacher], 10)).toBe(true)
    expect(isTarget(face(200, 200), [teacher], 31)).toBe(false)
  })

  it('영역을 옮겨도 프레임 밖으로 나가지 않는다', () => {
    const moved = translateRegion(include, 5000, -5000, 1920, 1080)
    expect(regionBounds(moved)).toEqual({ x: 1520, y: 0, width: 400, height: 300 })
    const polygon = translateRegion(polygonRegion([{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 10, y: 60 }]), 20, 30, 1920, 1080)
    expect(regionBounds(polygon)).toEqual({ x: 30, y: 40, width: 50, height: 50 })
  })
})

/** 30fps, 60프레임. 추적 1은 영역 안, 추적 2는 영역 밖에 있다. */
function source(): PlanSource {
  const timestampsUs = Array.from({ length: 60 }, (_, frame) => Math.round((frame * 1e6) / 30))
  const points = (x: number, y: number, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ frame: from + i, box: face(x, y), score: 0.9 }))
  return {
    width: 1920,
    height: 1080,
    frameCount: 60,
    timestampsUs,
    tracks: [
      { id: 1, points: points(200, 200, 0, 59) },
      { id: 2, points: points(1500, 800, 10, 40) },
    ],
  }
}
const settings = { regions: [] as Region[], maxGapFrames: 15, padFrames: 5, marginRatio: 0 }
const noEdits: Edits = { manualTracks: [], removedTrackIds: [] }

describe('가림 계획에 영역·수동 수정 반영', () => {
  it('영역이 없으면 모든 추적을 가린다', () => {
    const plan = planMasks(source(), settings, noEdits)
    expect(plan[20]!.map((box) => box.trackId).sort()).toEqual([1, 2])
  })

  it('영역 밖 추적은 가리지 않는다', () => {
    const plan = planMasks(source(), { ...settings, regions: [include] }, noEdits)
    expect(plan[20]!.map((box) => box.trackId)).toEqual([1])
    expect(countOutside(source(), [include])).toBe(31)
  })

  it('구간 영역: 구간 안의 프레임만 가리고 앞뒤로 시간 여유가 붙는다', () => {
    // 1초~1.5초 = 30~45 프레임
    const timed: Region = { ...include, startSec: 1, endSec: 1.5 }
    const plan = planMasks(source(), { ...settings, regions: [timed] }, noEdits)
    const covered = plan.map((boxes, frame) => (boxes.length > 0 ? frame : -1)).filter((frame) => frame >= 0)
    expect(covered[0]).toBe(25)
    expect(covered[covered.length - 1]).toBe(50)
  })

  it('잘못 잡힌 추적을 지우면 그 추적만 빠진다', () => {
    const plan = planMasks(source(), settings, { manualTracks: [], removedTrackIds: [2] })
    expect(plan.every((boxes) => boxes.every((box) => box.trackId === 1))).toBe(true)
    expect(plan[20]).toHaveLength(1)
  })

  it('수동으로 추가한 얼굴은 영역 밖이어도 가린다', () => {
    const manual = { id: -1, points: [{ timeUs: Math.round((20 * 1e6) / 30), box: face(1700, 100) }] }
    const plan = planMasks(source(), { ...settings, regions: [include] }, { manualTracks: [manual], removedTrackIds: [] })
    expect(plan[20]!.some((box) => box.trackId === -1)).toBe(true)
    // 한 프레임만 표시해도 앞뒤 시간 여유(5프레임)만큼 가린다.
    expect(plan[15]!.some((box) => box.trackId === -1)).toBe(true)
    expect(plan[25]!.some((box) => box.trackId === -1)).toBe(true)
    expect(plan[26]!.some((box) => box.trackId === -1)).toBe(false)
  })

  it('수동 추가는 시각으로 저장되고 가장 가까운 프레임에 붙는다', () => {
    const manual = { id: -1, points: [{ timeUs: 1_000_010, box: face(500, 500) }] }
    const tracks = selectTracks(source(), [], { manualTracks: [manual], removedTrackIds: [] })
    expect(tracks.find((track) => track.id === -1)?.points[0]?.frame).toBe(30)
  })
})
