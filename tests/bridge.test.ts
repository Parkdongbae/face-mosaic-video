import { describe, expect, it } from 'vitest'
import { planMasks, type PlanSource } from '../src/core/mask-plan'
import { rectRegion } from '../src/core/regions'
import { buildMaskPlan, type FaceTrack } from '../src/core/tracker'

const box = (x: number, y: number, size = 100) => ({ x, y, width: size, height: size })
const track = (id: number, points: Array<[number, number, number]>, size = 100): FaceTrack => ({
  id,
  points: points.map(([frame, x, y]) => ({ frame, box: box(x, y, size), score: 0.9 })),
})
const options = { frameCount: 200, frameWidth: 1920, frameHeight: 1080, maxGapFrames: 15, padFrames: 5, marginRatio: 0 }
const coveredFrames = (plan: Array<unknown[]>) => plan.map((boxes, frame) => (boxes.length > 0 ? frame : -1)).filter((frame) => frame >= 0)

describe('검출이 오래 끊긴 사이를 이어 가리기', () => {
  it('보간 한도를 넘어도 한도 시간 안에 같은 얼굴이 다시 잡히면 그 사이를 계속 가린다', () => {
    const plan = buildMaskPlan([track(1, [[10, 300, 300], [60, 320, 300]])], { ...options, bridgeFrames: 90 })
    expect(coveredFrames(plan)).toEqual(Array.from({ length: 61 }, (_, index) => index + 5))
    // 제자리에서 다시 잡혔으면 양쪽 위치를 모두 덮는다
    expect(plan[35]).toEqual([{ x: 300, y: 300, width: 120, height: 100 }])
  })

  it('이어 가리기를 켜지 않으면 양쪽에 시간 여유만 준다(이전 동작)', () => {
    const plan = buildMaskPlan([track(1, [[10, 300, 300], [60, 320, 300]])], options)
    expect(plan[15]).toHaveLength(1)
    expect(plan[16]).toHaveLength(0)
    expect(plan[54]).toHaveLength(0)
    expect(plan[55]).toHaveLength(1)
  })

  it('한도보다 오래 끊겼으면 이어 가리지 않는다', () => {
    const plan = buildMaskPlan([track(1, [[10, 300, 300], [150, 300, 300]])], { ...options, bridgeFrames: 90 })
    expect(plan[80]).toHaveLength(0)
    expect(plan[15]).toHaveLength(1)
    expect(plan[145]).toHaveLength(1)
  })

  it('얼굴 크기만큼 떨어진 곳에서 다시 잡혔어도 양쪽을 통째로 덮는다(언제 옮겨 갔는지 모른다)', () => {
    const plan = buildMaskPlan([track(1, [[0, 100, 100], [40, 200, 100]])], { ...options, bridgeFrames: 90 })
    expect(plan[1]).toEqual([{ x: 100, y: 100, width: 200, height: 100 }])
    expect(plan[20]).toEqual([{ x: 100, y: 100, width: 200, height: 100 }])
    expect(plan[39]).toEqual([{ x: 100, y: 100, width: 200, height: 100 }])
  })

  it('멀리 떨어진 곳에서 다시 잡혔으면 통째로 덮지 않고 그 사이를 옮겨 가는 상자로 가린다', () => {
    const plan = buildMaskPlan([track(1, [[0, 100, 100], [40, 500, 100]])], { ...options, bridgeFrames: 90 })
    const middle = plan[20]!
    expect(middle).toHaveLength(1)
    // 가운데 프레임: 두 위치의 중간에 얼굴 한 개 크기
    expect(middle[0]).toEqual({ x: 300, y: 100, width: 100, height: 100 })
  })

  it('영역 규칙이 막는 프레임은 이어 가리지 않고 시간 여유만 남긴다', () => {
    const plan = buildMaskPlan([track(1, [[10, 300, 300], [60, 320, 300]])], {
      ...options,
      bridgeFrames: 90,
      acceptBridge: () => false,
    })
    expect(plan[15]).toHaveLength(1)
    expect(plan[30]).toHaveLength(0)
    expect(plan[55]).toHaveLength(1)
  })
})

describe('장면 경계', () => {
  it('오래 끊긴 사이에 장면이 바뀌었으면 이어 가리지 않고 양쪽에 시간 여유만 준다', () => {
    const tracks = [track(1, [[10, 300, 300], [60, 320, 300]])]
    const same = buildMaskPlan(tracks, { ...options, bridgeFrames: 90 })
    expect(same[35]).toHaveLength(1)
    const cut = buildMaskPlan(tracks, { ...options, bridgeFrames: 90, sceneCuts: [30] })
    expect(cut[15]).toHaveLength(1)
    expect(cut[16]).toHaveLength(0)
    expect(cut[35]).toHaveLength(0)
    expect(cut[54]).toHaveLength(0)
    expect(cut[55]).toHaveLength(1)
  })

  it('장면 경계가 끊긴 구간 밖에 있으면 이어 가린다', () => {
    const plan = buildMaskPlan([track(1, [[10, 300, 300], [60, 320, 300]])], { ...options, bridgeFrames: 90, sceneCuts: [5, 61] })
    expect(plan[35]).toHaveLength(1)
  })

  it('짧게 끊긴 사이의 보간과 앞뒤 시간 여유는 장면 경계와 무관하다(빠른 화면 이동을 장면 전환으로 잘못 봐도 가림이 끊기지 않게)', () => {
    const plan = buildMaskPlan([track(1, [[10, 100, 100], [14, 140, 100]])], { ...options, bridgeFrames: 90, sceneCuts: [12] })
    expect(plan[12]).toEqual([box(120, 100)])
    expect(coveredFrames(plan)).toEqual(Array.from({ length: 15 }, (_, index) => index + 5))
  })
})

describe('프레임 속도에 맞춘 시간 기준', () => {
  const sourceAt = (fps: number, tracks: FaceTrack[], frameCount = 400): PlanSource => ({
    width: 1920,
    height: 1080,
    frameCount,
    timestampsUs: Array.from({ length: frameCount }, (_, frame) => Math.round((frame * 1e6) / fps)),
    tracks,
  })
  const settings = { regions: [], maxGapFrames: 15, padFrames: 5, marginRatio: 0, falsePositiveFilter: 'off' as const }

  it('60fps 영상은 시간 여유·보간 한도가 프레임 수로 두 배가 된다(가리는 시간이 같도록)', () => {
    const single = sourceAt(60, [track(1, [[100, 300, 300]])])
    expect(coveredFrames(planMasks(single, settings))).toEqual(Array.from({ length: 21 }, (_, index) => index + 90))

    // 25프레임 공백: 30fps 기준으로는 보간 한도(15)를 넘지만 60fps 에서는 0.4초라 보간한다
    const gap = sourceAt(60, [track(1, [[100, 300, 300], [126, 352, 300]])])
    expect(planMasks(gap, { ...settings, bridgeMaxSec: 0 })[113]).toEqual([{ x: 326, y: 300, width: 100, height: 100, trackId: 1 }])
  })

  it('30fps 영상은 그대로다', () => {
    const single = sourceAt(30, [track(1, [[100, 300, 300]])])
    expect(coveredFrames(planMasks(single, settings))).toEqual(Array.from({ length: 11 }, (_, index) => index + 95))
  })

  it('끊긴 사이를 이어 가리는 한도는 초로 정한다(기본 3초)', () => {
    const within = sourceAt(30, [track(1, [[10, 300, 300], [90, 300, 300]])])
    expect(planMasks(within, settings)[50]).toHaveLength(1)
    const beyond = sourceAt(30, [track(1, [[10, 300, 300], [110, 300, 300]])])
    expect(planMasks(beyond, settings)[50]).toHaveLength(0)
  })
})

describe('영역과 이어 가리기', () => {
  const frameCount = 120
  const source: PlanSource = {
    width: 1920,
    height: 1080,
    frameCount,
    timestampsUs: Array.from({ length: frameCount }, (_, frame) => Math.round((frame * 1e6) / 30)),
    // 얼굴이 왼쪽에서 오른쪽으로 지나가며 가운데(제외 영역)를 통과한다
    tracks: [{ id: 1, points: Array.from({ length: 100 }, (_, frame) => ({ frame, box: box(100 + frame * 10, 300), score: 0.9 })) }],
  }
  const settings = { regions: [rectRegion({ x: 500, y: 0, width: 300, height: 1080 }, true)], maxGapFrames: 15, padFrames: 5, marginRatio: 0, falsePositiveFilter: 'off' as const }

  it('제외 영역을 지나는 동안은 가리지 않고, 그 구간을 건너 이어 가리지도 않는다', () => {
    const plan = planMasks(source, settings)
    // 중심이 제외 영역(x 500~800) 안에 있는 프레임: 35~65
    expect(plan[20]).toHaveLength(1)
    expect(plan[50]).toHaveLength(0)
    expect(plan[80]).toHaveLength(1)
    // 제외 영역에 들어간 직후에는 시간 여유(5프레임)만 남는다
    expect(plan[39]).toHaveLength(1)
    expect(plan[41]).toHaveLength(0)
  })

  it('직접 추가한 얼굴은 제외 영역 안에서도 끊긴 사이를 이어 가린다(영역과 무관하게 항상 가린다)', () => {
    const empty: PlanSource = { ...source, tracks: [] }
    // 제외 영역 한가운데에 직접 추가한 얼굴: 0.33초와 2초에만 점이 있다
    const manual = { id: -1, points: [{ timeUs: Math.round((10 * 1e6) / 30), box: box(600, 300) }, { timeUs: Math.round((60 * 1e6) / 30), box: box(610, 300) }] }
    const plan = planMasks(empty, settings, { manualTracks: [manual], removedTrackIds: [] })
    expect(plan[35]).toEqual([{ x: 600, y: 300, width: 110, height: 100, trackId: -1 }])
  })
})
