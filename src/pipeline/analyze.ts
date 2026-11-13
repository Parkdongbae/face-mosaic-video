import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { MOSAIC_DEFAULTS, SENSITIVITY_PRESETS } from '../config/mosaic-defaults'
import { tileLayout } from '../core/geometry'
import { FaceTracker } from '../core/tracker'
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
 */
export async function analyzeVideo(file: Blob, settings: JobSettings, hooks: JobHooks = {}): Promise<AnalysisResult> {
  const started = performance.now()
  const preset = SENSITIVITY_PRESETS[settings.sensitivity]
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  let pool: DetectorPool | null = null

  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('영상 트랙이 없는 파일입니다.')
    if (!(await track.canDecode())) {
      throw new Error(`이 브라우저에서 해독할 수 없는 영상입니다(코덱: ${track.codec ?? '알 수 없음'}).`)
    }
    pool = await DetectorPool.create(
      recommendedPoolSize(navigator.hardwareConcurrency || 1),
      DETECTOR_ID,
      preset.scoreThreshold,
    )
    const detectors = pool

    const width = track.displayWidth
    const height = track.displayHeight
    const [firstTimestamp, duration] = await Promise.all([track.getFirstTimestamp(), track.computeDuration()])
    const span = Math.max(1e-6, duration - firstTimestamp)

    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('분석용 캔버스를 만들지 못했습니다')
    const tiles = tileLayout(width, height, preset.tileCols, preset.tileRows, MOSAIC_DEFAULTS.tileOverlap)

    const timestampsUs: number[] = []
    // 프레임별 검출 상자(이미지가 아니라 좌표만). 검출 워커가 순서와 무관하게 끝내므로 프레임 번호로 받는다.
    const detections: FaceBox[][] = []
    const inFlight = new Set<Promise<void>>()
    const failure: { error: Error | null } = { error: null }
    let completed = 0
    let lastReport = 0

    const sink = new VideoSampleSink(track)
    for await (const sample of sink.samples()) {
      let bitmap: ImageBitmap
      let timestampSec: number
      try {
        if (hooks.signal?.aborted) throw new JobCanceledError()
        if (failure.error) throw failure.error
        timestampSec = sample.timestamp
        timestampsUs.push(sample.microsecondTimestamp)
        // 회전·뒤집기 메타데이터가 적용된 방향으로 그린다(좌표 기준을 표시 방향으로 통일).
        sample.draw(context, 0, 0, width, height)
        bitmap = canvas.transferToImageBitmap()
      } finally {
        sample.close()
      }

      const frame = timestampsUs.length - 1
      detections.push([])
      try {
        // 빈 검출 워커가 생길 때까지 기다린다. 해독이 검출보다 빨라도 프레임이 쌓이지 않는다.
        await detectors.acquire()
      } catch (error) {
        bitmap.close()
        throw error
      }
      const useTiles = frame % preset.tileIntervalFrames === 0
      const job: Promise<void> = detectors
        .detect(bitmap, useTiles ? tiles : [])
        .then((boxes) => {
          detections[frame] = boxes
          completed += 1
        })
        .catch((error: unknown) => {
          failure.error ??= error instanceof Error ? error : new Error(String(error))
        })
        .finally(() => {
          inFlight.delete(job)
        })
      inFlight.add(job)

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
    const tracker = new FaceTracker({ maxGapFrames: settings.maxGapFrames })
    let detectionCount = 0
    for (let frame = 0; frame < detections.length; frame += 1) {
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
      tracks: tracker.finish(),
      detections: detectionCount,
      elapsedMs,
    }
  } finally {
    pool?.dispose()
    input.dispose()
  }
}
