/**
 * 모자이크·검출·추적 기본값. glm.md 9장에 따라 최종 수치는 아직 확정되지 않았다(초안).
 * 값을 바꿀 때는 이 파일만 고치면 된다.
 */

export type Sensitivity = 'low' | 'normal' | 'high'
export type OutputQuality = 'medium' | 'high' | 'very-high'

export interface SensitivityPreset {
  label: string
  /** 검출 신뢰도 기준값. 낮을수록 더 많이 잡는다. */
  scoreThreshold: number
  /** 전체 화면 검출에 더해 화면을 나눠 검출할 타일 격자(0이면 타일 없음). */
  tileCols: number
  tileRows: number
  /**
   * 타일 검출을 몇 프레임마다 할지. 전체 화면 검출은 매 프레임 한다.
   * 타일로만 잡히는 작은(멀리 있는) 얼굴은 화면에서 천천히 움직이므로 사이 프레임은 추적 보간으로 채운다.
   * 추론 1회가 약 20~30ms 라 매 프레임 타일 검출은 너무 느리다(2단계 측정).
   */
  tileIntervalFrames: number
}

export const SENSITIVITY_PRESETS: Record<Sensitivity, SensitivityPreset> = {
  low: { label: '빠르게 (큰 얼굴 위주)', scoreThreshold: 0.6, tileCols: 0, tileRows: 0, tileIntervalFrames: 1 },
  normal: { label: '보통 (작은 얼굴 포함)', scoreThreshold: 0.4, tileCols: 2, tileRows: 2, tileIntervalFrames: 3 },
  high: { label: '꼼꼼하게 (아주 작은 얼굴까지, 느림)', scoreThreshold: 0.3, tileCols: 3, tileRows: 3, tileIntervalFrames: 2 },
}

export const MOSAIC_DEFAULTS = {
  sensitivity: 'normal' as Sensitivity,
  quality: 'high' as OutputQuality,
  /** 타일끼리 겹치는 비율 (glm.md 4-2) */
  tileOverlap: 0.2,
  /** 타일·전체 화면 결과를 합칠 때의 NMS IoU 기준 */
  mergeIou: 0.4,
  /** 얼굴 상자를 사방으로 넓히는 비율 (glm.md 4-4: 20~30%) */
  marginRatio: 0.25,
  /** 얼굴 폭 기준 모자이크 블록 수 (glm.md 4-5: 8칸 이하) */
  blocksAcross: 8,
  /** 검출이 끊겨도 같은 얼굴로 이어 붙이고 보간하는 최대 프레임 수 */
  maxGapFrames: 15,
  /** 처음 검출 전·마지막 검출 후에도 가리는 프레임 수 */
  padFrames: 5,
  /** 키프레임 간격(초) (glm.md 3-2) */
  keyFrameIntervalSec: 2,
  /** 수동으로 추가한 얼굴을 앞뒤로 따라가는 최대 길이(초). 그 안에서도 놓치면 멈춘다. */
  manualTrackSpanSec: 5,
} as const

/**
 * 영상 분할 기본값(초안, glm.md 9장: 자동 권장 기준과 기본 상한은 아직 확정되지 않았다).
 */
export const SPLIT_DEFAULTS = {
  count: 3,
  /** 용량 분할의 기본 상한(MB) */
  maxMb: 500,
  /** 이 용량 이상이면 분할을 권한다 */
  recommendBytes: 2 * 1024 ** 3,
  /** 이 길이(초) 이상이면 분할을 권한다 */
  recommendDurationSec: 30 * 60,
  /** 사양 판정이 주의·부적합일 때는 이 길이(초) 이상부터 분할을 권한다 */
  recommendDurationWhenSlowSec: 5 * 60,
} as const
