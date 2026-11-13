import { pointInPolygon, pointInRect, rectCenter, type Point, type Rect } from './geometry'

/** 영역의 모양. 좌표는 "회전 적용 후 원본 해상도 픽셀". */
export type RegionShape = { kind: 'rect'; rect: Rect } | { kind: 'polygon'; points: Point[] }

/**
 * 사용자가 그린 영역(F-04·F-05·F-06).
 * - exclude 가 false 면 "이 안의 얼굴을 가린다", true 면 "이 안의 얼굴은 가리지 않는다(예: 교사 자리)".
 * - startSec/endSec 은 이 영역을 적용할 구간. null 이면 처음/끝까지.
 */
export interface Region {
  id: string
  shape: RegionShape
  exclude: boolean
  startSec: number | null
  endSec: number | null
}

export function regionContains(region: Region, point: Point): boolean {
  return region.shape.kind === 'rect' ? pointInRect(point, region.shape.rect) : pointInPolygon(point, region.shape.points)
}

export function regionActive(region: Region, timeSec: number): boolean {
  if (region.startSec !== null && timeSec < region.startSec) return false
  if (region.endSec !== null && timeSec > region.endSec) return false
  return true
}

/**
 * 이 시각에 이 얼굴 상자를 가려야 하는지.
 * - 얼굴 상자의 중심이 포함 영역 중 하나 안에 있으면 대상. 포함 영역을 하나도 그리지 않았으면 화면 전체가 대상.
 * - 제외 영역 안이면 포함 영역보다 우선해서 대상이 아니다(glm.md 4-3).
 * - 포함 영역을 그렸지만 이 시각에 적용되는 것이 없으면 대상이 아니다(구간 밖).
 */
export function isTarget(box: Rect, regions: Region[], timeSec: number): boolean {
  const center = rectCenter(box)
  const includes = regions.filter((region) => !region.exclude)
  const inExclude = regions.some((region) => region.exclude && regionActive(region, timeSec) && regionContains(region, center))
  if (inExclude) return false
  if (includes.length === 0) return true
  return includes.some((region) => regionActive(region, timeSec) && regionContains(region, center))
}

export function regionBounds(region: Region): Rect {
  if (region.shape.kind === 'rect') return region.shape.rect
  const xs = region.shape.points.map((point) => point.x)
  const ys = region.shape.points.map((point) => point.y)
  const left = Math.min(...xs)
  const top = Math.min(...ys)
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top }
}

/** 영역을 통째로 옮긴다. 프레임 밖으로 나가지 않게 이동량을 줄인다. */
export function translateRegion(region: Region, dx: number, dy: number, frameWidth: number, frameHeight: number): Region {
  const bounds = regionBounds(region)
  const moveX = Math.max(-bounds.x, Math.min(dx, frameWidth - (bounds.x + bounds.width)))
  const moveY = Math.max(-bounds.y, Math.min(dy, frameHeight - (bounds.y + bounds.height)))
  if (region.shape.kind === 'rect') {
    const rect = region.shape.rect
    return { ...region, shape: { kind: 'rect', rect: { ...rect, x: rect.x + moveX, y: rect.y + moveY } } }
  }
  return {
    ...region,
    shape: { kind: 'polygon', points: region.shape.points.map((point) => ({ x: point.x + moveX, y: point.y + moveY })) },
  }
}

let regionCounter = 0

export function newRegionId(): string {
  regionCounter += 1
  return `r${Date.now().toString(36)}${regionCounter}`
}

export function rectRegion(rect: Rect, exclude = false): Region {
  return { id: newRegionId(), shape: { kind: 'rect', rect }, exclude, startSec: null, endSec: null }
}

export function polygonRegion(points: Point[], exclude = false): Region {
  return { id: newRegionId(), shape: { kind: 'polygon', points }, exclude, startSec: null, endSec: null }
}
