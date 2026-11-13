import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  StreamTarget,
  type ConversionVideoOptions,
  type Quality,
  type StreamTargetChunk,
  type VideoSample,
} from 'mediabunny'
import { MOSAIC_DEFAULTS, type OutputQuality } from '../config/mosaic-defaults'
import { clampRect } from '../core/geometry'
import { NO_EDITS, planMasks, type Edits } from '../core/mask-plan'
import { nearestIndex } from '../core/tracker'
import type { JobHooks } from './analyze'
import { applyPixelMosaic } from './mosaic'
import { JobCanceledError, type AnalysisResult, type JobSettings, type RenderStats, type TimeRange } from './types'

const QUALITY: Record<OutputQuality, Quality> = {
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  'very-high': QUALITY_VERY_HIGH,
}

export interface RenderOutput {
  stats: RenderStats
  /** 디스크에 바로 쓰지 않은 경우에만 결과 파일 내용 */
  buffer: ArrayBuffer | null
}

/**
 * 2차(렌더링): 영상을 처음부터 다시 해독해 저장된 상자에 모자이크를 그리고 H.264 MP4 로 압축한다.
 * 소리는 가능하면 재압축 없이 그대로 옮긴다. 원본 파일은 읽기만 한다.
 * writable 이 있으면 디스크에 바로 쓰고(스트리밍), 없으면 메모리에 모은다.
 */
export async function renderVideo(
  file: Blob,
  analysis: AnalysisResult,
  settings: JobSettings,
  writable: FileSystemWritableFileStream | null,
  hooks: JobHooks = {},
  range: TimeRange | null = null,
  edits: Edits = NO_EDITS,
): Promise<RenderOutput> {
  const started = performance.now()
  // H.264 는 가로·세로가 짝수여야 하므로 홀수면 1픽셀 잘라 낸다.
  const width = analysis.width - (analysis.width % 2)
  const height = analysis.height - (analysis.height % 2)
  // 미리보기와 똑같은 계산으로 가릴 사각형을 정한다(영역 규칙 + 수동 추가·삭제).
  const plan = planMasks(analysis, settings, edits)

  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('렌더링용 캔버스를 만들지 못했습니다')
  const scratch = new OffscreenCanvas(settings.blocksAcross, settings.blocksAcross)

  // Mediabunny 는 끝날 때뿐 아니라 취소·오류 때도 스트림을 닫는다. 파일 스트림을 닫으면 쓰다 만 내용이
  // 그대로 저장되므로, 실제 닫기(저장 확정)와 버리기는 이 함수가 성공 여부를 보고 직접 한다.
  let bytesWritten = 0
  const guarded = writable
    ? new WritableStream<StreamTargetChunk>({
        async write(chunk) {
          await writable.write({ type: 'write', data: chunk.data, position: chunk.position })
          bytesWritten = Math.max(bytesWritten, chunk.position + chunk.data.byteLength)
        },
      })
    : null

  let frames = 0
  let maskedFrames = 0
  let timestampMismatches = 0
  let lastReport = 0
  let fraction = 0
  // 구간(trim)을 주면 Mediabunny 가 프레임 시각을 구간 시작만큼 당겨서 넘겨준다.
  // 분석 결과는 원본 시각 기준이므로 첫 프레임에서 그 차이를 알아내 되돌린다.
  const rangeStartUs = range ? Math.round(range.startSec * 1e6) : 0
  let sourceOffsetUs: number | null = range ? null : 0
  const exact = (timestampUs: number) => {
    const found = nearestIndex(analysis.timestampsUs, timestampUs)
    return found >= 0 && Math.abs((analysis.timestampsUs[found] ?? 0) - timestampUs) <= 1
  }

  const process = (sample: VideoSample): VideoFrame => {
    const timestampUs = sample.microsecondTimestamp
    sample.draw(context, 0, 0)
    if (sourceOffsetUs === null) sourceOffsetUs = !exact(timestampUs + rangeStartUs) && exact(timestampUs) ? 0 : rangeStartUs
    const sourceUs = timestampUs + sourceOffsetUs
    const index = nearestIndex(analysis.timestampsUs, sourceUs)
    if (index < 0 || Math.abs((analysis.timestampsUs[index] ?? 0) - sourceUs) > 1) timestampMismatches += 1
    const boxes = index >= 0 ? (plan[index] ?? []) : []
    for (const box of boxes) {
      const clipped = clampRect(box, width, height)
      if (clipped) applyPixelMosaic(context, clipped, settings.blocksAcross, scratch)
    }
    frames += 1
    if (boxes.length > 0) maskedFrames += 1

    const now = performance.now()
    if (now - lastReport > 250) {
      lastReport = now
      hooks.onProgress?.({ phase: 'render', fraction, frames, fps: (frames * 1000) / Math.max(1, now - started) })
    }
    // 캔버스 내용을 지금 시점의 프레임으로 복사한다. 원본 프레임의 시각·길이를 그대로 넘긴다.
    const durationUs = sample.microsecondDuration
    return new VideoFrame(canvas, durationUs > 0 ? { timestamp: timestampUs, duration: durationUs } : { timestamp: timestampUs })
  }

  const attempt = async (hardwareAcceleration: NonNullable<ConversionVideoOptions['hardwareAcceleration']>) => {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
    const target = guarded ? new StreamTarget(guarded, { chunked: true }) : new BufferTarget()
    const output = new Output({ format: new Mp4OutputFormat(guarded ? { fastStart: false } : {}), target })
    const video: ConversionVideoOptions = {
      codec: 'avc',
      quality: QUALITY[settings.quality],
      forceTranscode: true,
      keyFrameInterval: MOSAIC_DEFAULTS.keyFrameIntervalSec,
      // 회전은 메타데이터로 남기지 않고 프레임에 직접 반영한다(모자이크 좌표와 같은 방향).
      allowTransformationMetadata: false,
      hardwareAcceleration,
      process,
      processedWidth: width,
      processedHeight: height,
    }
    if (width !== analysis.width || height !== analysis.height) {
      video.crop = { left: 0, top: 0, width, height }
    }
    const trim = range ? (range.endSec === null ? { start: range.startSec } : { start: range.startSec, end: range.endSec }) : null
    const conversion = await Conversion.init({
      input,
      output,
      tracks: 'primary',
      video,
      showWarnings: false,
      ...(trim ? { trim } : {}),
    })
    return { input, target, conversion }
  }

  let job = await attempt('no-preference')
  if (!job.conversion.isValid) {
    job.input.dispose()
    job = await attempt('prefer-software')
  }
  const { input, target, conversion } = job

  try {
    const discarded = conversion.discardedTracks.map((item) => `${item.track.type}: ${item.reason}`)
    if (!conversion.isValid) {
      throw new Error(`이 컴퓨터에서 이 영상을 H.264로 저장할 수 없습니다(${discarded.join(', ') || '원인 미상'}).`)
    }
    const audioTracksIn = (await input.getAudioTracks()).length
    const audioTracksOut = conversion.utilizedTracks.filter((track) => track.type === 'audio').length

    conversion.onProgress = (value) => {
      fraction = value
    }
    const onAbort = () => void conversion.cancel()
    hooks.signal?.addEventListener('abort', onAbort)
    try {
      if (hooks.signal?.aborted) throw new JobCanceledError()
      await conversion.execute()
    } catch (error) {
      if (error instanceof ConversionCanceledError) throw new JobCanceledError()
      throw error
    } finally {
      hooks.signal?.removeEventListener('abort', onAbort)
    }

    const buffer = target instanceof BufferTarget ? target.buffer : null
    let bytes = buffer?.byteLength ?? 0
    if (writable) {
      await writable.close()
      bytes = bytesWritten
    }
    const elapsedMs = performance.now() - started
    hooks.onProgress?.({ phase: 'render', fraction: 1, frames, fps: (frames * 1000) / Math.max(1, elapsedMs) })
    return {
      stats: { frames, maskedFrames, timestampMismatches, audioTracksIn, audioTracksOut, discarded, bytes, elapsedMs },
      buffer,
    }
  } catch (error) {
    // 실패·취소 시 쓰다 만 결과는 버린다. 원본에는 손대지 않는다.
    await writable?.abort().catch(() => undefined)
    throw error
  } finally {
    input.dispose()
  }
}
