import { expandRect, lerpRect, rectCenter, rectIou, snapRectOutward, type Rect } from './geometry'

/** 한 프레임에서의 얼굴 위치. frame 은 해독 순서의 프레임 번호(0부터). */
export interface TrackPoint {
  frame: number
  box: Rect
  score: number
  /** 확대(타일) 검출에서만 잡힌 점이면 true (전체 화면 검출에서도 잡혔으면 없음) */
  tile?: boolean
}

/** 같은 얼굴로 이어 붙인 검출 묶음. JSON 으로 그대로 저장할 수 있다(glm.md 4-4). */
export interface FaceTrack {
  id: number
  points: TrackPoint[]
}

export interface TrackerOptions {
  /** 이 프레임 수까지 검출이 끊겨도 같은 얼굴로 이어 붙인다. */
  maxGapFrames: number
  /** 이 값 이상 겹치면 같은 얼굴 후보 */
  minIou?: number
}

interface Candidate {
  track: FaceTrack
  detection: number
  score: number
}

/** 마지막 두 점의 속도로 다음 위치를 어림한다(등속 예측). */
function predict(track: FaceTrack, frame: number): Rect {
  const last = track.points[track.points.length - 1]!
  const previous = track.points[track.points.length - 2]
  if (!previous) return last.box
  const span = last.frame - previous.frame
  if (span <= 0) return last.box
  const step = Math.min(frame - last.frame, 5) / span
  return {
    x: last.box.x + (last.box.x - previous.box.x) * step,
    y: last.box.y + (last.box.y - previous.box.y) * step,
    width: last.box.width,
    height: last.box.height,
  }
}

/**
 * IoU 기반 얼굴 추적기. 프레임 순서대로 update() 를 부르고 끝나면 finish() 로 결과를 받는다.
 * 얼굴이 누구인지는 다루지 않는다(위치 연결만).
 */
export class FaceTracker {
  private readonly tracks: FaceTrack[] = []
  private active: FaceTrack[] = []
  private nextId = 1
  private readonly maxGapFrames: number
  private readonly minIou: number

  constructor(options: TrackerOptions) {
    this.maxGapFrames = options.maxGapFrames
    this.minIou = options.minIou ?? 0.15
  }

  update(frame: number, detections: Array<Rect & { score: number; tileOnly?: boolean }>): void {
    this.active = this.active.filter((track) => {
      const last = track.points[track.points.length - 1]!
      return frame - last.frame <= this.maxGapFrames + 1
    })

    const candidates: Candidate[] = []
    for (const track of this.active) {
      const predicted = predict(track, frame)
      const last = track.points[track.points.length - 1]!.box
      for (let index = 0; index < detections.length; index += 1) {
        const detection = detections[index]!
        let score = Math.max(rectIou(predicted, detection), rectIou(last, detection))
        if (score < this.minIou) {
          // 빠르게 움직여 겹침이 적어도, 중심이 얼굴 크기 안에 있으면 같은 얼굴로 본다.
          const a = rectCenter(predicted)
          const b = rectCenter(detection)
          const distance = Math.hypot(a.x - b.x, a.y - b.y)
          const reach = Math.max(last.width, last.height, detection.width, detection.height) * 0.6
          const sizeRatio = Math.max(last.width, detection.width) / Math.max(1, Math.min(last.width, detection.width))
          if (distance > reach || sizeRatio > 2) continue
          score = this.minIou * (1 - distance / reach)
        }
        candidates.push({ track, detection: index, score })
      }
    }
    candidates.sort((a, b) => b.score - a.score)

    const usedTracks = new Set<FaceTrack>()
    const usedDetections = new Set<number>()
    for (const candidate of candidates) {
      if (usedTracks.has(candidate.track) || usedDetections.has(candidate.detection)) continue
      usedTracks.add(candidate.track)
      usedDetections.add(candidate.detection)
      const detection = detections[candidate.detection]!
      candidate.track.points.push(toPoint(frame, detection))
    }

    for (let index = 0; index < detections.length; index += 1) {
      if (usedDetections.has(index)) continue
      const detection = detections[index]!
      const track: FaceTrack = { id: this.nextId, points: [toPoint(frame, detection)] }
      this.nextId += 1
      this.tracks.push(track)
      this.active.push(track)
    }
  }

  finish(): FaceTrack[] {
    return this.tracks
  }
}

function toPoint(frame: number, detection: Rect & { score: number; tileOnly?: boolean }): TrackPoint {
  const point: TrackPoint = { frame, box: toRect(detection), score: detection.score }
  if (detection.tileOnly) point.tile = true
  return point
}

function toRect(box: Rect): Rect {
  return { x: box.x, y: box.y, width: box.width, height: box.height }
}

export interface MaskPlanOptions {
  frameCount: number
  frameWidth: number
  frameHeight: number
  /** 검출 사이의 빈 프레임을 보간으로 채우는 최대 길이 */
  maxGapFrames: number
  /** 처음 검출 전·마지막 검출 후에 더 가리는 프레임 수(시간 여유) */
  padFrames: number
  /** 상자를 넓히는 비율(공간 여유) */
  marginRatio: number
}

/** 가릴 사각형 + 어느 추적에서 나왔는지(검토 화면에서 눌러서 지울 때 쓴다) */
export interface MaskBox extends Rect {
  trackId: number
}

/**
 * 추적 결과를 프레임별 "가릴 사각형 목록"으로 바꾼다.
 * - 검출 사이 빈 프레임: 앞뒤 위치로 선형 보간
 * - 시간 여유: 첫 검출 앞, 마지막 검출 뒤 padFrames 만큼 같은 위치를 가림
 * - 공간 여유: marginRatio 만큼 넓히고 프레임 안으로 자름
 * 돌려주는 배열의 index 는 프레임 번호다. 프레임 이미지는 다루지 않는다.
 */
export function buildMaskPlan(tracks: FaceTrack[], options: MaskPlanOptions): Rect[][] {
  return buildTrackedMaskPlan(tracks, options).map((boxes) =>
    boxes.map(({ x, y, width, height }) => ({ x, y, width, height })),
  )
}

/** buildMaskPlan 과 같지만 사각형마다 추적 번호(trackId)가 붙는다. */
export function buildTrackedMaskPlan(tracks: FaceTrack[], options: MaskPlanOptions): MaskBox[][] {
  const plan: MaskBox[][] = Array.from({ length: options.frameCount }, () => [])
  let trackId = 0
  const put = (frame: number, box: Rect) => {
    if (frame < 0 || frame >= options.frameCount) return
    const expanded = expandRect(box, options.marginRatio, options.frameWidth, options.frameHeight)
    const snapped = expanded && snapRectOutward(expanded, options.frameWidth, options.frameHeight)
    if (snapped) plan[frame]!.push({ ...snapped, trackId })
  }

  for (const track of tracks) {
    trackId = track.id
    const points = track.points
    const first = points[0]
    const last = points[points.length - 1]
    if (!first || !last) continue

    for (let frame = first.frame - options.padFrames; frame < first.frame; frame += 1) put(frame, first.box)
    for (let index = 0; index < points.length; index += 1) {
      const current = points[index]!
      put(current.frame, current.box)
      const next = points[index + 1]
      if (!next) continue
      const gap = next.frame - current.frame
      if (gap <= 1) continue
      if (gap - 1 <= options.maxGapFrames) {
        for (let frame = current.frame + 1; frame < next.frame; frame += 1) {
          put(frame, lerpRect(current.box, next.box, (frame - current.frame) / gap))
        }
      } else {
        // 너무 긴 공백은 보간하지 않고 양쪽에 시간 여유만 준다.
        for (let offset = 1; offset <= options.padFrames; offset += 1) {
          put(current.frame + offset, current.box)
          put(next.frame - offset, next.box)
        }
      }
    }
    for (let frame = last.frame + 1; frame <= last.frame + options.padFrames; frame += 1) put(frame, last.box)
  }
  return plan
}

/** 오름차순 타임스탬프 배열에서 가장 가까운 값의 index. 비어 있으면 -1. */
export function nearestIndex(sorted: ArrayLike<number>, value: number): number {
  if (sorted.length === 0) return -1
  let low = 0
  let high = sorted.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if ((sorted[middle] ?? 0) < value) low = middle + 1
    else high = middle
  }
  if (low > 0 && Math.abs((sorted[low - 1] ?? 0) - value) <= Math.abs((sorted[low] ?? 0) - value)) return low - 1
  return low
}
