import { describe, expect, it } from 'vitest'
import { linkedTrackIds, planMasks } from '../src/core/mask-plan'
import { FaceTracker, splitWeakTailsAtCuts, type FaceTrack } from '../src/core/tracker'

const face = (x: number, y: number, score: number, size = 100) => ({ x, y, width: size, height: size, score })
// 30fps, 강한 검출 기준 0.4, 같은 얼굴로 잇는 한도 3초, 약한 검출로 잇는 한도 1초, 장면이 바뀐 뒤 잇는 한도 0.5초
const options = { maxGapFrames: 90, weakGapFrames: 30, cutGapFrames: 15, strongScore: 0.4, fps: 30 }

describe('약한 검출로 얼굴 이어 가기', () => {
  it('약한 검출만으로는 새 얼굴이 생기지 않는다', () => {
    const tracker = new FaceTracker(options)
    for (let frame = 0; frame < 10; frame += 1) tracker.update(frame, [face(100, 100, 0.3)])
    expect(tracker.finish()).toHaveLength(0)
  })

  it('이미 찾은 얼굴은 점수가 기준값 아래로 떨어져도 이어 간다(고개를 돌린 프레임)', () => {
    const tracker = new FaceTracker(options)
    tracker.update(0, [face(100, 100, 0.9)])
    for (let frame = 1; frame <= 8; frame += 1) tracker.update(frame, [face(100 + frame * 3, 100, 0.25)])
    tracker.update(9, [face(130, 100, 0.8)])
    const tracks = tracker.finish()
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.points).toHaveLength(10)
    expect(tracks[0]!.points.map((point) => point.weak === true)).toEqual([false, true, true, true, true, true, true, true, true, false])
  })

  it('약한 검출이 얼굴 일부만 잡아도 가릴 크기는 줄지 않는다', () => {
    const tracker = new FaceTracker(options)
    tracker.update(0, [face(100, 100, 0.9, 100)])
    // 같은 자리에서 조금 작게 잡힌 약한 검출(넓이 64%)
    tracker.update(1, [{ x: 110, y: 110, width: 80, height: 80, score: 0.3 }])
    const point = tracker.finish()[0]!.points[1]!
    expect(point.box.width).toBe(100)
    expect(point.box.height).toBe(100)
    // 중심은 약한 검출을 따른다
    expect(point.box.x + point.box.width / 2).toBe(150)
  })

  it('크기가 너무 다른 약한 검출(턱만 잡힌 조각, 엉뚱하게 큰 상자)은 잇지 않는다', () => {
    const tracker = new FaceTracker(options)
    tracker.update(0, [face(100, 100, 0.9, 100)])
    tracker.update(1, [{ x: 120, y: 150, width: 50, height: 40, score: 0.3 }])
    tracker.update(2, [{ x: 0, y: 0, width: 300, height: 300, score: 0.3 }])
    expect(tracker.finish()[0]!.points).toHaveLength(1)
  })

  it('약한 검출은 1초 넘게 끊긴 얼굴을 되살리지 못하지만, 강한 검출은 3초까지 되살린다', () => {
    const weakOnly = new FaceTracker(options)
    weakOnly.update(0, [face(100, 100, 0.9)])
    weakOnly.update(40, [face(100, 100, 0.3)])
    expect(weakOnly.finish()[0]!.points).toHaveLength(1)

    const strong = new FaceTracker(options)
    strong.update(0, [face(100, 100, 0.9)])
    strong.update(80, [face(110, 100, 0.9)])
    const tracks = strong.finish()
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.points.map((point) => point.frame)).toEqual([0, 80])
  })

  it('오래 끊긴 얼굴은 조금 더 떨어진 곳에서 다시 잡혀도 같은 얼굴로 본다(자리를 고쳐 앉은 경우)', () => {
    const near = new FaceTracker(options)
    near.update(0, [face(100, 100, 0.9)])
    // 바로 다음 프레임에 얼굴 크기의 0.9배 떨어진 곳: 다른 얼굴
    near.update(1, [face(190, 100, 0.9)])
    expect(near.finish()).toHaveLength(2)

    const later = new FaceTracker(options)
    later.update(0, [face(100, 100, 0.9)])
    // 2초 뒤에 같은 거리: 같은 얼굴(허용 거리 0.6 + 0.2×2초 = 얼굴 크기의 1.0배)
    later.update(60, [face(190, 100, 0.9)])
    expect(later.finish()).toHaveLength(1)
  })

  it('장면이 바뀐 뒤에는 오래 끊긴 얼굴을 되살리지 않는다(같은 자리에 다른 것이 있다)', () => {
    const tracker = new FaceTracker(options)
    tracker.update(0, [face(100, 100, 0.9)])
    tracker.cut()
    // 장면이 바뀌고 1초 뒤 같은 자리: 장면이 바뀌지 않았다면 이어 붙였겠지만(3초 한도), 바뀌었으므로 새 얼굴이다
    tracker.update(30, [face(100, 100, 0.9)])
    expect(tracker.finish()).toHaveLength(2)
  })

  it('장면이 바뀐 뒤의 약한 검출은 자리가 조금만 어긋나도 잇지 않는다(바뀐 장면의 같은 자리에는 다른 것이 있다)', () => {
    const tracker = new FaceTracker(options)
    tracker.update(0, [face(100, 100, 0.9)])
    tracker.cut()
    // 얼굴 크기의 0.4배 옆: 장면이 바뀌지 않았다면 약한 검출로 이었겠지만(0.6배까지), 바뀌었으므로 잇지 않는다
    tracker.update(1, [face(140, 100, 0.3)])
    expect(tracker.finish()[0]!.points).toHaveLength(1)

    const same = new FaceTracker(options)
    same.update(0, [face(100, 100, 0.9)])
    same.update(1, [face(140, 100, 0.3)])
    expect(same.finish()[0]!.points).toHaveLength(2)
  })

  it('장면 전환으로 잘못 본 경우(조명·화면 밝기가 갑자기 바뀜): 제자리에 그대로 있는 얼굴은 약한 검출로도 이어 간다', () => {
    const tracker = new FaceTracker(options)
    tracker.update(0, [face(100, 100, 0.9)])
    tracker.cut()
    // 고개를 숙여 점수가 낮은 얼굴이 거의 같은 자리에서 계속 잡힌다
    for (let frame = 2; frame <= 40; frame += 2) tracker.update(frame, [face(100 + frame / 4, 100, 0.3)])
    const tracks = tracker.finish()
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.points).toHaveLength(21)
  })

  it('장면이 바뀐 뒤 0.5초 넘게 지나서 잡힌 약한 검출은 같은 자리여도 잇지 않는다', () => {
    const tracker = new FaceTracker(options)
    tracker.update(0, [face(100, 100, 0.9)])
    tracker.cut()
    // 장면이 바뀌지 않았다면 1초(30프레임)까지는 약한 검출로 이었을 것이다
    tracker.update(20, [face(100, 100, 0.3)])
    expect(tracker.finish()[0]!.points).toHaveLength(1)
  })

  it('장면 전환으로 잘못 본 경우(빠른 화면 이동): 곧바로 강한 검출로 다시 잡히면 끊기지 않는다', () => {
    const tracker = new FaceTracker(options)
    tracker.update(0, [face(100, 100, 0.9)])
    tracker.update(2, [face(160, 100, 0.9)])
    tracker.cut()
    tracker.update(4, [face(220, 100, 0.9)])
    // 다시 잡힌 뒤로는 보통 얼굴처럼 약한 검출로도 이어 간다
    tracker.update(6, [face(280, 100, 0.3)])
    const tracks = tracker.finish()
    expect(tracks).toHaveLength(1)
    expect(tracks[0]!.points.map((point) => point.frame)).toEqual([0, 2, 4, 6])
  })

  it('기준값을 주지 않으면 모든 검출이 강한 검출이다(이전 동작 그대로)', () => {
    const tracker = new FaceTracker({ maxGapFrames: 15 })
    tracker.update(0, [face(100, 100, 0.1)])
    expect(tracker.finish()).toHaveLength(1)
  })
})

describe('장면이 바뀐 뒤 약한 검출로만 이어진 구간 떼어 내기', () => {
  const box = { x: 100, y: 100, width: 100, height: 100 }
  const strong = (frame: number) => ({ frame, box, score: 0.9 })
  const weak = (frame: number) => ({ frame, box, score: 0.3, weak: true as const })

  it('장면이 바뀐 뒤 강한 검출로 다시 확인되지 않은 구간은 새 번호로 나눈다(그 가림을 지워도 앞 장면의 얼굴 가림은 남는다)', () => {
    const track: FaceTrack = { id: 7, points: [strong(0), strong(2), weak(10), weak(12), weak(14)] }
    // 다른 자리의 다른 얼굴(장면이 바뀐 뒤에도 강한 검출로 이어짐)
    const far = { x: 900, y: 500, width: 100, height: 100 }
    const other: FaceTrack = { id: 9, points: [{ frame: 0, box: far, score: 0.9 }, { frame: 20, box: far, score: 0.9 }] }
    const result = splitWeakTailsAtCuts([track, other], [8])
    expect(result.map((item) => item.id)).toEqual([7, 10, 9])
    expect(result[0]!.points.map((point) => point.frame)).toEqual([0, 2])
    expect(result[1]!.points.map((point) => point.frame)).toEqual([10, 12, 14])
    expect(result[1]!.after).toBe(7)
    expect(result[2]).toBe(other)

    // 바뀐 장면의 가림(10번)을 지워도 앞 장면의 얼굴(7번)은 함께 지워지지 않는다
    const timestampsUs = Array.from({ length: 60 }, (_, frame) => Math.round((frame / 30) * 1e6))
    expect(linkedTrackIds(result, 10, timestampsUs, [8])).toEqual([10])
    expect(linkedTrackIds(result, 7, timestampsUs, [8])).toEqual([7])
  })

  it('강한 검출로 다시 잡힌 추적은 같은 얼굴로 보고 나누지 않는다', () => {
    const track: FaceTrack = { id: 7, points: [strong(0), weak(10), weak(12), strong(14), weak(16)] }
    const result = splitWeakTailsAtCuts([track], [8])
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(track)
  })

  it('약한 검출로만 장면을 두 번 넘었으면 장면마다 나눈다', () => {
    const track: FaceTrack = { id: 3, points: [strong(0), weak(10), weak(12), weak(30), weak(32)] }
    const result = splitWeakTailsAtCuts([track], [8, 20])
    expect(result.map((item) => [item.id, item.after, item.points.map((point) => point.frame)])).toEqual([
      [3, undefined, [0]],
      [4, 3, [10, 12]],
      [5, 4, [30, 32]],
    ])
  })

  it('장면이 바뀌지 않았거나 장면 경계가 추적 밖에 있으면 그대로 둔다', () => {
    const track: FaceTrack = { id: 7, points: [strong(0), weak(10), weak(12)] }
    expect(splitWeakTailsAtCuts([track], [])).toEqual([track])
    expect(splitWeakTailsAtCuts([track], [13, 40])[0]).toBe(track)
    // 새 장면이 정확히 약한 검출의 프레임에서 시작해도 그 점부터가 새 구간이다
    expect(splitWeakTailsAtCuts([track], [10]).map((item) => item.points.map((point) => point.frame))).toEqual([[0], [10, 12]])
  })

  it('번호를 나눠도 가림은 끊기지 않는다: 장면이 바뀐 뒤 약한 검출이 늦게 잡혀도 그 사이를 앞 구간에서 이어 채운다', () => {
    const head: FaceTrack = { id: 1, points: [strong(0), strong(10)] }
    // 마지막 강한 검출 뒤 13프레임 동안 안 잡혔다가(그 사이 프레임 20에서 장면 전환) 약하게 다시 잡힘
    const tail: FaceTrack = { id: 2, after: 1, points: [weak(24), weak(26), weak(28)] }
    const source = {
      width: 1920,
      height: 1080,
      frameCount: 60,
      timestampsUs: Array.from({ length: 60 }, (_, frame) => Math.round((frame / 30) * 1e6)),
      tracks: [head, tail],
      sceneCuts: [20],
    }
    const settings = { regions: [], maxGapFrames: 15, padFrames: 5, marginRatio: 0, falsePositiveFilter: 'off' as const }

    const plan = planMasks(source, settings)
    for (let frame = 0; frame <= 33; frame += 1) expect(plan[frame]!.length, `프레임 ${frame}`).toBeGreaterThan(0)
    expect(plan[34]).toHaveLength(0)
    // 앞 구간의 시간 여유(11~15프레임)가 끝난 뒤의 사이 프레임은 뒤 구간의 가림이다
    expect(plan[18]!.map((mask) => mask.trackId)).toEqual([2])

    // 뒤 구간을 지우면 앞 구간은 시간 여유까지 그대로 남는다
    const withoutTail = planMasks(source, settings, { manualTracks: [], removedTrackIds: [2] })
    expect(withoutTail[15]).toHaveLength(1)
    expect(withoutTail[16]).toHaveLength(0)
    expect(withoutTail[24]).toHaveLength(0)
    // 앞 구간을 지우면 뒤 구간은 제 시간 여유(19~23프레임)만 갖는다
    const withoutHead = planMasks(source, settings, { manualTracks: [], removedTrackIds: [1] })
    expect(withoutHead[10]).toHaveLength(0)
    expect(withoutHead[18]).toHaveLength(0)
    expect(withoutHead[19]).toHaveLength(1)
  })

  it('추적기와 함께: 잘못 본 장면 전환 뒤 약한 검출로 이어진 구간은 번호만 나뉜다', () => {
    const tracker = new FaceTracker(options)
    tracker.update(0, [face(100, 100, 0.9)])
    tracker.update(2, [face(100, 100, 0.9)])
    tracker.cut()
    for (let frame = 4; frame <= 20; frame += 2) tracker.update(frame, [face(100, 100, 0.3)])
    const result = splitWeakTailsAtCuts(tracker.finish(), [4])
    expect(result.map((item) => item.points.map((point) => point.frame))).toEqual([[0, 2], [4, 6, 8, 10, 12, 14, 16, 18, 20]])
    expect(result[1]!.after).toBe(result[0]!.id)
  })
})
