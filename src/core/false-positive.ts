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
 */
export const FALSE_POSITIVE_RULES = {
  /** 검출 모델 입력의 긴 변(px). 전체 화면은 이 크기로 줄여서 본다. */
  modelInputSize: 640,
  /**
   * 전체 화면으로 줄였을 때도 이 크기(px) 이상인데 확대(타일) 검출에서만 잡힌 것은 얼굴이 아니라고 본다.
   * 이만한 크기의 진짜 얼굴은 전체 화면 검출에서도 잡힌다.
   */
  tileOnlyMinModelPx: 32,
  /** 얼굴 상자의 가로/세로 비율 허용 범위 */
  minAspect: 0.4,
  maxAspect: 1.4,
  /** 이 횟수 이하로만 잠깐 잡혔고 점수도 낮으면 뺀다 */
  sporadicMaxDetections: 2,
  sporadicMinPeak: 0.7,
  /** 강하게 거를 때 추가로 요구하는 최고 점수와 검출 횟수 */
  strongMinPeak: 0.6,
  strongMinDetections: 4,
} as const

export type RejectReason = 'tile-only' | 'shape' | 'sporadic' | 'weak'

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1] ?? 0
}

/** 이 추적을 얼굴이 아닌 것으로 보고 뺄 이유. 얼굴로 보면 null. */
export function rejectReason(
  track: FaceTrack,
  frameWidth: number,
  frameHeight: number,
  level: FalsePositiveFilter,
): RejectReason | null {
  if (level === 'off' || track.points.length === 0) return null
  const rules = FALSE_POSITIVE_RULES
  const peak = Math.max(...track.points.map((point) => point.score))
  const width = median(track.points.map((point) => point.box.width))
  const height = median(track.points.map((point) => point.box.height))

  const aspect = width / Math.max(1, height)
  if (aspect < rules.minAspect || aspect > rules.maxAspect) return 'shape'

  if (track.points.every((point) => point.tile === true)) {
    const scale = Math.min(1, rules.modelInputSize / Math.max(frameWidth, frameHeight, 1))
    if (Math.max(width, height) * scale >= rules.tileOnlyMinModelPx) return 'tile-only'
  }

  if (track.points.length <= rules.sporadicMaxDetections && peak < rules.sporadicMinPeak) return 'sporadic'

  if (level === 'strong' && (peak < rules.strongMinPeak || track.points.length < rules.strongMinDetections)) return 'weak'
  return null
}

/** 얼굴로 볼 추적만 남긴다. */
export function keepFaces(tracks: FaceTrack[], frameWidth: number, frameHeight: number, level: FalsePositiveFilter): FaceTrack[] {
  if (level === 'off') return tracks
  return tracks.filter((track) => rejectReason(track, frameWidth, frameHeight, level) === null)
}
