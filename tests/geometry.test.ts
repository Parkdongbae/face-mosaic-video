import { describe, expect, it } from 'vitest'
import {
  clampRect,
  displayToSource,
  expandRect,
  isInRegions,
  pointInPolygon,
  rectFromPoints,
  snapRectOutward,
  sourceRectToDisplay,
  tileLayout,
} from '../src/core/geometry'

describe('영역 판정', () => {
  const region = { x: 100, y: 100, width: 200, height: 100 }

  it('얼굴 상자의 중심이 영역 안이면 대상', () => {
    expect(isInRegions({ x: 80, y: 90, width: 60, height: 60 }, [region])).toBe(true)
  })

  it('상자가 걸쳐 있어도 중심이 밖이면 대상이 아니다', () => {
    expect(isInRegions({ x: 30, y: 90, width: 60, height: 60 }, [region])).toBe(false)
  })

  it('영역이 없으면 화면 전체가 대상', () => {
    expect(isInRegions({ x: 0, y: 0, width: 10, height: 10 }, [])).toBe(true)
  })

  it('여러 영역 중 하나에만 들어도 대상', () => {
    expect(isInRegions({ x: 500, y: 500, width: 20, height: 20 }, [region, { x: 480, y: 480, width: 100, height: 100 }])).toBe(true)
  })
})

describe('다각형 판정(레이 캐스팅)', () => {
  const triangle = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 0, y: 100 },
  ]
  const concave = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 50, y: 40 },
    { x: 0, y: 100 },
  ]

  it('안쪽 점', () => {
    expect(pointInPolygon({ x: 20, y: 20 }, triangle)).toBe(true)
  })
  it('바깥 점', () => {
    expect(pointInPolygon({ x: 80, y: 80 }, triangle)).toBe(false)
  })
  it('오목한 부분은 바깥', () => {
    expect(pointInPolygon({ x: 50, y: 80 }, concave)).toBe(false)
    expect(pointInPolygon({ x: 50, y: 20 }, concave)).toBe(true)
  })
  it('꼭짓점이 3개 미만이면 항상 false', () => {
    expect(pointInPolygon({ x: 0, y: 0 }, triangle.slice(0, 2))).toBe(false)
  })
})

describe('상자 넓히기·자르기', () => {
  it('공간 여유만큼 사방으로 넓힌다', () => {
    expect(expandRect({ x: 100, y: 100, width: 100, height: 200 }, 0.25, 1000, 1000)).toEqual({
      x: 75,
      y: 50,
      width: 150,
      height: 300,
    })
  })
  it('프레임 밖으로 나가면 잘라 맞춘다', () => {
    expect(expandRect({ x: 0, y: 0, width: 100, height: 100 }, 0.5, 120, 120)).toEqual({ x: 0, y: 0, width: 120, height: 120 })
  })
  it('완전히 밖이면 null', () => {
    expect(clampRect({ x: -50, y: 0, width: 40, height: 10 }, 100, 100)).toBeNull()
  })
  it('정수 픽셀로 맞출 때 바깥쪽으로 넓힌다', () => {
    expect(snapRectOutward({ x: 10.6, y: 20.2, width: 30.1, height: 9.9 }, 100, 100)).toEqual({ x: 10, y: 20, width: 31, height: 11 })
  })
  it('끌기 방향과 관계없이 같은 사각형', () => {
    expect(rectFromPoints({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 40, height: 60 })
  })
})

describe('화면 좌표 <-> 원본 좌표', () => {
  it('화면 점을 원본 픽셀로 바꾼다', () => {
    expect(displayToSource({ x: 320, y: 90 }, 640, 360, 1920, 1080)).toEqual({ x: 960, y: 270 })
  })
  it('화면 밖 점은 영상 안으로 자른다', () => {
    expect(displayToSource({ x: -10, y: 400 }, 640, 360, 1920, 1080)).toEqual({ x: 0, y: 1080 })
  })
  it('원본 사각형을 화면으로 바꾸고 되돌리면 같다', () => {
    const source = { x: 300, y: 150, width: 600, height: 450 }
    const shown = sourceRectToDisplay(source, 640, 360, 1920, 1080)
    expect(shown).toEqual({ x: 100, y: 50, width: 200, height: 150 })
    const topLeft = displayToSource({ x: shown.x, y: shown.y }, 640, 360, 1920, 1080)
    expect(topLeft).toEqual({ x: 300, y: 150 })
  })
})

describe('타일 분할', () => {
  it('2x2 타일이 프레임 전체를 덮고 약 20% 겹친다', () => {
    const tiles = tileLayout(1920, 1080, 2, 2, 0.2)
    expect(tiles).toHaveLength(4)
    const first = tiles[0]!
    const second = tiles[1]!
    expect(first.x).toBe(0)
    expect(second.x + second.width).toBe(1920)
    const overlap = first.x + first.width - second.x
    expect(overlap / first.width).toBeGreaterThan(0.19)
    expect(overlap / first.width).toBeLessThan(0.21)
    const last = tiles[3]!
    expect(last.y + last.height).toBe(1080)
  })
  it('격자가 0이면 타일 없음', () => {
    expect(tileLayout(1920, 1080, 0, 0, 0.2)).toEqual([])
  })
  it('모든 타일이 프레임 안에 있다', () => {
    for (const tile of tileLayout(1281, 721, 3, 3, 0.2)) {
      expect(tile.x).toBeGreaterThanOrEqual(0)
      expect(tile.y).toBeGreaterThanOrEqual(0)
      expect(tile.x + tile.width).toBeLessThanOrEqual(1281)
      expect(tile.y + tile.height).toBeLessThanOrEqual(721)
    }
  })
})
