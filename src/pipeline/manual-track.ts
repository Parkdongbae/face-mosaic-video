import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from 'mediabunny'
import { clampRect, type Rect } from '../core/geometry'
import { trackThrough, type GrayFrame } from '../core/template-track'
import type { JobHooks } from './analyze'
import { JobCanceledError } from './types'

/** 추적 계산용으로 줄인 프레임의 폭(픽셀). 원본 프레임은 한 장씩만 다루고 바로 닫는다. */
const SMALL_WIDTH = 320

export interface ManualTrackRequest {
  /** 사용자가 얼굴을 표시한 프레임의 시각(마이크로초) */
  timeUs: number
  /** 표시한 상자(원본 해상도 픽셀) */
  box: Rect
  /** 앞뒤로 따라갈 최대 길이(초) */
  spanSec: number
}

export interface ManualTrackPoint {
  timeUs: number
  box: Rect
}

/**
 * 사용자가 표시한 얼굴을 앞뒤 프레임으로 따라가 상자 목록을 만든다(F-11).
 * 표시한 시각 앞뒤 spanSec 구간만 해독하고, 작게 줄인 흑백 그림만 잠시 들고 있다가 버린다.
 * 놓친 지점에서 멈추므로, 엉뚱한 곳을 계속 가리지 않는다.
 */
export async function trackManualBox(file: Blob, request: ManualTrackRequest, hooks: JobHooks = {}): Promise<ManualTrackPoint[]> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('영상 트랙이 없는 파일입니다.')
    const width = track.displayWidth
    const height = track.displayHeight
    const scale = Math.min(1, SMALL_WIDTH / width)
    const smallWidth = Math.max(1, Math.round(width * scale))
    const smallHeight = Math.max(1, Math.round(height * scale))
    const canvas = new OffscreenCanvas(smallWidth, smallHeight)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new Error('추적용 캔버스를 만들지 못했습니다')

    const centerSec = request.timeUs / 1e6
    const first = await track.getFirstTimestamp()
    const startSec = Math.max(first, centerSec - request.spanSec)
    const endSec = centerSec + request.spanSec
    const span = Math.max(1e-6, endSec - startSec)

    const frames: GrayFrame[] = []
    const times: number[] = []
    for await (const sample of new VideoSampleSink(track).samples(startSec, endSec)) {
      try {
        if (hooks.signal?.aborted) throw new JobCanceledError()
        times.push(sample.microsecondTimestamp)
        sample.draw(context, 0, 0, smallWidth, smallHeight)
        hooks.onProgress?.({ phase: 'analyze', fraction: Math.min(0.9, ((sample.timestamp - startSec) / span) * 0.9), frames: times.length, fps: 0 })
      } finally {
        sample.close()
      }
      const rgba = context.getImageData(0, 0, smallWidth, smallHeight).data
      const gray = new Uint8Array(smallWidth * smallHeight)
      for (let i = 0; i < gray.length; i += 1) {
        gray[i] = ((rgba[i * 4] ?? 0) * 77 + (rgba[i * 4 + 1] ?? 0) * 150 + (rgba[i * 4 + 2] ?? 0) * 29) >> 8
      }
      frames.push({ data: gray, width: smallWidth, height: smallHeight })
    }
    if (frames.length === 0) return [{ timeUs: request.timeUs, box: request.box }]

    // 사용자가 표시한 프레임(가장 가까운 시각)
    let start = 0
    for (let i = 1; i < times.length; i += 1) {
      if (Math.abs((times[i] ?? 0) - request.timeUs) < Math.abs((times[start] ?? 0) - request.timeUs)) start = i
    }
    const smallBox = { x: request.box.x * scale, y: request.box.y * scale, width: request.box.width * scale, height: request.box.height * scale }
    const toSource = (box: Rect): Rect | null =>
      clampRect({ x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale }, width, height)

    const points: ManualTrackPoint[] = [{ timeUs: times[start] ?? request.timeUs, box: request.box }]
    for (const direction of [-1, 1] as const) {
      for (const found of trackThrough(frames, start, smallBox, direction)) {
        const box = toSource(found.box)
        const timeUs = times[found.index]
        if (box && timeUs !== undefined) points.push({ timeUs, box })
      }
    }
    points.sort((a, b) => a.timeUs - b.timeUs)
    hooks.onProgress?.({ phase: 'analyze', fraction: 1, frames: frames.length, fps: 0 })
    return points
  } finally {
    input.dispose()
  }
}
