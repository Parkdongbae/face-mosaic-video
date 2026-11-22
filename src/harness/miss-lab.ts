// 개발용 진단 도구: 영상에서 얼굴을 놓치는 정도를 숫자로 잰다(scripts/run-miss-e2e.mjs 가 쓴다).
// 앱 화면에서는 쓰지 않으며 배포본에 들어가지 않는다(아무 데서도 import 하지 않는다. 개발 서버에서만 읽힌다).
// 프레임 그림은 어디에도 내보내거나 저장하지 않고, 상자 좌표·점수·밝기 통계 같은 숫자만 돌려준다.
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { MOSAIC_DEFAULTS, SENSITIVITY_PRESETS, type Sensitivity, type SensitivityPreset } from '../config/mosaic-defaults'
import { rejectReasons, type FalsePositiveFilter, type RejectReason } from '../core/false-positive'
import { frameRateOf, tileLayout } from '../core/geometry'
import { NO_EDITS, planMasks } from '../core/mask-plan'
import type { MaskBox } from '../core/tracker'
import type { FaceBox } from '../detectors/types'
import { analyzeVideo } from '../pipeline/analyze'
import { MosaicClient } from '../pipeline/client'
import { DetectorPool, recommendedPoolSize } from '../pipeline/detector-pool'
import type { AnalysisResult, JobSettings } from '../pipeline/types'

type Log = (text: string) => void

export interface PipelineRun {
  settings: JobSettings
  analysis: AnalysisResult
  /** 프레임별로 가릴 사각형(앱의 미리보기·저장과 같은 계산) */
  plan: MaskBox[][]
  /** 얼굴이 아닌 것으로 보고 뺀 추적 */
  rejected: Array<{ trackId: number; reason: RejectReason }>
}

export function defaultSettings(sensitivity: Sensitivity, filter: FalsePositiveFilter = 'normal'): JobSettings {
  return {
    regions: [],
    sensitivity,
    quality: MOSAIC_DEFAULTS.quality,
    marginRatio: MOSAIC_DEFAULTS.marginRatio,
    blocksAcross: MOSAIC_DEFAULTS.blocksAcross,
    maxGapFrames: MOSAIC_DEFAULTS.maxGapFrames,
    padFrames: MOSAIC_DEFAULTS.padFrames,
    falsePositiveFilter: filter,
  }
}

function progressLogger(log?: Log): (progress: { fraction: number; fps: number }) => void {
  let last = 0
  return (progress) => {
    const now = performance.now()
    if (now - last < 5000) return
    last = now
    log?.(`분석 ${(progress.fraction * 100).toFixed(0)}% · 초당 ${progress.fps.toFixed(1)}장`)
  }
}

/** 가림 계획만 다시 만든다(검출은 다시 하지 않는다). 설정값을 바꿔 가며 견줄 때 쓴다. */
export function replan(run: Pick<PipelineRun, 'settings' | 'analysis'>, overrides: Partial<JobSettings> = {}): PipelineRun {
  const settings = { ...run.settings, ...overrides }
  const filter = settings.falsePositiveFilter ?? 'normal'
  const reasons = rejectReasons(run.analysis.tracks, run.analysis.width, run.analysis.height, filter, frameRateOf(run.analysis.timestampsUs))
  const rejected: PipelineRun['rejected'] = [...reasons].map(([trackId, reason]) => ({ trackId, reason }))
  return { settings, analysis: run.analysis, plan: planMasks(run.analysis, settings, NO_EDITS), rejected }
}

/** 앱과 똑같은 경로(처리 워커 → 검출 워커 묶음 → 추적 → 가림 계획)로 돌린다. */
export async function runPipeline(file: Blob, settings: JobSettings, log?: Log): Promise<PipelineRun> {
  const client = new MosaicClient()
  try {
    const analysis = await client.analyze(file, settings, progressLogger(log))
    return replan({ settings, analysis })
  } finally {
    client.dispose()
  }
}

/** 감도 기본값의 일부를 바꿔서 돌린다(기준값을 정하는 시험용). 처리 워커를 거치지 않고 이 화면에서 바로 분석한다. */
export async function runWithPreset(file: Blob, settings: JobSettings, preset: Partial<SensitivityPreset>, log?: Log): Promise<PipelineRun> {
  const analysis = await analyzeVideo(file, settings, { onProgress: progressLogger(log) }, { ...SENSITIVITY_PRESETS[settings.sensitivity], ...preset })
  return replan({ settings, analysis })
}

export interface ExhaustiveOptions {
  /** 이 점수 이상의 검출을 모두 돌려준다 */
  scoreThreshold: number
  /** 전체 화면 검출에 더해 돌릴 타일 격자들 [cols, rows] */
  grids: Array<[number, number]>
  overlap: number
  /** 몇 프레임마다 검출할지 */
  every: number
}

export interface ExhaustiveResult {
  width: number
  height: number
  timestampsUs: number[]
  /** 검출한 프레임만 들어 있다 */
  frames: Array<{ frame: number; boxes: FaceBox[] }>
  elapsedSec: number
}

/**
 * 기준용 정밀 검출: 여러 격자의 타일을 한꺼번에 돌려 가능한 한 많이 찾는다(아주 느리다. 앱은 이렇게 하지 않는다).
 * 이 결과를 "거기 얼굴이 있다"는 기준으로 삼아, 앱의 가림 계획이 그 얼굴들을 덮는지 본다.
 */
export async function exhaustiveDetect(file: Blob, options: ExhaustiveOptions, log?: Log): Promise<ExhaustiveResult> {
  const started = performance.now()
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  const pool = await DetectorPool.create(recommendedPoolSize(navigator.hardwareConcurrency || 1), 'yunet', options.scoreThreshold)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('영상 트랙이 없습니다')
    const width = track.displayWidth
    const height = track.displayHeight
    const tiles = options.grids.flatMap(([cols, rows]) => tileLayout(width, height, cols, rows, options.overlap))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('캔버스를 만들지 못했습니다')
    const timestampsUs: number[] = []
    const frames: ExhaustiveResult['frames'] = []
    const inFlight = new Set<Promise<void>>()
    const failure: { error: Error | null } = { error: null }
    let last = 0
    for await (const sample of new VideoSampleSink(track).samples()) {
      const frame = timestampsUs.length
      timestampsUs.push(sample.microsecondTimestamp)
      if (frame % options.every !== 0) {
        sample.close()
        continue
      }
      let bitmap: ImageBitmap
      try {
        sample.draw(context, 0, 0, width, height)
        bitmap = canvas.transferToImageBitmap()
      } finally {
        sample.close()
      }
      try {
        if (failure.error) throw failure.error
        await pool.acquire()
      } catch (error) {
        bitmap.close()
        throw error
      }
      const job: Promise<void> = pool
        .detect(bitmap, tiles)
        .then((boxes) => {
          frames.push({ frame, boxes })
        })
        .catch((error: unknown) => {
          failure.error ??= error instanceof Error ? error : new Error(String(error))
        })
        .finally(() => {
          inFlight.delete(job)
        })
      inFlight.add(job)
      const now = performance.now()
      if (now - last > 10000) {
        last = now
        log?.(`기준 검출 ${frame}프레임 · ${((now - started) / 1000).toFixed(0)}초`)
      }
    }
    await Promise.all(inFlight)
    if (failure.error) throw failure.error
    frames.sort((a, b) => a.frame - b.frame)
    return { width, height, timestampsUs, frames, elapsedSec: (performance.now() - started) / 1000 }
  } finally {
    pool.dispose()
    input.dispose()
  }
}

export interface SourceProbe {
  codec: string | null
  codecString: string | null
  width: number
  height: number
  rotation: number
  canDecode: boolean
  /** HDR(넓은 밝기 범위) 영상인지. HDR 영상은 캔버스에 그릴 때 보통 밝기 범위로 바뀐다. */
  hdr: boolean
  colorSpace: VideoColorSpaceInit
  /** 분석 단계가 보는 화면(캔버스에 그린 결과)의 밝기 통계. 너무 어둡거나 뿌옇게 바뀌지 않았는지 확인하는 용도. */
  frames: Array<{ timeSec: number; mean: number; std: number; p01: number; p99: number }>
}

/** 영상이 어떻게 해독되는지와, 분석 단계가 보는 화면의 밝기 통계를 낸다. */
export async function probeSource(file: Blob, everySec = 2): Promise<SourceProbe> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('영상 트랙이 없습니다')
    const [canDecode, hdr, colorSpace, codecString] = await Promise.all([
      track.canDecode(),
      track.hasHighDynamicRange(),
      track.getColorSpace(),
      track.getCodecParameterString(),
    ])
    const probe: SourceProbe = { codec: track.codec, codecString, width: track.displayWidth, height: track.displayHeight, rotation: track.rotation, canDecode, hdr, colorSpace, frames: [] }
    if (!canDecode) return probe
    const canvas = new OffscreenCanvas(track.displayWidth, track.displayHeight)
    const context = canvas.getContext('2d', { alpha: false })
    const small = new OffscreenCanvas(480, Math.max(1, Math.round((480 * track.displayHeight) / track.displayWidth)))
    const smallContext = small.getContext('2d', { willReadFrequently: true })
    if (!context || !smallContext) throw new Error('캔버스를 만들지 못했습니다')
    const sink = new VideoSampleSink(track)
    const duration = await track.computeDuration()
    for (let time = await track.getFirstTimestamp(); time < duration; time += everySec) {
      const sample = await sink.getSample(time)
      if (!sample) continue
      try {
        sample.draw(context, 0, 0, canvas.width, canvas.height)
        smallContext.drawImage(canvas, 0, 0, small.width, small.height)
        const pixels = smallContext.getImageData(0, 0, small.width, small.height).data
        const histogram = new Uint32Array(256)
        let sum = 0
        let squares = 0
        const count = pixels.length / 4
        for (let i = 0; i < pixels.length; i += 4) {
          const luma = Math.round(0.299 * (pixels[i] ?? 0) + 0.587 * (pixels[i + 1] ?? 0) + 0.114 * (pixels[i + 2] ?? 0))
          histogram[luma] = (histogram[luma] ?? 0) + 1
          sum += luma
          squares += luma * luma
        }
        const quantile = (fraction: number) => {
          let seen = 0
          for (let value = 0; value < 256; value += 1) {
            seen += histogram[value] ?? 0
            if (seen >= count * fraction) return value
          }
          return 255
        }
        const mean = sum / count
        probe.frames.push({ timeSec: sample.timestamp, mean, std: Math.sqrt(Math.max(0, squares / count - mean * mean)), p01: quantile(0.01), p99: quantile(0.99) })
      } finally {
        sample.close()
      }
    }
    return probe
  } finally {
    input.dispose()
  }
}
