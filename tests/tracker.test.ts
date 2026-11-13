import { describe, expect, it } from 'vitest'
import { buildMaskPlan, FaceTracker, nearestIndex } from '../src/core/tracker'

const face = (x: number, y: number, size = 100) => ({ x, y, width: size, height: size, score: 0.9 })
const planOptions = { frameCount: 40, frameWidth: 1920, frameHeight: 1080, maxGapFrames: 15, padFrames: 5, marginRatio: 0 }

describe('얼굴 추적', () => {
  it('조금씩 움직이는 얼굴은 하나의 추적으로 이어진다', () => {
    const tracker = new FaceTracker({ maxGapFrames: 15 })
    for (let frame = 0; frame < 10; frame += 1) tracker.update(frame, [face(100 + frame * 10, 200)])
    const tracks = tracker.finish()
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.points).toHaveLength(10)
  })

  it('멀리 떨어진 두 얼굴은 서로 다른 추적이 된다', () => {
    const tracker = new FaceTracker({ maxGapFrames: 15 })
    for (let frame = 0; frame < 5; frame += 1) tracker.update(frame, [face(100, 100), face(1000, 500)])
    const tracks = tracker.finish()
    expect(tracks).toHaveLength(2)
    expect(tracks.map((track) => track.points.length)).toEqual([5, 5])
  })

  it('검출이 잠깐 끊겨도 같은 얼굴로 이어 붙인다', () => {
    const tracker = new FaceTracker({ maxGapFrames: 15 })
    tracker.update(0, [face(100, 100)])
    tracker.update(1, [face(104, 100)])
    for (let frame = 2; frame < 10; frame += 1) tracker.update(frame, [])
    tracker.update(10, [face(130, 100)])
    const tracks = tracker.finish()
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.points.map((point) => point.frame)).toEqual([0, 1, 10])
  })

  it('허용 공백보다 오래 끊기면 새 추적으로 시작한다', () => {
    const tracker = new FaceTracker({ maxGapFrames: 3 })
    tracker.update(0, [face(100, 100)])
    for (let frame = 1; frame < 10; frame += 1) tracker.update(frame, [])
    tracker.update(10, [face(100, 100)])
    expect(tracker.finish()).toHaveLength(2)
  })
})

describe('가림 계획(보간·시간 여유·공간 여유)', () => {
  it('검출 사이의 빈 프레임을 선형 보간으로 채운다', () => {
    const plan = buildMaskPlan(
      [
        {
          id: 1,
          points: [
            { frame: 10, box: { x: 100, y: 100, width: 100, height: 100 }, score: 1 },
            { frame: 14, box: { x: 140, y: 100, width: 100, height: 100 }, score: 1 },
          ],
        },
      ],
      planOptions,
    )
    expect(plan[12]).toEqual([{ x: 120, y: 100, width: 100, height: 100 }])
    expect(plan[11]![0]!.x).toBe(110)
    expect(plan[13]![0]!.x).toBe(130)
  })

  it('첫 검출 앞과 마지막 검출 뒤에도 시간 여유만큼 가린다', () => {
    const plan = buildMaskPlan(
      [{ id: 1, points: [{ frame: 10, box: { x: 100, y: 100, width: 100, height: 100 }, score: 1 }] }],
      planOptions,
    )
    const covered = plan.map((boxes, frame) => (boxes.length > 0 ? frame : -1)).filter((frame) => frame >= 0)
    expect(covered).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  })

  it('영상 시작·끝을 넘는 시간 여유는 버린다', () => {
    const plan = buildMaskPlan(
      [
        {
          id: 1,
          points: [
            { frame: 2, box: { x: 0, y: 0, width: 50, height: 50 }, score: 1 },
            { frame: 38, box: { x: 0, y: 0, width: 50, height: 50 }, score: 1 },
          ],
        },
      ],
      { ...planOptions, maxGapFrames: 40 },
    )
    expect(plan).toHaveLength(40)
    expect(plan.every((boxes) => boxes.length === 1)).toBe(true)
  })

  it('공간 여유만큼 넓히고 프레임 안으로 자른다', () => {
    const plan = buildMaskPlan(
      [{ id: 1, points: [{ frame: 0, box: { x: 10, y: 10, width: 100, height: 100 }, score: 1 }] }],
      { ...planOptions, padFrames: 0, marginRatio: 0.25 },
    )
    expect(plan[0]).toEqual([{ x: 0, y: 0, width: 135, height: 135 }])
  })

  it('추적 사이 공백이 한도를 넘으면 보간하지 않고 양쪽에 시간 여유만 준다', () => {
    const box = { x: 0, y: 0, width: 50, height: 50 }
    const plan = buildMaskPlan(
      [{ id: 1, points: [{ frame: 0, box, score: 1 }, { frame: 30, box, score: 1 }] }],
      { ...planOptions, maxGapFrames: 15, padFrames: 5 },
    )
    expect(plan[5]).toHaveLength(1)
    expect(plan[6]).toHaveLength(0)
    expect(plan[24]).toHaveLength(0)
    expect(plan[25]).toHaveLength(1)
  })
})

describe('타임스탬프로 프레임 찾기', () => {
  const stamps = [0, 33333, 66667, 100000]
  it('정확히 같은 값', () => {
    expect(nearestIndex(stamps, 66667)).toBe(2)
  })
  it('가장 가까운 값', () => {
    expect(nearestIndex(stamps, 40000)).toBe(1)
    expect(nearestIndex(stamps, 60000)).toBe(2)
  })
  it('범위 밖', () => {
    expect(nearestIndex(stamps, -5)).toBe(0)
    expect(nearestIndex(stamps, 999999)).toBe(3)
    expect(nearestIndex([], 1)).toBe(-1)
  })
})
