import type { OutputQuality, Sensitivity } from '../config/mosaic-defaults'
import type { Rect } from '../core/geometry'
import type { Edits } from '../core/mask-plan'
import type { FalsePositiveFilter } from '../core/false-positive'
import type { Region } from '../core/regions'
import type { KeyFrameIndex, SplitPiece } from '../core/split-plan'
import type { FaceTrack } from '../core/tracker'

/** 사용자가 정하는 작업 설정. 좌표는 모두 "회전 적용 후 원본 해상도 픽셀". */
export interface JobSettings {
  /** 사용자가 그린 영역(포함·제외·구간). 포함 영역이 없으면 화면 전체가 대상. */
  regions: Region[]
  sensitivity: Sensitivity
  quality: OutputQuality
  marginRatio: number
  blocksAcross: number
  maxGapFrames: number
  padFrames: number
  /** 얼굴이 아닌 것 거르기. 없으면 '보통'. */
  falsePositiveFilter?: FalsePositiveFilter
}

export interface VideoInfo {
  name: string
  sizeBytes: number
  durationSec: number
  /** 회전 적용 후 표시 크기 */
  width: number
  height: number
  rotation: number
  fps: number
  frameCountEstimate: number
  videoCodec: string | null
  videoCodecString: string | null
  audioCodec: string | null
  hasAudio: boolean
  canDecodeVideo: boolean
}

/** 1차(분석) 결과. 프레임 이미지는 들어 있지 않다. JSON 으로 저장할 수 있다. */
export interface AnalysisResult {
  width: number
  height: number
  frameCount: number
  /** 프레임별 표시 시각(마이크로초), 해독 순서 */
  timestampsUs: number[]
  /** 화면 전체에서 찾은 얼굴 추적. 영역 규칙은 가림 계획을 만들 때 적용하므로 영역을 바꿔도 다시 찾을 필요가 없다. */
  tracks: FaceTrack[]
  /** 검출된 얼굴 수(프레임 누적) */
  detections: number
  elapsedMs: number
}

export interface RenderStats {
  frames: number
  maskedFrames: number
  /** 분석 때의 프레임 시각과 정확히 일치하지 않아 가장 가까운 프레임을 쓴 횟수(0이어야 정상) */
  timestampMismatches: number
  audioTracksIn: number
  audioTracksOut: number
  discarded: string[]
  bytes: number
  elapsedMs: number
}

export interface ProgressInfo {
  phase: 'analyze' | 'render' | 'split'
  /** 0..1 */
  fraction: number
  frames: number
  /** 지금까지의 초당 처리 프레임 */
  fps: number
}

export class JobCanceledError extends Error {
  constructor() {
    super('작업을 취소했습니다')
    this.name = 'JobCanceledError'
  }
}

/** 처리할 시간 구간(초, 원본 기준). endSec 이 null 이면 끝까지. */
export interface TimeRange {
  startSec: number
  endSec: number | null
}

export interface SplitPieceSummary {
  index: number
  videoPackets: number
  audioPackets: number
  bytes: number
}

export type WorkerRequest =
  | { type: 'analyze'; file: Blob; settings: JobSettings }
  | { type: 'keyframes'; file: Blob }
  | {
      type: 'split'
      file: Blob
      pieces: SplitPiece[]
      /** 조각마다 하나씩. null 이면 메모리에 모아 돌려준다. */
      handles: Array<FileSystemFileHandle | null>
    }
  | {
      type: 'render'
      file: Blob
      settings: JobSettings
      analysis: AnalysisResult
      /** 있으면 디스크에 바로 쓰고, 없으면 메모리에 모아 돌려준다(미지원 브라우저용). */
      handle: FileSystemFileHandle | null
      /** 영상의 일부 구간만 저장할 때(분할 조각) */
      range: TimeRange | null
      /** 검토 단계에서 사용자가 고친 내용(수동 추가·삭제) */
      edits: Edits
    }
  | { type: 'track'; file: Blob; timeUs: number; box: Rect; spanSec: number }
  | { type: 'cancel' }

export type WorkerResponse =
  | { type: 'progress'; progress: ProgressInfo }
  | { type: 'analyzed'; analysis: AnalysisResult }
  | { type: 'rendered'; stats: RenderStats; buffer: ArrayBuffer | null }
  | { type: 'keyframes'; index: KeyFrameIndex }
  | { type: 'tracked'; points: Array<{ timeUs: number; box: Rect }> }
  | { type: 'split'; pieces: SplitPieceSummary[]; buffers: Array<ArrayBuffer | null> }
  | { type: 'error'; message: string; canceled: boolean }
