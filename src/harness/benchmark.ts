import { createDetector, detectorConfigs } from '../detectors/registry'
import type { DetectorDiagnostics, FaceBox, OnnxTuning } from '../detectors/types'
import { describeEnvironment, type EnvironmentInfo } from './environment'
import { matchBoxes, nms } from './metrics'

export interface FixtureClip {
  id: string
  label: string
  description: string
  video: string
  width: number
  height: number
  fps: number
  frames: string[]
  sources: string[]
}

export interface FixtureManifest {
  generatedAt: string
  clips: FixtureClip[]
}

export interface FrameDetection {
  frameIndex: number
  ms: number
  boxes: FaceBox[]
}

export interface ClipMetrics {
  frames: number
  detections: number
  reference: number
  matched: number
  missed: number
  extra: number
  recall: number
  precision: number
  smallReference: number
  smallMatched: number
  smallRecall: number
  avgMs: number
  fps: number
  loadMs: number
}

export interface DetectorClipResult {
  metrics: ClipMetrics
  frames: FrameDetection[]
}

export interface DetectorResult {
  id: string
  label: string
  note: string
  color: string
  diagnostics: DetectorDiagnostics | null
  clips: Record<string, DetectorClipResult>
}

export interface BenchmarkResult {
  generatedAt: string
  environment: EnvironmentInfo
  iouThreshold: number
  smallFaceHeightPx: number
  clips: FixtureClip[]
  detectors: DetectorResult[]
  log: string[]
}

export interface RunProgress {
  phase: string
  done: number
  total: number
}

export interface RunOptions {
  clipIds?: string[]
  detectorIds?: string[]
  iouThreshold?: number
  tuning?: Record<string, OnnxTuning>
  warmupRuns?: number
  onProgress?: (progress: RunProgress) => void
  log?: (message: string) => void
}

const MANIFEST_URL = '/fixtures/manifest.json'
const SMALL_FACE_HEIGHT = 48
const REFERENCE_IOU = 0.5

export async function loadManifest(): Promise<FixtureManifest> {
  const response = await fetch(MANIFEST_URL, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`시험 목록을 불러오지 못했습니다(${response.status}). 먼저 npm run fixtures 를 실행하세요.`)
  }
  return (await response.json()) as FixtureManifest
}

export async function loadFrameBitmap(url: string): Promise<ImageBitmap> {
  const response = await fetch(url, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`프레임을 불러오지 못했습니다: ${url} (${response.status})`)
  return createImageBitmap(await response.blob())
}

function roundBox(box: FaceBox): FaceBox {
  return {
    x: Math.round(box.x * 10) / 10,
    y: Math.round(box.y * 10) / 10,
    width: Math.round(box.width * 10) / 10,
    height: Math.round(box.height * 10) / 10,
    score: Math.round(box.score * 1000) / 1000,
  }
}

export function referenceForFrame(
  detectors: DetectorResult[],
  clipId: string,
  frameIndex: number,
  excludeDetectorId?: string,
): FaceBox[] {
  const pooled: FaceBox[] = []
  for (const detector of detectors) {
    if (detector.id === excludeDetectorId) continue
    const frame = detector.clips[clipId]?.frames.find((item) => item.frameIndex === frameIndex)
    if (frame) pooled.push(...frame.boxes)
  }
  return nms(pooled, REFERENCE_IOU)
}

function summarize(
  frames: FrameDetection[],
  references: FaceBox[][],
  iouThreshold: number,
  loadMs: number,
): ClipMetrics {
  let detections = 0
  let reference = 0
  let matched = 0
  let missed = 0
  let extra = 0
  let smallReference = 0
  let smallMatched = 0
  let totalMs = 0

  for (const frame of frames) {
    const targets = references[frame.frameIndex] ?? []
    const result = matchBoxes(frame.boxes, targets, iouThreshold)
    detections += frame.boxes.length
    reference += targets.length
    matched += result.matched
    missed += result.missed
    extra += result.extra
    totalMs += frame.ms
    for (const match of result.matches) {
      const target = targets[match.target]
      if (target && target.height < SMALL_FACE_HEIGHT) smallMatched += 1
    }
    for (const target of targets) {
      if (target.height < SMALL_FACE_HEIGHT) smallReference += 1
    }
  }

  const avgMs = frames.length > 0 ? totalMs / frames.length : 0
  return {
    frames: frames.length,
    detections,
    reference,
    matched,
    missed,
    extra,
    recall: reference > 0 ? matched / reference : 0,
    precision: detections > 0 ? matched / detections : 0,
    smallReference,
    smallMatched,
    smallRecall: smallReference > 0 ? smallMatched / smallReference : 0,
    avgMs,
    fps: avgMs > 0 ? 1000 / avgMs : 0,
    loadMs,
  }
}

export async function runBenchmark(options: RunOptions = {}): Promise<BenchmarkResult> {
  const manifest = await loadManifest()
  const clips = manifest.clips.filter((clip) => !options.clipIds || options.clipIds.includes(clip.id))
  const configs = detectorConfigs.filter((config) => !options.detectorIds || options.detectorIds.includes(config.id))
  if (clips.length === 0) throw new Error('선택된 시험 클립이 없습니다')
  if (configs.length === 0) throw new Error('선택된 검출기가 없습니다')

  const iouThreshold = options.iouThreshold ?? 0.5
  const warmupRuns = options.warmupRuns ?? 2
  const log: string[] = []
  const pushLog = (message: string) => {
    log.push(message)
    options.log?.(message)
  }

  const totalSteps = configs.length
  const frameTotal = clips.reduce((sum, clip) => sum + clip.frames.length, 0) * configs.length
  let done = 0
  options.onProgress?.({ phase: '모델 준비', done, total: totalSteps + frameTotal })

  const environment = await describeEnvironment()
  pushLog(`환경: ${JSON.stringify(environment)}`)

  const detectors = configs.map((config) => {
    const tuning = options.tuning?.[config.id]
    return {
      config,
      adapter: tuning ? createDetector(config, { tuning, log: pushLog }) : createDetector(config, { log: pushLog }),
      loadMs: 0,
    }
  })

  for (const entry of detectors) {
    const started = performance.now()
    await entry.adapter.init()
    entry.loadMs = performance.now() - started
    done += 1
    options.onProgress?.({ phase: '모델 준비', done, total: totalSteps + frameTotal })
  }

  const results: DetectorResult[] = detectors.map((entry) => ({
    id: entry.config.id,
    label: entry.config.label,
    note: entry.config.note,
    color: entry.config.color,
    diagnostics: entry.adapter.diagnostics?.() ?? null,
    clips: {},
  }))

  for (const clip of clips) {
    const bitmaps: ImageBitmap[] = []
    for (const frameUrl of clip.frames) bitmaps.push(await loadFrameBitmap(frameUrl))
    if (bitmaps.length === 0) throw new Error(`클립 ${clip.id} 에 프레임이 없습니다`)

    for (const entry of detectors) {
      const first = bitmaps[0]
      if (!first) throw new Error('프레임이 비어 있습니다')
      for (let run = 0; run < warmupRuns; run += 1) await entry.adapter.detect(first)

      const frames: FrameDetection[] = []
      for (let index = 0; index < bitmaps.length; index += 1) {
        const bitmap = bitmaps[index]
        if (!bitmap) continue
        const detection = await entry.adapter.detect(bitmap)
        frames.push({ frameIndex: index, ms: detection.ms, boxes: detection.boxes.map(roundBox) })
        done += 1
        if (done % 10 === 0 || done === totalSteps + frameTotal) {
          options.onProgress?.({ phase: `${clip.label} · ${entry.config.label}`, done, total: totalSteps + frameTotal })
        }
      }

      const target = results.find((item) => item.id === entry.config.id)
      if (!target) throw new Error(`결과 버킷을 찾지 못했습니다: ${entry.config.id}`)
      target.clips[clip.id] = { metrics: summarize(frames, [], iouThreshold, entry.loadMs), frames }
    }

    for (const result of results) {
      const clipResult = result.clips[clip.id]
      if (!clipResult) continue
      const references = clip.frames.map((_, frameIndex) =>
        referenceForFrame(results, clip.id, frameIndex, result.id),
      )
      clipResult.metrics = summarize(clipResult.frames, references, iouThreshold, clipResult.metrics.loadMs)
    }

    for (const bitmap of bitmaps) bitmap.close()
    pushLog(`${clip.id}: 프레임 ${bitmaps.length}장 처리 완료`)
  }

  options.onProgress?.({ phase: '완료', done: totalSteps + frameTotal, total: totalSteps + frameTotal })
  for (const entry of detectors) entry.adapter.dispose()

  return {
    generatedAt: new Date().toISOString(),
    environment,
    iouThreshold,
    smallFaceHeightPx: SMALL_FACE_HEIGHT,
    clips,
    detectors: results,
    log,
  }
}

export function aggregateMetrics(detector: DetectorResult, clipIds: string[]): ClipMetrics {
  const totals: ClipMetrics = {
    frames: 0,
    detections: 0,
    reference: 0,
    matched: 0,
    missed: 0,
    extra: 0,
    recall: 0,
    precision: 0,
    smallReference: 0,
    smallMatched: 0,
    smallRecall: 0,
    avgMs: 0,
    fps: 0,
    loadMs: detector.clips[clipIds[0] ?? '']?.metrics.loadMs ?? 0,
  }
  let weightedMs = 0
  let frameCount = 0
  for (const clipId of clipIds) {
    const clip = detector.clips[clipId]
    if (!clip) continue
    totals.frames += clip.metrics.frames
    totals.detections += clip.metrics.detections
    totals.reference += clip.metrics.reference
    totals.matched += clip.metrics.matched
    totals.missed += clip.metrics.missed
    totals.extra += clip.metrics.extra
    totals.smallReference += clip.metrics.smallReference
    totals.smallMatched += clip.metrics.smallMatched
    weightedMs += clip.metrics.avgMs * clip.metrics.frames
    frameCount += clip.metrics.frames
  }
  totals.recall = totals.reference > 0 ? totals.matched / totals.reference : 0
  totals.precision = totals.detections > 0 ? totals.matched / totals.detections : 0
  totals.smallRecall = totals.smallReference > 0 ? totals.smallMatched / totals.smallReference : 0
  totals.avgMs = frameCount > 0 ? weightedMs / frameCount : 0
  totals.fps = totals.avgMs > 0 ? 1000 / totals.avgMs : 0
  return totals
}
