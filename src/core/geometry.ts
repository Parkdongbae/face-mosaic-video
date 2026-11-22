/**
 * 좌표 계산 모음. 내부 좌표는 항상 "회전 적용 후 원본 해상도 픽셀"이다(glm.md 3-3).
 * 화면(CSS 픽셀) 좌표와의 변환은 이 파일의 함수만 쓴다.
 */

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
}

/** 경계 위의 점도 안쪽으로 본다(놓치는 쪽보다 가리는 쪽이 안전). */
export function pointInRect(point: Point, rect: Rect): boolean {
  return (
    point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
  )
}

/** 레이 캐스팅 다각형 판정. 꼭짓점 3개 미만이면 false. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  if (polygon.length < 3) return false
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]!
    const b = polygon[j]!
    const crosses = a.y > point.y !== b.y > point.y
    if (crosses && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** PRD 기준: 얼굴 상자의 중심이 영역 중 하나 안에 있으면 대상. 영역이 없으면 화면 전체가 대상. */
export function isInRegions(box: Rect, regions: Rect[]): boolean {
  if (regions.length === 0) return true
  const center = rectCenter(box)
  return regions.some((region) => pointInRect(center, region))
}

/** 두 점으로 만든 사각형(끌기 방향과 무관하게 정규화). */
export function rectFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

/** 프레임 안으로 잘라 맞춘다. 완전히 밖이면 null. */
export function clampRect(rect: Rect, frameWidth: number, frameHeight: number): Rect | null {
  const left = Math.max(0, rect.x)
  const top = Math.max(0, rect.y)
  const right = Math.min(frameWidth, rect.x + rect.width)
  const bottom = Math.min(frameHeight, rect.y + rect.height)
  if (right - left <= 0 || bottom - top <= 0) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** 상자를 사방으로 ratio 만큼 넓히고(공간 여유) 프레임 안으로 자른다. */
export function expandRect(rect: Rect, ratio: number, frameWidth: number, frameHeight: number): Rect | null {
  const dx = rect.width * ratio
  const dy = rect.height * ratio
  return clampRect(
    { x: rect.x - dx, y: rect.y - dy, width: rect.width + dx * 2, height: rect.height + dy * 2 },
    frameWidth,
    frameHeight,
  )
}

/** 바깥쪽 정수 픽셀로 맞춘다(가리는 범위가 줄어들지 않게 바깥으로 반올림). */
export function snapRectOutward(rect: Rect, frameWidth: number, frameHeight: number): Rect | null {
  const left = Math.max(0, Math.floor(rect.x))
  const top = Math.max(0, Math.floor(rect.y))
  const right = Math.min(frameWidth, Math.ceil(rect.x + rect.width))
  const bottom = Math.min(frameHeight, Math.ceil(rect.y + rect.height))
  if (right - left <= 0 || bottom - top <= 0) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    width: a.width + (b.width - a.width) * t,
    height: a.height + (b.height - a.height) * t,
  }
}

/** 두 사각형을 모두 덮는 가장 작은 사각형 */
export function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function rectIou(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  if (intersection === 0) return 0
  const union = a.width * a.height + b.width * b.height - intersection
  return union <= 0 ? 0 : intersection / union
}

/**
 * 프레임을 cols x rows 로 겹치게 나눈 타일 목록(glm.md 4-2).
 * 이웃 타일과 겹치는 폭이 타일 폭의 overlap 비율이 되도록 타일 크기를 정한다.
 */
export function tileLayout(frameWidth: number, frameHeight: number, cols: number, rows: number, overlap: number): Rect[] {
  if (cols < 1 || rows < 1) return []
  const tileWidth = Math.min(frameWidth, Math.ceil(frameWidth / (cols - (cols - 1) * overlap)))
  const tileHeight = Math.min(frameHeight, Math.ceil(frameHeight / (rows - (rows - 1) * overlap)))
  const tiles: Rect[] = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = cols === 1 ? 0 : Math.round(((frameWidth - tileWidth) * col) / (cols - 1))
      const y = rows === 1 ? 0 : Math.round(((frameHeight - tileHeight) * row) / (rows - 1))
      tiles.push({ x, y, width: tileWidth, height: tileHeight })
    }
  }
  return tiles
}

/** 타일의 한 변이 다른 변보다 이 배율까지 길어지는 것은 받아들인다(그 이상이면 장수를 늘린다). */
const TILE_ASPECT_TOLERANCE = 1.15

/**
 * 타일의 짧은 변이 이 픽셀 수보다 작아지면 장수를 줄인다(모델 입력 640px 기준 2.5배 확대까지).
 * 해상도가 낮은 영상은 더 잘게 나눠 크게 늘려 넣어도 얼굴을 더 찾지 못한다(화면에 담긴 정보가 모자라서다).
 * 측정(2026-11-22, 공개 사진 시험 영상을 360p·480p 로 줄여서): 한도 없이 5x3·4x2 로 나누면 가림률은 거의 같고
 * (360p '보통' 전체 87.2% → 86.5%, 어려운 얼굴 50.0% → 46.9%. '꼼꼼하게'만 89.7% → 90.4%),
 * 분석 시간은 2~3배가 되고 얼굴이 아닌 것을 가리는 넓이도 늘었다.
 */
const MIN_TILE_SHORT_PX = 256

/**
 * 화면의 짧은 변을 across 장으로 나눌 때의 타일 격자.
 * 검출 모델의 입력이 정사각형이므로 타일도 정사각형에 가까워야 입력을 낭비 없이 쓴다.
 * 예) 1920x1080 을 2x2 로 나누면 타일이 16:9 라 입력의 44% 가 빈 여백이 되지만, 4x2 로 나누면 거의 다 쓴다.
 * 긴 변의 장수는 "타일의 긴 변 방향 길이가 짧은 변 방향 길이의 1.15배 이하"가 되는 가장 작은 수로 정한다.
 * 해상도가 낮아 타일이 너무 작아지면 짧은 변의 장수를 줄인다(MIN_TILE_SHORT_PX).
 */
export function tileGrid(frameWidth: number, frameHeight: number, across: number, overlap: number): { cols: number; rows: number } {
  if (across < 1 || frameWidth <= 0 || frameHeight <= 0) return { cols: 0, rows: 0 }
  const landscape = frameWidth >= frameHeight
  const long = landscape ? frameWidth : frameHeight
  const short = landscape ? frameHeight : frameWidth
  const span = (count: number) => count - (count - 1) * overlap
  let count = Math.floor(across)
  while (count > 1 && short / span(count) < MIN_TILE_SHORT_PX) count -= 1
  const shortTile = short / span(count)
  let along = 1
  while (long / span(along) > shortTile * TILE_ASPECT_TOLERANCE && along < 64) along += 1
  return landscape ? { cols: along, rows: count } : { cols: count, rows: along }
}

/** 오름차순 프레임 시각(마이크로초)에서 초당 프레임 수를 어림한다(가변 프레임 영상은 중앙값 기준). 알 수 없으면 30. */
export function frameRateOf(timestampsUs: ArrayLike<number>): number {
  if (timestampsUs.length < 2) return 30
  const deltas: number[] = []
  // 긴 영상에서도 가볍게: 최대 2000개 간격만 고르게 뽑아 본다.
  const step = Math.max(1, Math.floor((timestampsUs.length - 1) / 2000))
  for (let index = 1; index < timestampsUs.length; index += step) {
    const delta = (timestampsUs[index] ?? 0) - (timestampsUs[index - 1] ?? 0)
    if (delta > 0) deltas.push(delta)
  }
  if (deltas.length === 0) return 30
  deltas.sort((a, b) => a - b)
  const median = deltas[deltas.length >> 1] ?? 0
  return median > 0 ? 1e6 / median : 30
}

/** 화면에 표시된 영상 요소 안의 좌표(CSS 픽셀)를 원본 영상 픽셀 좌표로 바꾼다. */
export function displayToSource(point: Point, displayWidth: number, displayHeight: number, sourceWidth: number, sourceHeight: number): Point {
  return {
    x: Math.max(0, Math.min(sourceWidth, (point.x / displayWidth) * sourceWidth)),
    y: Math.max(0, Math.min(sourceHeight, (point.y / displayHeight) * sourceHeight)),
  }
}

/** 원본 영상 픽셀 좌표의 사각형을 화면 표시 좌표(CSS 픽셀)로 바꾼다. */
export function sourceRectToDisplay(rect: Rect, displayWidth: number, displayHeight: number, sourceWidth: number, sourceHeight: number): Rect {
  const sx = displayWidth / sourceWidth
  const sy = displayHeight / sourceHeight
  return { x: rect.x * sx, y: rect.y * sy, width: rect.width * sx, height: rect.height * sy }
}
