import { BASE_FPS } from '../config/mosaic-defaults'
import type { FaceTrack } from './tracker'

/** 얼굴이 아닌 것(오검출)을 얼마나 강하게 거를지 */
export type FalsePositiveFilter = 'off' | 'normal' | 'strong'

export const FALSE_POSITIVE_LABELS: Record<FalsePositiveFilter, string> = {
  off: '거르지 않음 (잡힌 것은 모두 가림)',
  normal: '보통 (얼굴이 아닌 것으로 보이면 뺌)',
  strong: '강하게 (확실한 얼굴만, 옆얼굴을 놓칠 수 있음)',
}

/**
 * 거르는 기준(초안, glm.md 9장: 최종 수치는 확정되지 않았다).
 * 근거: 시험 영상에서 옷깃 무늬가 타일(확대) 검출에서만 0.69 점으로 잡혔고,
 * 실제 옆얼굴은 0.41~0.49 점이지만 전체 화면 검출에서 매 프레임 잡혔다.
 * 그래서 점수보다 "어디서·얼마나 꾸준히 잡혔는가"를 본다.
 *
 * 실제 교실 영상 측정(2026-11-22)으로 고친 점: 진짜 얼굴도 고개를 숙이거나 돌리면 전체 화면 검출에서는
 * 절반쯤만(약한 검출까지 쳐도) 잡힌다. 그래서 "확대 검출에서만 잡혔다"는 것은 여러 번 잡히고도
 * 한 번도 전체 화면에서 확인되지 않았을 때만 얼굴이 아니라는 근거로 쓴다(몇 번 안 잡힌 것은 판단을 미룬다).
 */
export const FALSE_POSITIVE_RULES = {
  /** 검출 모델 입력의 긴 변(px). 전체 화면은 이 크기로 줄여서 본다. */
  modelInputSize: 640,
  /**
   * 전체 화면으로 줄였을 때도 이 크기(px) 이상인데 확대(타일) 검출에서만 잡힌 것은 얼굴이 아니라고 본다.
   * 이만한 크기의 진짜 얼굴은 여러 번 잡히는 동안 전체 화면 검출에서도(약하게라도) 한 번은 잡힌다.
   */
  tileOnlyMinModelPx: 32,
  /** 확대 검출에서만 잡혔다고 판단하려면 적어도 이 횟수는 잡혀야 한다 */
  tileOnlyMinDetections: 5,
  /** 얼굴 상자의 가로/세로 비율 허용 범위 */
  minAspect: 0.4,
  maxAspect: 1.4,
  /**
   * 상자가 화면 짧은 변의 이 비율 이상으로 큰데 최고 점수가 giantMinPeak 에 못 미치면 얼굴이 아니라고 본다.
   * 화면을 가득 채울 만큼 가까운 얼굴은 또렷해서 점수가 높게 나온다. 크면서 점수가 낮은 것은 벽·옷·책상을 얼굴로 본 것이다
   * (실제 교실 영상에서 나온 것은 최고 0.4점). 기준을 높게 잡으면 가까이에서 고개를 돌린 진짜 얼굴을 뺄 수 있어 0.6으로 낮게 둔다.
   */
  giantMinRatio: 0.4,
  giantMinPeak: 0.6,
  /**
   * 이 횟수 이하로만 잠깐 잡혔고 점수도 낮으면 뺀다.
   * 단, 두 번이 sporadicSpreadMinSec 초 이상 떨어져 잡혔고 점수가 sporadicSpreadMinPeak 이상이면 남긴다.
   * 확대(타일) 검출은 몇 프레임에 한 번만 하므로, 타일에서만 잡히는 작은 얼굴은 두 번 잡힌 것만으로도 꽤 오래 보인 것이다.
   * 근거(실제 교실 영상 30fps, 2026-11-22): 0.2초 이상 떨어져 두 번 잡힌 것 가운데 0.5점 이상인 7개 중 5개는 정밀 검출이
   * 그 사이 프레임 대부분에서 0.7점 이상으로 확인한 얼굴이었고, 0.5점 미만인 16개 중에는 그런 것이 없었다.
   * '보통'의 타일 검출 간격은 프레임 속도에 따라 0.17~0.24초이므로(core/detect-schedule.ts), 이어진 두 차례가 들어가도록 0.15초로 둔다.
   */
  sporadicMaxDetections: 2,
  sporadicMinPeak: 0.7,
  sporadicSpreadMinSec: 0.15,
  sporadicSpreadMinPeak: 0.5,
  /** 강하게 거를 때 추가로 요구하는 최고 점수와 검출 횟수 */
  strongMinPeak: 0.6,
  strongMinDetections: 4,
} as const

export type RejectReason = 'tile-only' | 'shape' | 'giant' | 'sporadic' | 'weak'

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1] ?? 0
}

/** 이 추적을 얼굴이 아닌 것으로 보고 뺄 이유. 얼굴로 보면 null. fps 는 영상의 초당 프레임 수(검출 사이의 시간을 재는 데 쓴다). */
export function rejectReason(
  track: FaceTrack,
  frameWidth: number,
  frameHeight: number,
  level: FalsePositiveFilter,
  fps: number = BASE_FPS,
): RejectReason | null {
  if (level === 'off' || track.points.length === 0) return null
  const rules = FALSE_POSITIVE_RULES
  const peak = Math.max(...track.points.map((point) => point.score))
  const width = median(track.points.map((point) => point.box.width))
  const height = median(track.points.map((point) => point.box.height))

  // 화면 가장자리에 걸려 잘린 상자는 모양으로 판단하지 않는다(화면 밖으로 반쯤 나간 얼굴도 얼굴이다).
  const whole = track.points.filter(
    ({ box }) => box.x > 1 && box.y > 1 && box.x + box.width < frameWidth - 1 && box.y + box.height < frameHeight - 1,
  )
  if (whole.length > 0) {
    const aspect = median(whole.map((point) => point.box.width)) / Math.max(1, median(whole.map((point) => point.box.height)))
    if (aspect < rules.minAspect || aspect > rules.maxAspect) return 'shape'
  }

  if (Math.max(width, height) >= Math.min(frameWidth, frameHeight) * rules.giantMinRatio && peak < rules.giantMinPeak) return 'giant'

  if (track.points.length >= rules.tileOnlyMinDetections && track.points.every((point) => point.tile === true)) {
    const scale = Math.min(1, rules.modelInputSize / Math.max(frameWidth, frameHeight, 1))
    if (Math.max(width, height) * scale >= rules.tileOnlyMinModelPx) return 'tile-only'
  }

  if (track.points.length <= rules.sporadicMaxDetections && peak < rules.sporadicMinPeak) {
    const spanSec = (track.points[track.points.length - 1]!.frame - track.points[0]!.frame) / (fps > 0 ? fps : BASE_FPS)
    const spread = track.points.length >= 2 && spanSec >= rules.sporadicSpreadMinSec && peak >= rules.sporadicSpreadMinPeak
    if (!spread) return 'sporadic'
  }

  if (level === 'strong' && (peak < rules.strongMinPeak || track.points.length < rules.strongMinDetections)) return 'weak'
  return null
}

/** 장면 전환에서 갈라 둔 추적 묶음의 맨 앞 추적(after 를 거슬러 올라간다). */
function rootOf(track: FaceTrack, byId: Map<number, FaceTrack>): FaceTrack {
  let current = track
  for (let guard = 0; guard < 1000 && current.after !== undefined; guard += 1) {
    const parent = byId.get(current.after)
    if (!parent || parent === current) break
    current = parent
  }
  return current
}

/**
 * 추적별로 뺄 이유(얼굴로 보는 추적은 들어 있지 않다).
 * 장면이 바뀐 뒤 약한 검출로만 이어져 따로 떼어 둔 구간(after)은 혼자 판단하지 않고 앞 구간과 한 묶음으로 본다.
 * 약한 검출만으로는 얼굴이라는 근거가 모자라므로, 떼지 않았을 때와 같은 판단이 나오게 한다.
 */
export function rejectReasons(
  tracks: FaceTrack[],
  frameWidth: number,
  frameHeight: number,
  level: FalsePositiveFilter,
  fps: number = BASE_FPS,
): Map<number, RejectReason> {
  const reasons = new Map<number, RejectReason>()
  if (level === 'off') return reasons
  const byId = new Map(tracks.map((track) => [track.id, track]))
  const groups = new Map<FaceTrack, FaceTrack[]>()
  for (const track of tracks) {
    const root = rootOf(track, byId)
    const group = groups.get(root)
    if (group) group.push(track)
    else groups.set(root, [track])
  }
  for (const [root, group] of groups) {
    const whole: FaceTrack =
      group.length === 1 ? group[0]! : { id: root.id, points: group.flatMap((track) => track.points).sort((a, b) => a.frame - b.frame) }
    const reason = rejectReason(whole, frameWidth, frameHeight, level, fps)
    if (reason) for (const track of group) reasons.set(track.id, reason)
  }
  return reasons
}

/** 얼굴로 볼 추적만 남긴다. */
export function keepFaces(
  tracks: FaceTrack[],
  frameWidth: number,
  frameHeight: number,
  level: FalsePositiveFilter,
  fps: number = BASE_FPS,
): FaceTrack[] {
  if (level === 'off') return tracks
  const reasons = rejectReasons(tracks, frameWidth, frameHeight, level, fps)
  return tracks.filter((track) => !reasons.has(track.id))
}
