import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { BASE_FPS, MOSAIC_DEFAULTS, SENSITIVITY_PRESETS, type SensitivityPreset } from '../config/mosaic-defaults'
import { detectSchedule } from '../core/detect-schedule'
import { frameRateOf, tileGrid, tileLayout } from '../core/geometry'
import { SceneCutFinder } from '../core/scene'
import { FaceTracker, splitWeakTailsAtCuts } from '../core/tracker'
import type { FaceBox } from '../detectors/types'
import { DetectorPool, recommendedPoolSize } from './detector-pool'
import { JobCanceledError, type AnalysisResult, type JobSettings, type ProgressInfo } from './types'

/** 1단계 시험 결과로 확정한 검출 모델 */
const DETECTOR_ID = 'yunet'

export interface JobHooks {
  onProgress?: (progress: ProgressInfo) => void
  signal?: AbortSignal
}

/**
 * 1차(분석): 영상을 처음부터 해독하며 얼굴을 검출·추적하고 상자 데이터만 남긴다.
 * 프레임은 검출 워커 수만큼만 동시에 살아 있고, 검출이 끝나면 바로 닫힌다(프레임을 모아 두지 않는다).
 * preset 은 진단·시험용으로만 바꿔 넣는다(앱은 감도 설정의 기본값을 쓴다).
 */
export async function analyzeVideo(
  file: Blob,
  settings: JobSettings,
  hooks: JobHooks = {},
  preset: SensitivityPreset = SENSITIVITY_PRESETS[settings.sensitivity],
): Promise<AnalysisResult> {
  const started = performance.now()
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  let pool: DetectorPool | null = null

  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('영상 트랙이 없는 파일입니다.')
    if (!(await track.canDecode())) {
      throw new Error(`이 브라우저에서 해독할 수 없는 영상입니다(코덱: ${track.codec ?? '알 수 없음'}).`)
    }
    // 약한 검출까지 받아 온다. 새 얼굴로 칠지는 추적기가 감도 기준값으로 가른다.
    pool = await DetectorPool.create(
      recommendedPoolSize(navigator.hardwareConcurrency || 1),
      DETECTOR_ID,
      Math.min(MOSAIC_DEFAULTS.candidateScore, preset.scoreThreshold),
    )
    const detectors = pool

    const width = track.displayWidth
    const height = track.displayHeight
    const [firstTimestamp, duration, stats] = await Promise.all([track.getFirstTimestamp(), track.computeDuration(), track.computePacketStats(120)])
    const span = Math.max(1e-6, duration - firstTimestamp)
    const fps = stats.averagePacketRate > 0 ? stats.averagePacketRate : BASE_FPS
    const schedule = detectSchedule(fps, preset)

    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('분석용 캔버스를 만들지 못했습니다')
    // 타일 격자가 여러 개면 타일 검출 때마다 차례로 돌아가며 쓴다(경계에 걸린 얼굴을 다른 격자가 잡는다).
    const tileSets = preset.tileGrids
      .map((across) => {
        const grid = tileGrid(width, height, across, MOSAIC_DEFAULTS.tileOverlap)
        return tileLayout(width, height, grid.cols, grid.rows, MOSAIC_DEFAULTS.tileOverlap)
      })
      .filter((tiles) => tiles.length > 0)

    const timestampsUs: number[] = []
    // 프레임별 검출 상자(이미지가 아니라 좌표만). 검출 워커가 순서와 무관하게 끝내므로 프레임 번호로 받는다.
    const detections: FaceBox[][] = []
    // 장면이 바뀌는 곳: 검출 워커가 프레임마다 돌려주는 아주 작은 흑백 그림을 앞 프레임과 견줘 찾는다.
    const scenes = new SceneCutFinder(schedule.fullEvery)
    const inFlight = new Set<Promise<void>>()
    const failure: { error: Error | null } = { error: null }
    let completed = 0
    let lastReport = 0

    const sink = new VideoSampleSink(track)
    for await (const sample of sink.samples()) {
      const frame = timestampsUs.length
      const detect = frame % schedule.fullEvery === 0
      let bitmap: ImageBitmap | null = null
      let timestampSec: number
      try {
        if (hooks.signal?.aborted) throw new JobCanceledError()
        if (failure.error) throw failure.error
        timestampSec = sample.timestamp
        timestampsUs.push(sample.microsecondTimestamp)
        if (detect) {
          // 회전·뒤집기 메타데이터가 적용된 방향으로 그린다(좌표 기준을 표시 방향으로 통일).
          sample.draw(context, 0, 0, width, height)
          bitmap = canvas.transferToImageBitmap()
        }
      } finally {
        sample.close()
      }

      detections.push([])
      if (bitmap) {
        try {
          // 빈 검출 워커가 생길 때까지 기다린다. 해독이 검출보다 빨라도 프레임이 쌓이지 않는다.
          await detectors.acquire()
        } catch (error) {
          bitmap.close()
          throw error
        }
        const useTiles = tileSets.length > 0 && frame % schedule.tileEvery === 0
        const tiles = useTiles ? (tileSets[Math.floor(frame / schedule.tileEvery) % tileSets.length] ?? []) : []
        const job: Promise<void> = detectors
          .detectFrame(bitmap, tiles)
          .then((result) => {
            detections[frame] = result.boxes
            scenes.add(frame, result.signature)
            completed += 1
          })
          .catch((error: unknown) => {
            failure.error ??= error instanceof Error ? error : new Error(String(error))
          })
          .finally(() => {
            inFlight.delete(job)
          })
        inFlight.add(job)
      } else {
        completed += 1
      }

      const now = performance.now()
      if (now - lastReport > 250) {
        lastReport = now
        hooks.onProgress?.({
          phase: 'analyze',
          fraction: Math.max(0, Math.min(1, (timestampSec - firstTimestamp) / span)),
          frames: completed,
          fps: (completed * 1000) / Math.max(1, now - started),
        })
      }
    }
    await Promise.all(inFlight)
    if (hooks.signal?.aborted) throw new JobCanceledError()
    if (failure.error) throw failure.error

    // 추적은 프레임 순서대로 해야 하므로 검출이 모두 끝난 뒤 한 번에 돈다.
    // 같은 얼굴로 이어 붙이는 한도는 "끊긴 사이를 계속 가리는 최대 시간"과 같게 둔다(가림 계획이 그 사이를 채운다).
    // 프레임 수로 바꿀 때는 가림 계획(core/mask-plan.ts)과 똑같이 실제 프레임 시각에서 잰 속도를 쓴다.
    // 둘이 어긋나면, 추적기가 이은 공백을 가림 계획이 보간 한도 밖으로 보고 가운데를 비울 수 있다.
    const trackFps = frameRateOf(timestampsUs)
    const tracker = new FaceTracker({
      maxGapFrames: Math.max(Math.round((settings.maxGapFrames * trackFps) / BASE_FPS), Math.round(MOSAIC_DEFAULTS.bridgeMaxSec * trackFps)),
      weakGapFrames: Math.round(MOSAIC_DEFAULTS.weakLinkMaxSec * trackFps),
      cutGapFrames: Math.round((settings.maxGapFrames * trackFps) / BASE_FPS),
      strongScore: preset.scoreThreshold,
      fps: trackFps,
    })
    const cuts = new Set(scenes.cuts)
    let detectionCount = 0
    for (let frame = 0; frame < detections.length; frame += 1) {
      // 장면이 바뀌면 앞 장면의 얼굴은 곧바로 다시 잡힐 때만 이어 붙인다(오래 끊긴 얼굴을 되살리지 않는다).
      if (cuts.has(frame)) tracker.cut()
      const boxes = detections[frame] ?? []
      // 영역 규칙은 여기서 적용하지 않는다(가림 계획을 만들 때 적용). 화면 전체의 얼굴을 추적해 둔다.
      detectionCount += boxes.length
      tracker.update(frame, boxes)
    }

    const elapsedMs = performance.now() - started
    hooks.onProgress?.({
      phase: 'analyze',
      fraction: 1,
      frames: timestampsUs.length,
      fps: (timestampsUs.length * 1000) / Math.max(1, elapsedMs),
    })
    return {
      width,
      height,
      frameCount: timestampsUs.length,
      timestampsUs,
      // 장면이 바뀐 뒤 약한 검출로만 이어진 구간은 번호를 나눈다(그 가림을 지워도 앞 장면의 얼굴 가림은 남게).
      tracks: splitWeakTailsAtCuts(tracker.finish(), scenes.cuts),
      detections: detectionCount,
      sceneCuts: scenes.cuts,
      elapsedMs,
    }
  } finally {
    pool?.dispose()
    input.dispose()
  }
}
