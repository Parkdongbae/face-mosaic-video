import { MOSAIC_DEFAULTS, SENSITIVITY_PRESETS, type OutputQuality, type Sensitivity } from '../config/mosaic-defaults'
import type { Point, Rect } from '../core/geometry'
import type { ManualTrack } from '../core/mask-plan'
import { newRegionId, type Region } from '../core/regions'

/**
 * 프로젝트 파일(.json): 영역·설정·수동 수정 내역을 저장해 다른 컴퓨터에서 이어서 작업하기 위한 파일(F-14).
 * 영상 내용이나 자동 검출 결과는 넣지 않는다. 영상은 이름·크기만 적어 같은 영상인지 확인하는 데 쓴다.
 * 사용자가 직접 추가한 얼굴 상자(시각 + 좌표)는 수동 수정 내역이므로 들어간다.
 *
 * 버전 1: 영역이 사각형 목록. 버전 2: 다각형·제외·구간 영역과 수동 추가 얼굴.
 */
export interface ProjectFile {
  format: 'mosaic-project'
  version: 2
  savedAt: string
  video: { name: string; sizeBytes: number; durationSec: number; width: number; height: number } | null
  settings: {
    /** 회전 적용 후 원본 해상도 픽셀 좌표 */
    regions: Region[]
    sensitivity: Sensitivity
    quality: OutputQuality
    marginRatio: number
  }
  /** 사용자가 직접 추가한 얼굴(없으면 생략) */
  manualTracks?: ManualTrack[]
  /** 영상 분할 설정과 조각별 완료 상태(중단 후 이어서 하기용). 나누지 않으면 없다. */
  split?: ProjectSplit
}

export interface ProjectSplit {
  choice: 'count' | 'size'
  count: number
  maxMb: number
  /** 저장을 마친 조각의 구간(초, 원본 기준) */
  done: Array<{ startSec: number; endSec: number }>
}

export interface ProjectInput {
  video: ProjectFile['video']
  regions: Region[]
  sensitivity: Sensitivity
  quality: OutputQuality
  marginRatio: number
  manualTracks?: ManualTrack[]
  split?: ProjectSplit | null
}

export function buildProject(input: ProjectInput, now: Date = new Date()): ProjectFile {
  return {
    format: 'mosaic-project',
    version: 2,
    savedAt: now.toISOString(),
    video: input.video,
    settings: {
      regions: input.regions,
      sensitivity: input.sensitivity,
      quality: input.quality,
      marginRatio: input.marginRatio,
    },
    ...(input.manualTracks && input.manualTracks.length > 0 ? { manualTracks: input.manualTracks } : {}),
    ...(input.split ? { split: input.split } : {}),
  }
}

const QUALITIES: OutputQuality[] = ['medium', 'high', 'very-high']
const REGION_ERROR = '프로젝트 파일의 영역 좌표가 올바르지 않습니다.'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRect(item: unknown): Rect | null {
  if (
    !isRecord(item) ||
    !isFiniteNumber(item.x) ||
    !isFiniteNumber(item.y) ||
    !isFiniteNumber(item.width) ||
    !isFiniteNumber(item.height) ||
    item.width <= 0 ||
    item.height <= 0
  ) {
    return null
  }
  return { x: item.x, y: item.y, width: item.width, height: item.height }
}

function parseRegion(item: unknown, version: number): Region {
  // 버전 1 은 사각형만 있었다.
  if (version === 1) {
    const rect = parseRect(item)
    if (!rect) throw new Error(REGION_ERROR)
    return { id: newRegionId(), shape: { kind: 'rect', rect }, exclude: false, startSec: null, endSec: null }
  }
  if (!isRecord(item) || !isRecord(item.shape)) throw new Error(REGION_ERROR)
  let shape: Region['shape']
  if (item.shape.kind === 'rect') {
    const rect = parseRect(item.shape.rect)
    if (!rect) throw new Error(REGION_ERROR)
    shape = { kind: 'rect', rect }
  } else if (item.shape.kind === 'polygon' && Array.isArray(item.shape.points)) {
    const points: Point[] = []
    for (const point of item.shape.points as unknown[]) {
      if (!isRecord(point) || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) throw new Error(REGION_ERROR)
      points.push({ x: point.x, y: point.y })
    }
    if (points.length < 3) throw new Error(REGION_ERROR)
    shape = { kind: 'polygon', points }
  } else {
    throw new Error(REGION_ERROR)
  }
  return {
    id: typeof item.id === 'string' && item.id ? item.id : newRegionId(),
    shape,
    exclude: item.exclude === true,
    startSec: isFiniteNumber(item.startSec) ? item.startSec : null,
    endSec: isFiniteNumber(item.endSec) ? item.endSec : null,
  }
}

function parseManualTracks(raw: unknown): ManualTrack[] {
  if (!Array.isArray(raw)) return []
  const tracks: ManualTrack[] = []
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || !Array.isArray(item.points)) continue
    const points: ManualTrack['points'] = []
    for (const point of item.points as unknown[]) {
      const box = isRecord(point) ? parseRect(point.box) : null
      if (isRecord(point) && isFiniteNumber(point.timeUs) && box) points.push({ timeUs: point.timeUs, box })
    }
    // 번호는 불러올 때 다시 매긴다(음수, 겹치지 않게).
    if (points.length > 0) tracks.push({ id: -(tracks.length + 1), points })
  }
  return tracks
}

/** 프로젝트 파일 내용을 검사해 읽는다. 형식이 맞지 않으면 이유와 함께 오류를 던진다. */
export function parseProject(text: string): ProjectFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('프로젝트 파일을 읽을 수 없습니다(JSON 형식이 아님).')
  }
  if (!isRecord(data) || data.format !== 'mosaic-project') throw new Error('이 앱의 프로젝트 파일이 아닙니다.')
  if (data.version !== 1 && data.version !== 2) throw new Error('지원하지 않는 프로젝트 파일 버전입니다.')
  const settings = data.settings
  if (!isRecord(settings) || !Array.isArray(settings.regions)) throw new Error('프로젝트 파일에 설정이 없습니다.')

  const regions = (settings.regions as unknown[]).map((item) => parseRegion(item, data.version as number))
  const sensitivity = typeof settings.sensitivity === 'string' && settings.sensitivity in SENSITIVITY_PRESETS
    ? (settings.sensitivity as Sensitivity)
    : MOSAIC_DEFAULTS.sensitivity
  const quality = QUALITIES.find((item) => item === settings.quality) ?? MOSAIC_DEFAULTS.quality
  const marginRatio = isFiniteNumber(settings.marginRatio) ? Math.max(0.1, Math.min(0.6, settings.marginRatio)) : MOSAIC_DEFAULTS.marginRatio

  let video: ProjectFile['video'] = null
  const raw = data.video
  if (isRecord(raw) && typeof raw.name === 'string' && isFiniteNumber(raw.width) && isFiniteNumber(raw.height)) {
    video = {
      name: raw.name,
      sizeBytes: isFiniteNumber(raw.sizeBytes) ? raw.sizeBytes : 0,
      durationSec: isFiniteNumber(raw.durationSec) ? raw.durationSec : 0,
      width: raw.width,
      height: raw.height,
    }
  }

  let split: ProjectSplit | null = null
  const rawSplit = data.split
  if (isRecord(rawSplit) && (rawSplit.choice === 'count' || rawSplit.choice === 'size')) {
    const done: ProjectSplit['done'] = []
    if (Array.isArray(rawSplit.done)) {
      for (const item of rawSplit.done as unknown[]) {
        if (isRecord(item) && isFiniteNumber(item.startSec) && isFiniteNumber(item.endSec)) done.push({ startSec: item.startSec, endSec: item.endSec })
      }
    }
    split = {
      choice: rawSplit.choice,
      count: isFiniteNumber(rawSplit.count) ? Math.round(rawSplit.count) : 3,
      maxMb: isFiniteNumber(rawSplit.maxMb) && rawSplit.maxMb > 0 ? rawSplit.maxMb : 500,
      done,
    }
  }
  const manualTracks = parseManualTracks(data.manualTracks)
  return {
    format: 'mosaic-project',
    version: 2,
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : '',
    video,
    settings: { regions, sensitivity, quality, marginRatio },
    ...(manualTracks.length > 0 ? { manualTracks } : {}),
    ...(split ? { split } : {}),
  }
}

/** 영역·수동 추가 얼굴의 좌표는 영상 해상도가 같을 때만 그대로 쓸 수 있다. */
export function regionsFit(project: ProjectFile, width: number, height: number): boolean {
  if (project.settings.regions.length === 0 && !project.manualTracks?.length) return true
  return project.video !== null && project.video.width === width && project.video.height === height
}
