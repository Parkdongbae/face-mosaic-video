import { describe, expect, it } from 'vitest'
import { isSceneCut, SCENE_SIGNATURE, SceneCutFinder, sceneRange, sceneSimilarity } from '../src/core/scene'

const { width, height } = SCENE_SIGNATURE

/** 서명 그림을 만든다. pattern(x, y) 가 밝기(0~255)를 정한다. */
function signature(pattern: (x: number, y: number) => number): Uint8Array {
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[y * width + x] = Math.max(0, Math.min(255, Math.round(pattern(x, y))))
  return data
}
/** 교실 비슷한 화면: 위는 밝은 벽, 아래는 책상, 군데군데 사람. offset 만큼 카메라를 옆으로 돌린 모습을 만들 수 있다. */
const classroomAt = (offset: number) =>
  signature((x, y) => {
    const u = x + offset
    const wall = y < 7 ? 170 + ((u * 13) % 23) : 70 + ((u * 7 + y * 5) % 31)
    const person = (u % 9 < 3 && y >= 6 && y < 13) ? -60 : 0
    const window = u >= 40 && u < 46 && y < 6 ? 60 : 0
    return wall + person + window
  })
const classroom = classroomAt(0)
const hallway = signature((x, y) => 40 + ((x * x + y * 11) % 97) + (x > 20 ? 80 : 0) - (y > 10 ? 30 : 0))

describe('장면 전환 찾기', () => {
  it('같은 화면은 같은 장면이다', () => {
    expect(sceneSimilarity(classroom, classroom)).toBeCloseTo(1)
    expect(isSceneCut(classroom, classroom)).toBe(false)
  })

  it('화면 구성이 완전히 달라지면 장면이 바뀐 것이다', () => {
    expect(isSceneCut(classroom, hallway)).toBe(true)
    expect(isSceneCut(hallway, classroom)).toBe(true)
  })

  it('카메라를 빠르게 돌려 화면이 통째로 밀린 것은 장면이 바뀐 것이 아니다', () => {
    // 무늬가 되풀이되지 않는 화면: 옆으로 밀리면 그대로 견줘서는 전혀 닮지 않는다
    const sceneAt = (offset: number) =>
      signature((x, y) => 128 + 70 * Math.sin((x + offset) * 0.9 + y * 0.3) + 45 * Math.sin((x + offset) * 0.37 - y * 1.1))
    // 서명 폭의 약 16%(5칸)만큼 밀림: 1920px 화면에서 검출 프레임 사이 300px 이동에 해당
    const before = sceneAt(0)
    const after = sceneAt(5)
    expect(isSceneCut(before, after)).toBe(false)
    // 위치를 맞춰 보면 거의 똑같다
    expect(sceneSimilarity(before, after)).toBeGreaterThan(0.95)
    // 교실 화면을 조금 돌린 것도 같은 장면이다
    expect(isSceneCut(classroom, classroomAt(5))).toBe(false)
  })

  it('밝기만 통째로 달라진 것(조명, 플래시)은 장면이 바뀐 것이 아니다', () => {
    const brighter = signature((x, y) => (classroom[y * width + x] ?? 0) * 0.7 + 60)
    expect(isSceneCut(classroom, brighter)).toBe(false)
  })

  it('거의 단색인 화면(검은 화면)은 판단하지 않는다', () => {
    const black = signature(() => 2)
    expect(sceneSimilarity(classroom, black)).toBeNull()
    expect(isSceneCut(classroom, black)).toBe(false)
    expect(isSceneCut(black, classroom)).toBe(false)
  })

  it('크기가 맞지 않는 서명은 판단하지 않는다', () => {
    expect(sceneSimilarity(classroom, new Uint8Array(10))).toBeNull()
    expect(isSceneCut(new Uint8Array(0), classroom)).toBe(false)
  })

  it('서명이 순서와 무관하게 들어와도 프레임 순서대로 견준다', () => {
    const finder = new SceneCutFinder()
    const frames = [classroom, classroom, hallway, hallway, classroom]
    for (const frame of [2, 0, 4, 1, 3]) finder.add(frame, frames[frame]!)
    expect(finder.cuts).toEqual([2, 4])
  })

  it('검출을 건너뛰는 프레임이 있으면 그 간격으로 견준다', () => {
    const finder = new SceneCutFinder(2)
    finder.add(0, classroom)
    finder.add(2, classroom)
    finder.add(4, hallway)
    expect(finder.cuts).toEqual([4])
  })

  it('프레임이 속한 장면의 범위를 찾는다', () => {
    expect(sceneRange([], 10, 100)).toEqual({ start: 0, end: 100 })
    expect(sceneRange([20, 50], 10, 100)).toEqual({ start: 0, end: 20 })
    expect(sceneRange([20, 50], 20, 100)).toEqual({ start: 20, end: 50 })
    expect(sceneRange([20, 50], 49, 100)).toEqual({ start: 20, end: 50 })
    expect(sceneRange([20, 50], 99, 100)).toEqual({ start: 50, end: 100 })
  })
})
