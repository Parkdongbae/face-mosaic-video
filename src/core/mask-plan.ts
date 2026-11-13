import { keepFaces, type FalsePositiveFilter } from './false-positive'
import { rectIou, type Rect } from './geometry'
import { isTarget, type Region } from './regions'
import { buildTrackedMaskPlan, nearestIndex, type FaceTrack, type MaskBox } from './tracker'

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
}

export interface PlanSettings {
  regions: Region[]
  maxGapFrames: number
  padFrames: number
  marginRatio: number
  /** 얼굴이 아닌 것 거르기. 없으면 '보통'. */
  falsePositiveFilter?: FalsePositiveFilter
}

/**
 * 실제로 가릴 추적 목록을 고른다.
 * - 자동 검출: 사용자가 지운 것은 빼고, 각 검출을 그 시각의 영역 규칙(포함·제외·구간)으로 거른다.
 * - 자동 검출 가운데 얼굴이 아닌 것으로 보이는 추적은 뺀다(false-positive.ts).
 * - 수동 추가: 사용자가 직접 표시한 것이므로 영역과 무관하게 항상 가린다.
 */
export function selectTracks(
  source: PlanSource,
  regions: Region[],
  edits: Edits = NO_EDITS,
  filter: FalsePositiveFilter = 'normal',
): FaceTrack[] {
  const removed = new Set(edits.removedTrackIds)
  const selected: FaceTrack[] = []
  for (const track of keepFaces(source.tracks, source.width, source.height, filter)) {
    if (removed.has(track.id)) continue
    const points = track.points.filter((point) => isTarget(point.box, regions, (source.timestampsUs[point.frame] ?? 0) / 1e6))
    if (points.length > 0) selected.push({ id: track.id, points })
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
  return buildTrackedMaskPlan(selectTracks(source, settings.regions, edits, settings.falsePositiveFilter ?? 'normal'), {
    frameCount: source.frameCount,
    frameWidth: source.width,
    frameHeight: source.height,
    maxGapFrames: settings.maxGapFrames,
    padFrames: settings.padFrames,
    marginRatio: settings.marginRatio,
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

function linked(a: FaceTrack, b: FaceTrack, timestampsUs: ArrayLike<number>): boolean {
  const [first, second] = (a.points[0]?.frame ?? 0) <= (b.points[0]?.frame ?? 0) ? [a, b] : [b, a]
  const start = second.points[0]
  if (!start || first.points.length === 0) return false
  // 뒤 추적이 시작하는 시점에서 가장 가까운 앞 추적의 위치와 견준다(겹쳐 있으면 그 시점, 끊겼으면 앞 추적의 끝).
  let near = first.points[0]!
  for (const point of first.points) {
    if (Math.abs(point.frame - start.frame) <= Math.abs(near.frame - start.frame)) near = point
  }
  const gapSec = Math.abs((timestampsUs[start.frame] ?? 0) - (timestampsUs[near.frame] ?? 0)) / 1e6
  return gapSec <= LINK_MAX_GAP_SEC && sameSpot(near.box, start.box, gapSec)
}

/**
 * 가림 하나를 지울 때 함께 지울 추적 번호들.
 * 얼굴이 잠깐 안 잡히면 같은 얼굴이 여러 추적으로 끊기므로, 같은 자리에서 바로 이어지는 추적을 앞뒤로 따라가 모두 모은다.
 */
export function linkedTrackIds(tracks: FaceTrack[], trackId: number, timestampsUs: ArrayLike<number>): number[] {
  const origin = tracks.find((track) => track.id === trackId)
  if (!origin) return [trackId]
  const found = new Map<number, FaceTrack>([[origin.id, origin]])
  const queue = [origin]
  while (queue.length > 0) {
    const current = queue.pop()!
    for (const other of tracks) {
      if (found.has(other.id) || !linked(current, other, timestampsUs)) continue
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
