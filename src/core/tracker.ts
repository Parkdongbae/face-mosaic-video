import { expandRect, lerpRect, rectCenter, rectIou, snapRectOutward, unionRect, type Rect } from './geometry'
import { sceneRange } from './scene'

/** 한 프레임에서의 얼굴 위치. frame 은 해독 순서의 프레임 번호(0부터). */
export interface TrackPoint {
  frame: number
  box: Rect
  score: number
  /** 확대(타일) 검출에서만 잡힌 점이면 true (전체 화면 검출에서도 잡혔으면 없음) */
  tile?: boolean
  /** 감도 기준값에 못 미치는 약한 검출로 이어 붙인 점이면 true */
  weak?: boolean
}

/** 같은 얼굴로 이어 붙인 검출 묶음. JSON 으로 그대로 저장할 수 있다(glm.md 4-4). */
export interface FaceTrack {
  id: number
  points: TrackPoint[]
  /**
   * 장면이 바뀐 뒤 약한 검출로만 이어져서 따로 떼어 낸 구간이면, 그 앞 구간의 추적 번호(splitWeakTailsAtCuts).
   * 가림을 지울 때는 앞 구간과 따로 다루고, 얼굴인지 아닌지는 앞 구간과 한 묶음으로 판단한다.
   */
  after?: number
}

export interface TrackerOptions {
  /** 이 프레임 수까지 검출이 끊겨도 같은 얼굴로 이어 붙인다. */
  maxGapFrames: number
  /** 이 값 이상 겹치면 같은 얼굴 후보 */
  minIou?: number
  /**
   * 이 점수 이상의 검출만 새 얼굴이 된다. 그보다 낮은(약한) 검출은 이미 찾은 얼굴을 이어 가는 데만 쓴다.
   * 고개를 돌리거나 숙이면 점수가 기준값 아래로 떨어지지만 0이 되지는 않으므로, 그 프레임들을 버리지 않고 잇는다.
   * 없으면 모든 검출을 강한 검출로 본다.
   */
  strongScore?: number
  /** 약한 검출로 이어 붙일 수 있는 최대 공백(프레임). 없으면 maxGapFrames 와 같다. */
  weakGapFrames?: number
  /** 초당 프레임 수. 공백이 길수록 더 멀리 떨어진 검출도 같은 얼굴로 보는 데 쓴다. 없으면 30. */
  fps?: number
  /**
   * 장면이 바뀐 뒤에는 이 프레임 수 안에 다시 잡힌 얼굴만 이어 붙인다. 없으면 maxGapFrames 와 같다.
   * 강한 검출은 조금 움직인 자리에서도 잇고, 약한 검출은 거의 같은 자리·크기일 때만 잇는다.
   * 장면 전환 판단이 틀렸을 때(카메라를 아주 빠르게 돌렸거나 조명·화면 밝기가 갑자기 바뀐 경우)에도
   * 바로 다시 잡히는 얼굴은 끊기지 않게 하려는 것이다.
   */
  cutGapFrames?: number
}

interface Candidate {
  track: FaceTrack
  detection: number
  score: number
}

type Detection = Rect & { score: number; tileOnly?: boolean }

/** 공백이 없을 때, 중심이 얼굴 크기의 이 배율 안에 있으면 같은 얼굴 후보 */
const BASE_REACH = 0.6
/** 공백 1초마다 늘어나는 배율(그동안 고개나 몸이 움직였을 수 있다) */
const REACH_PER_SEC = 0.2
const MAX_REACH = 1
/** 약한 검출은 상자 넓이가 기준 상자의 이 범위 안일 때만 같은 얼굴로 본다(턱·이마만 잡힌 조각이나 엉뚱하게 큰 상자를 거른다). */
const WEAK_AREA_RANGE = { min: 0.4, max: 2.5 }
/**
 * 장면이 바뀐 뒤의 약한 검출은 앞 장면의 얼굴 상자와 이만큼 이상 겹칠 때만 같은 얼굴로 본다(중심이 얼굴 크기의 1/3 안).
 * 정말 장면이 바뀌었다면 같은 자리에 같은 크기의 얼굴 후보가 있을 일이 드물고,
 * 조명이 바뀌었거나 화면이 번쩍인 것을 장면 전환으로 잘못 본 것이라면 얼굴은 제자리에 그대로 있다.
 */
const AFTER_CUT_WEAK_IOU = 0.5

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
 *
 * 검출은 두 단계로 잇는다: 먼저 강한 검출을 추적에 붙이고, 남은 추적에 약한 검출을 붙인다.
 * 약한 검출은 새 추적을 만들지 못하므로 헛검출이 늘지 않으면서, 점수가 떨어진 프레임의 얼굴은 계속 따라간다.
 */
export class FaceTracker {
  private readonly tracks: FaceTrack[] = []
  private active: FaceTrack[] = []
  private nextId = 1
  private readonly maxGapFrames: number
  private readonly weakGapFrames: number
  private readonly minIou: number
  private readonly strongScore: number
  private readonly fps: number
  private readonly cutGapFrames: number
  /** 장면이 바뀌기 전에 시작된 추적들. 바뀐 뒤 곧바로 강한 검출로 다시 잡히지 않으면 끝난 것으로 본다. */
  private readonly beforeCut = new Set<FaceTrack>()
  /** 추적마다 마지막 강한 검출의 상자 크기(약한 검출의 상자가 얼굴보다 작게 잡혀도 가림이 줄지 않게 한다) */
  private readonly strongSize = new Map<FaceTrack, { width: number; height: number }>()

  constructor(options: TrackerOptions) {
    this.maxGapFrames = options.maxGapFrames
    this.weakGapFrames = Math.min(options.weakGapFrames ?? options.maxGapFrames, options.maxGapFrames)
    this.minIou = options.minIou ?? 0.15
    this.strongScore = options.strongScore ?? 0
    this.fps = options.fps && options.fps > 0 ? options.fps : 30
    this.cutGapFrames = Math.min(options.cutGapFrames ?? options.maxGapFrames, options.maxGapFrames)
  }

  update(frame: number, detections: Detection[]): void {
    this.active = this.active.filter((track) => {
      const last = track.points[track.points.length - 1]!
      const limit = this.beforeCut.has(track) ? this.cutGapFrames : this.maxGapFrames
      const alive = frame - last.frame <= limit + 1
      if (!alive) {
        this.strongSize.delete(track)
        this.beforeCut.delete(track)
      }
      return alive
    })

    const strong: number[] = []
    const weak: number[] = []
    detections.forEach((detection, index) => (detection.score >= this.strongScore ? strong : weak).push(index))

    const usedTracks = new Set<FaceTrack>()
    const usedDetections = new Set<number>()
    this.assign(frame, detections, strong, false, usedTracks, usedDetections)
    this.assign(frame, detections, weak, true, usedTracks, usedDetections)

    for (const index of strong) {
      if (usedDetections.has(index)) continue
      const detection = detections[index]!
      const track: FaceTrack = { id: this.nextId, points: [toPoint(frame, detection, detection, false)] }
      this.nextId += 1
      this.tracks.push(track)
      this.active.push(track)
      this.strongSize.set(track, { width: detection.width, height: detection.height })
    }
  }

  /**
   * 장면이 바뀌었다. 지금까지의 얼굴은 곧바로(cutGapFrames 안에) 다시 잡힐 때만 이어 붙인다.
   * 바뀐 장면의 같은 자리에는 다른 것이 있으므로 오래 끊긴 얼굴을 되살리지 않고,
   * 약한 검출은 거의 같은 자리·크기일 때만 잇는다(강한 검출로 다시 잡히기 전까지).
   */
  cut(): void {
    for (const track of this.active) this.beforeCut.add(track)
  }

  finish(): FaceTrack[] {
    return this.tracks
  }

  /** 아직 짝이 없는 추적과 주어진 검출들을 가장 잘 맞는 쌍부터 잇는다. */
  private assign(
    frame: number,
    detections: Detection[],
    indices: number[],
    weak: boolean,
    usedTracks: Set<FaceTrack>,
    usedDetections: Set<number>,
  ): void {
    if (indices.length === 0) return
    const candidates: Candidate[] = []
    for (const track of this.active) {
      if (usedTracks.has(track)) continue
      const lastPoint = track.points[track.points.length - 1]!
      const gapFrames = frame - lastPoint.frame - 1
      // 장면이 바뀌기 전의 추적은 cutGapFrames 를 넘겨 끊기면 위(update)에서 이미 끝난 것으로 치웠다.
      const afterCut = this.beforeCut.has(track)
      if (weak && gapFrames > this.weakGapFrames) continue
      const predicted = predict(track, frame)
      const last = lastPoint.box
      // 약한 검출은 바로 그 자리에 있을 때만 잇고, 강한 검출은 끊긴 시간이 길수록 조금 더 멀리까지 같은 얼굴로 본다.
      const reachRatio = weak ? BASE_REACH : Math.min(MAX_REACH, BASE_REACH + REACH_PER_SEC * (Math.max(0, gapFrames) / this.fps))
      const reference = this.strongSize.get(track) ?? last
      for (const index of indices) {
        const detection = detections[index]!
        if (weak) {
          const areaRatio = (detection.width * detection.height) / Math.max(1, reference.width * reference.height)
          if (areaRatio < WEAK_AREA_RANGE.min || areaRatio > WEAK_AREA_RANGE.max) continue
          if (afterCut && rectIou(last, atLeast(detection, reference)) < AFTER_CUT_WEAK_IOU) continue
        }
        let score = Math.max(rectIou(predicted, detection), rectIou(last, detection))
        if (score < this.minIou) {
          // 빠르게 움직여 겹침이 적어도, 중심이 얼굴 크기 안에 있으면 같은 얼굴로 본다.
          const a = rectCenter(predicted)
          const b = rectCenter(detection)
          const distance = Math.hypot(a.x - b.x, a.y - b.y)
          const reach = Math.max(last.width, last.height, detection.width, detection.height) * reachRatio
          const sizeRatio = Math.max(last.width, detection.width) / Math.max(1, Math.min(last.width, detection.width))
          if (distance > reach || sizeRatio > 2) continue
          score = this.minIou * (1 - distance / reach)
        }
        candidates.push({ track, detection: index, score })
      }
    }
    candidates.sort((a, b) => b.score - a.score)

    for (const candidate of candidates) {
      if (usedTracks.has(candidate.track) || usedDetections.has(candidate.detection)) continue
      usedTracks.add(candidate.track)
      usedDetections.add(candidate.detection)
      const detection = detections[candidate.detection]!
      if (weak) {
        // 약한 검출은 얼굴의 일부만 잡는 일이 있다. 중심은 따르되 크기는 마지막 강한 검출보다 작아지지 않게 한다.
        const reference = this.strongSize.get(candidate.track)
        candidate.track.points.push(toPoint(frame, detection, reference ? atLeast(detection, reference) : detection, true))
      } else {
        candidate.track.points.push(toPoint(frame, detection, detection, false))
        this.strongSize.set(candidate.track, { width: detection.width, height: detection.height })
        // 장면이 바뀐 뒤에도 바로 다시 잡혔다: 같은 장면이 이어진 것으로 본다.
        this.beforeCut.delete(candidate.track)
      }
    }
  }
}

/**
 * 장면이 바뀐 뒤 약한 검출로만 이어진 구간을 따로 떼어 새 번호를 준다(추적이 모두 끝난 뒤에 부른다).
 *
 * 추적기는 장면이 바뀐 뒤에도 제자리에 그대로 있는 얼굴 후보를 약한 검출로 이어 간다. 조명이 바뀐 것을 장면 전환으로
 * 잘못 봤다면 같은 얼굴이므로 계속 가려야 하기 때문이다. 하지만 정말 장면이 바뀐 것이라면 그 자리의 다른 것일 수 있다.
 * 한 번호로 묶여 있으면, 사용자가 바뀐 장면에서 그 가림을 지울 때 앞 장면의 진짜 얼굴 가림까지 함께 지워진다.
 * 그래서 강한 검출로 다시 확인되지 않은 구간은 번호를 나눠 두고, 어느 구간에서 갈라졌는지만 after 로 남긴다.
 * 강한 검출로 다시 잡힌 추적은 같은 얼굴로 보고 나누지 않는다.
 */
export function splitWeakTailsAtCuts(tracks: FaceTrack[], sceneCuts: readonly number[]): FaceTrack[] {
  if (sceneCuts.length === 0) return tracks
  const cuts = [...sceneCuts].sort((a, b) => a - b)
  /** from 프레임 뒤부터 to 프레임까지 사이에 새 장면이 시작되는지 */
  const cutBetween = (from: number, to: number): boolean => {
    let low = 0
    let high = cuts.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((cuts[middle] ?? 0) <= from) low = middle + 1
      else high = middle
    }
    return low < cuts.length && (cuts[low] ?? Infinity) <= to
  }
  let nextId = tracks.reduce((max, track) => Math.max(max, track.id), 0) + 1
  const result: FaceTrack[] = []
  for (const track of tracks) {
    let lastStrong = -1
    track.points.forEach((point, index) => {
      if (!point.weak) lastStrong = index
    })
    const starts: number[] = []
    for (let index = Math.max(1, lastStrong + 1); index < track.points.length; index += 1) {
      if (cutBetween(track.points[index - 1]!.frame, track.points[index]!.frame)) starts.push(index)
    }
    if (starts.length === 0) {
      result.push(track)
      continue
    }
    let previous: FaceTrack = { ...track, points: track.points.slice(0, starts[0]) }
    result.push(previous)
    starts.forEach((start, order) => {
      const piece: FaceTrack = { id: nextId, points: track.points.slice(start, starts[order + 1]), after: previous.id }
      nextId += 1
      result.push(piece)
      previous = piece
    })
  }
  return result
}

/** 중심은 그대로 두고 크기가 주어진 값보다 작지 않게 한 상자 */
function atLeast(box: Rect, size: { width: number; height: number }): Rect {
  const width = Math.max(box.width, size.width)
  const height = Math.max(box.height, size.height)
  return { x: box.x + box.width / 2 - width / 2, y: box.y + box.height / 2 - height / 2, width, height }
}

function toPoint(frame: number, detection: Detection, box: Rect, weak: boolean): TrackPoint {
  const point: TrackPoint = { frame, box: toRect(box), score: detection.score }
  if (detection.tileOnly) point.tile = true
  if (weak) point.weak = true
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
  /**
   * 보간 한도를 넘는 공백도 이 프레임 수까지는 계속 가린다(없거나 0이면 하지 않는다).
   * 그 사이 얼굴이 어디 있었는지 모르므로 양쪽 위치를 아우르는 범위를 가린다(bridgeBox).
   */
  bridgeFrames?: number
  /** 공백을 이어 가리는 상자를 그 프레임에 가려도 되는지(영역 규칙). 없으면 항상 가린다. trackId 는 그 상자가 속한 추적의 번호. */
  acceptBridge?: (frame: number, box: Rect, trackId: number) => boolean
  /** 새 장면이 시작되는 프레임 번호들(오름차순). 오래 끊긴 사이를 이어 가리는 일은 장면 경계를 넘지 않는다. */
  sceneCuts?: number[]
}

/** 가릴 사각형 + 어느 추적에서 나왔는지(검토 화면에서 눌러서 지울 때 쓴다) */
export interface MaskBox extends Rect {
  trackId: number
}

/** 가림 계획을 만들 때 쓰는 추적 */
export interface PlanTrack extends FaceTrack {
  /**
   * 장면 전환에서 번호만 나눈 구간(after)이면 앞 구간의 마지막 점.
   * 있으면 그 점에서 이 구간의 첫 점까지를 보간으로 채운다(번호를 나누기 전과 똑같이 끊김 없이 가리기 위해).
   */
  joinFrom?: TrackPoint
}

/**
 * 추적 결과를 프레임별 "가릴 사각형 목록"으로 바꾼다.
 * - 검출 사이 빈 프레임: 앞뒤 위치로 선형 보간
 * - 보간 한도를 넘지만 bridgeFrames 이내인 공백: 그 사이도 계속 가림(bridgeBox)
 * - 장면이 바뀌는 곳을 건너서는 이어 가리지 않음(바뀐 장면의 같은 자리에는 다른 것이 있다)
 * - 시간 여유: 첫 검출 앞, 마지막 검출 뒤 padFrames 만큼 같은 위치를 가림
 * - 공간 여유: marginRatio 만큼 넓히고 프레임 안으로 자름
 * 돌려주는 배열의 index 는 프레임 번호다. 프레임 이미지는 다루지 않는다.
 */
export function buildMaskPlan(tracks: PlanTrack[], options: MaskPlanOptions): Rect[][] {
  return buildTrackedMaskPlan(tracks, options).map((boxes) =>
    boxes.map(({ x, y, width, height }) => ({ x, y, width, height })),
  )
}

/**
 * 양쪽 위치의 중심이 얼굴 크기의 이 배율 안이면 두 상자를 통째로 덮는다.
 * 추적기가 끊긴 얼굴을 다시 잇는 거리(얼굴 크기의 1배 이내)를 모두 포함하므로, 추적기가 이은 공백은 사실상 늘 통째로 덮인다.
 */
const BRIDGE_UNION_REACH = 1.25

/**
 * 검출이 오래 끊긴 사이에 가릴 상자. 그동안 얼굴이 어디 있었는지는 모른다.
 * - 양쪽 위치가 가까우면(제자리에서 고개를 돌리거나 자세를 고친 경우): 양쪽 상자를 모두 덮는 범위를 가린다.
 *   얼굴이 언제 옮겨 갔는지 모르므로, 옮겨 가는 길 전체를 덮는 쪽이 안전하다.
 * - 멀면(직접 추가한 얼굴처럼 멀리 떨어진 두 점): 한쪽에서 다른 쪽으로 옮겨 가는 것으로 보고 큰 쪽 크기의 상자를 움직인다.
 *   멀리 떨어진 두 상자를 통째로 덮으면 화면의 큰 부분이 가려지기 때문이다.
 */
function bridgeBox(a: Rect, b: Rect, t: number): Rect {
  const from = rectCenter(a)
  const to = rectCenter(b)
  const size = Math.max(a.width, a.height, b.width, b.height)
  if (Math.hypot(from.x - to.x, from.y - to.y) <= size * BRIDGE_UNION_REACH) return unionRect(a, b)
  const width = Math.max(a.width, b.width)
  const height = Math.max(a.height, b.height)
  const x = from.x + (to.x - from.x) * t
  const y = from.y + (to.y - from.y) * t
  return { x: x - width / 2, y: y - height / 2, width, height }
}

/** buildMaskPlan 과 같지만 사각형마다 추적 번호(trackId)가 붙는다. */
export function buildTrackedMaskPlan(tracks: PlanTrack[], options: MaskPlanOptions): MaskBox[][] {
  const plan: MaskBox[][] = Array.from({ length: options.frameCount }, () => [])
  const bridgeFrames = options.bridgeFrames ?? 0
  const cuts = options.sceneCuts ?? []
  /** 두 프레임이 같은 장면에 있는지 */
  const sameScene = (from: number, to: number): boolean => cuts.length === 0 || sceneRange(cuts, from, options.frameCount).end > to
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

    // 장면 전환에서 번호만 나눈 구간은 앞 구간의 마지막 점에서 이어서 보간한다.
    // (짧게 끊긴 사이의 보간은 장면 경계와 무관하다. 번호를 나눴다고 그 사이가 비면 안 된다.)
    const join = track.joinFrom
    const joinGap = join ? first.frame - join.frame : 0
    if (join && joinGap >= 1 && joinGap - 1 <= options.maxGapFrames) {
      for (let frame = join.frame + 1; frame < first.frame; frame += 1) {
        put(frame, lerpRect(join.box, first.box, (frame - join.frame) / joinGap))
      }
    } else {
      for (let frame = first.frame - options.padFrames; frame < first.frame; frame += 1) put(frame, first.box)
    }
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
        continue
      }
      // 긴 공백: 이어 가릴 수 있으면 그 사이를 계속 가리고, 아니면 양쪽에 시간 여유만 준다.
      const bridge = gap - 1 <= bridgeFrames && sameScene(current.frame, next.frame)
      for (let frame = current.frame + 1; frame < next.frame; frame += 1) {
        const cover = bridge ? bridgeBox(current.box, next.box, (frame - current.frame) / gap) : null
        if (cover && (!options.acceptBridge || options.acceptBridge(frame, cover, trackId))) {
          put(frame, cover)
          continue
        }
        if (frame - current.frame <= options.padFrames) put(frame, current.box)
        if (next.frame - frame <= options.padFrames) put(frame, next.box)
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
