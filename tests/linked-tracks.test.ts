import { describe, expect, it } from 'vitest'
import { linkedTrackIds } from '../src/core/mask-plan'
import type { FaceTrack } from '../src/core/tracker'

// 30fps
const timestampsUs = Array.from({ length: 600 }, (_, frame) => Math.round((frame / 30) * 1e6))
const track = (id: number, from: number, to: number, x: number, y: number, size = 60): FaceTrack => ({
  id,
  points: Array.from({ length: to - from + 1 }, (_, index) => ({
    frame: from + index,
    box: { x: x - size / 2, y: y - size / 2, width: size, height: size },
    score: 0.9,
  })),
})

describe('가림 삭제: 같은 얼굴로 이어지는 추적 묶기', () => {
  it('같은 자리에서 끊겼다 이어지는 추적을 앞뒤로 모두 묶는다', () => {
    const tracks = [track(1, 0, 20, 300, 200), track(2, 28, 60, 305, 204), track(3, 70, 120, 310, 200), track(9, 0, 120, 900, 500)]
    expect(linkedTrackIds(tracks, 2, timestampsUs).sort()).toEqual([1, 2, 3])
    expect(linkedTrackIds(tracks, 1, timestampsUs).sort()).toEqual([1, 2, 3])
  })

  it('옆자리의 다른 얼굴은 묶지 않는다', () => {
    const tracks = [track(1, 0, 60, 300, 200), track(2, 0, 60, 400, 200), track(3, 62, 100, 400, 200)]
    expect(linkedTrackIds(tracks, 1, timestampsUs)).toEqual([1])
    expect(linkedTrackIds(tracks, 2, timestampsUs).sort()).toEqual([2, 3])
  })

  it('2초 넘게 떨어진 추적은 묶지 않는다', () => {
    const tracks = [track(1, 0, 20, 300, 200), track(2, 100, 140, 300, 200)]
    expect(linkedTrackIds(tracks, 1, timestampsUs)).toEqual([1])
  })

  it('같은 얼굴에 겹쳐 잡힌 추적도 함께 묶는다', () => {
    const tracks = [track(1, 0, 60, 300, 200), track(2, 30, 90, 310, 205, 70)]
    expect(linkedTrackIds(tracks, 1, timestampsUs).sort()).toEqual([1, 2])
  })

  it('그 사이에 장면이 바뀌었으면 같은 자리여도 묶지 않는다(다른 장면의 다른 얼굴까지 지우지 않도록)', () => {
    const tracks = [track(1, 0, 20, 300, 200), track(2, 28, 60, 305, 204), track(3, 70, 120, 310, 200)]
    // 프레임 24에서 새 장면이 시작된다: 1번은 앞 장면, 2·3번은 뒤 장면
    expect(linkedTrackIds(tracks, 1, timestampsUs, [24])).toEqual([1])
    expect(linkedTrackIds(tracks, 2, timestampsUs, [24]).sort()).toEqual([2, 3])
    // 장면 경계가 추적들 사이에 있지 않으면 그대로 묶는다
    expect(linkedTrackIds(tracks, 1, timestampsUs, [200]).sort()).toEqual([1, 2, 3])
  })

  it('장면이 바뀌는 곳에 걸쳐 겹쳐 잡힌 추적은 그대로 묶는다', () => {
    const tracks = [track(1, 0, 60, 300, 200), track(2, 30, 90, 310, 205, 70)]
    expect(linkedTrackIds(tracks, 1, timestampsUs, [45]).sort()).toEqual([1, 2])
  })

  it('없는 번호는 그대로 돌려준다', () => {
    expect(linkedTrackIds([], 5, timestampsUs)).toEqual([5])
  })
})
