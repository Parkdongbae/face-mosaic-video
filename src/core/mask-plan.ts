import { BASE_FPS, MOSAIC_DEFAULTS } from '../config/mosaic-defaults'
import { keepFaces, type FalsePositiveFilter } from './false-positive'
import { frameRateOf, rectIou, type Rect } from './geometry'
import { isTarget, type Region } from './regions'
import { buildTrackedMaskPlan, nearestIndex, type FaceTrack, type MaskBox, type PlanTrack, type TrackPoint } from './tracker'

/** 사용자가 직접 추가한 얼굴. 프레임 번호가 아니라 시각으로 저장해 프로젝트 파일로 옮길 수 있게 한다. */
export interface ManualTrack {
  /** 음수(자동 검출 추적의 번호와 겹치지 않게) */
  id: number
  points: Array<{ timeUs: number; box: Rect }>
}

/** 검토 단계에서 사용자가 고친 내용(F-11) */
export interface Edits {
  manualTracks: ManualTrack[]
  /** 잘못 잡혀서 가리지 않기로 한 자동 검출 추적의 번호 */
  removedTrackIds: number[]
}

export const NO_EDITS: Edits = { manualTracks: [], removedTrackIds: [] }

export interface PlanSource {
  width: number
  height: number
  frameCount: number
  timestampsUs: number[]
  tracks: FaceTrack[]
  /** 새 장면이 시작되는 프레임 번호들(오름차순). 없으면 영상 전체를 한 장면으로 본다. */
  sceneCuts?: number[]
}

export interface PlanSettings {
  regions: Region[]
  /** 검출 사이의 빈 프레임을 보간으로 채우는 최대 길이(30fps 기준 프레임 수. 다른 프레임 속도는 같은 시간이 되게 맞춘다) */
  maxGapFrames: number
  /** 처음 검출 전·마지막 검출 후에 더 가리는 길이(30fps 기준 프레임 수) */
  padFrames: number
  marginRatio: number
  /** 얼굴이 아닌 것 거르기. 없으면 '보통'. */
  falsePositiveFilter?: FalsePositiveFilter
  /** 검출이 끊겼다 다시 잡힌 사이를 계속 가리는 최대 시간(초). 없으면 기본값, 0이면 하지 않는다. */
  bridgeMaxSec?: number
}

/**
 * 실제로 가릴 추적 목록을 고른다.
 * - 자동 검출: 사용자가 지운 것은 빼고, 각 검출을 그 시각의 영역 규칙(포함·제외·구간)으로 거른다.
 *   영역 규칙 때문에 중간이 빠진 추적은 그 자리에서 나눈다(빠진 구간을 건너 이어 가리지 않도록).
 * - 자동 검출 가운데 얼굴이 아닌 것으로 보이는 추적은 뺀다(false-positive.ts).
 * - 수동 추가: 사용자가 직접 표시한 것이므로 영역과 무관하게 항상 가린다.
 */
export function selectTracks(
  source: PlanSource,
  regions: Region[],
  edits: Edits = NO_EDITS,
  filter: FalsePositiveFilter = 'normal',
): PlanTrack[] {
  const removed = new Set(edits.removedTrackIds)
  const selected: PlanTrack[] = []
  const kept = keepFaces(source.tracks, source.width, source.height, filter, frameRateOf(source.timestampsUs))
  const keptById = new Map(kept.map((track) => [track.id, track]))
  const targetAt = (point: TrackPoint) => isTarget(point.box, regions, (source.timestampsUs[point.frame] ?? 0) / 1e6)
  for (const track of kept) {
    if (removed.has(track.id)) continue
    // 장면 전환에서 번호만 나눈 구간이면 앞 구간의 마지막 점에서 이어서 가린다.
    // 앞 구간을 사용자가 지웠거나 그 점이 가릴 대상이 아니면(영역 규칙) 잇지 않는다.
    const parent = track.after !== undefined && !removed.has(track.after) ? keptById.get(track.after) : undefined
    const parentLast = parent?.points[parent.points.length - 1]
    const joinFrom = parentLast && targetAt(parentLast) ? parentLast : undefined
    const push = (points: TrackPoint[], fromStart: boolean) => {
      selected.push(fromStart && joinFrom ? { id: track.id, points, joinFrom } : { id: track.id, points })
    }
    let run: TrackPoint[] = []
    // 지금 모으는 구간이 이 추적의 첫 점부터 이어진 것인지
    let fromStart = true
    for (const point of track.points) {
      if (targetAt(point)) {
        run.push(point)
        continue
      }
      if (run.length > 0) push(run, fromStart)
      run = []
      fromStart = false
    }
    if (run.length > 0) push(run, fromStart)
  }
  for (const manual of edits.manualTracks) {
    const byFrame = new Map<number, Rect>()
    for (const point of manual.points) {
      const frame = nearestIndex(source.timestampsUs, point.timeUs)
      if (frame >= 0) byFrame.set(frame, point.box)
    }
    const points = [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([frame, box]) => ({ frame, box, score: 1 }))
    if (points.length > 0) selected.push({ id: manual.id, points })
  }
  return selected
}

/** 프레임별로 가릴 사각형 목록(어느 추적에서 나왔는지 포함). 미리보기와 저장이 똑같이 이 함수를 쓴다. */
export function planMasks(source: PlanSource, settings: PlanSettings, edits: Edits = NO_EDITS): MaskBox[][] {
  // 프레임 수로 적은 기준은 30fps 기준이다. 60fps 영상에서 가리는 시간이 절반이 되지 않도록 시간으로 맞춘다.
  const fps = frameRateOf(source.timestampsUs)
  const frames = (count: number) => Math.max(0, Math.round((count * fps) / BASE_FPS))
  const bridgeSec = settings.bridgeMaxSec ?? MOSAIC_DEFAULTS.bridgeMaxSec
  const regions = settings.regions
  return buildTrackedMaskPlan(selectTracks(source, regions, edits, settings.falsePositiveFilter ?? 'normal'), {
    frameCount: source.frameCount,
    frameWidth: source.width,
    frameHeight: source.height,
    maxGapFrames: frames(settings.maxGapFrames),
    padFrames: frames(settings.padFrames),
    marginRatio: settings.marginRatio,
    bridgeFrames: Math.round(bridgeSec * fps),
    // 이어 가리는 범위의 중심이 제외 영역 안이거나 포함 영역 밖이면 그 프레임은 이어 가리지 않는다.
    // 직접 추가한 얼굴(번호가 음수)은 영역과 무관하게 항상 가린다.
    acceptBridge: (frame, box, trackId) =>
      trackId < 0 || regions.length === 0 || isTarget(box, regions, (source.timestampsUs[frame] ?? 0) / 1e6),
    sceneCuts: source.sceneCuts ?? [],
  })
}

/** 영역 규칙 때문에 가리지 않게 된 검출 수(안내 문구용) */
export function countOutside(source: PlanSource, regions: Region[]): number {
  let outside = 0
  for (const track of source.tracks) {
    for (const point of track.points) {
      if (!isTarget(point.box, regions, (source.timestampsUs[point.frame] ?? 0) / 1e6)) outside += 1
    }
  }
  return outside
}

/** 끊긴 추적을 같은 얼굴로 볼 최대 시간 간격(초) */
const LINK_MAX_GAP_SEC = 2

/** 앞 추적의 끝과 뒤 추적의 시작이 같은 자리인지: 시간이 벌어질수록 조금 더 멀어도 같은 얼굴로 본다. */
function sameSpot(a: Rect, b: Rect, gapSec: number): boolean {
  const distance = Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2))
  const size = Math.max(a.width, a.height, b.width, b.height)
  return distance <= size * (0.6 + 0.5 * gapSec)
}

function linked(a: FaceTrack, b: FaceTrack, timestampsUs: ArrayLike<number>, sceneCuts: readonly number[]): boolean {
  const [first, second] = (a.points[0]?.frame ?? 0) <= (b.points[0]?.frame ?? 0) ? [a, b] : [b, a]
  const start = second.points[0]
  if (!start || first.points.length === 0) return false
  // 뒤 추적이 시작하는 시점에서 가장 가까운 앞 추적의 위치와 견준다(겹쳐 있으면 그 시점, 끊겼으면 앞 추적의 끝).
  let near = first.points[0]!
  for (const point of first.points) {
    if (Math.abs(point.frame - start.frame) <= Math.abs(near.frame - start.frame)) near = point
  }
  // 그 사이에 장면이 바뀌었으면 같은 자리에 있어도 다른 얼굴이다(지우지 않을 얼굴까지 함께 지우지 않도록).
  const from = Math.min(near.frame, start.frame)
  const to = Math.max(near.frame, start.frame)
  if (sceneCuts.some((cut) => cut > from && cut <= to)) return false
  const gapSec = Math.abs((timestampsUs[start.frame] ?? 0) - (timestampsUs[near.frame] ?? 0)) / 1e6
  return gapSec <= LINK_MAX_GAP_SEC && sameSpot(near.box, start.box, gapSec)
}

/**
 * 가림 하나를 지울 때 함께 지울 추적 번호들.
 * 얼굴이 잠깐 안 잡히면 같은 얼굴이 여러 추적으로 끊기므로, 같은 자리에서 바로 이어지는 추적을 앞뒤로 따라가 모두 모은다.
 * sceneCuts(새 장면이 시작되는 프레임 번호들)를 주면 장면이 바뀌는 곳을 건너서는 묶지 않는다.
 */
export function linkedTrackIds(
  tracks: FaceTrack[],
  trackId: number,
  timestampsUs: ArrayLike<number>,
  sceneCuts: readonly number[] = [],
): number[] {
  const origin = tracks.find((track) => track.id === trackId)
  if (!origin) return [trackId]
  const found = new Map<number, FaceTrack>([[origin.id, origin]])
  const queue = [origin]
  while (queue.length > 0) {
    const current = queue.pop()!
    for (const other of tracks) {
      if (found.has(other.id) || !linked(current, other, timestampsUs, sceneCuts)) continue
      found.set(other.id, other)
      queue.push(other)
    }
  }
  return [...found.keys()]
}

/**
 * 모자이크가 새로 생기는 프레임 번호들(오름차순).
 * 바로 앞 프레임에 같은 추적의 가림이 있거나 같은 자리에 가림이 있으면 이어지는 것으로 보고 넘어간다.
 * 검토할 때 "모자이크가 처음 나타나는 곳"으로 바로 건너뛰는 데 쓴다.
 */
export function maskStartFrames(plan: MaskBox[][]): number[] {
  const starts: number[] = []
  for (let frame = 0; frame < plan.length; frame += 1) {
    const current = plan[frame] ?? []
    if (current.length === 0) continue
    const previous = frame > 0 ? (plan[frame - 1] ?? []) : []
    const appeared = current.some(
      (box) => !previous.some((before) => before.trackId === box.trackId || rectIou(before, box) >= 0.3),
    )
    if (appeared) starts.push(frame)
  }
  return starts
}

export function nextManualId(edits: Edits): number {
  return Math.min(0, ...edits.manualTracks.map((track) => track.id)) - 1
}
