import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, VideoSampleSink } from 'mediabunny'
import type { Rect } from '../core/geometry'
import { DetectorPool } from './detector-pool'

export interface TrackSummary {
  codec: string | null
  packets: number
  firstTimestamp: number
  endTimestamp: number
  /** 첫 패킷이 키프레임인지 */
  startsWithKey: boolean
}

export interface MediaSummary {
  durationSec: number
  width: number
  height: number
  rotation: number
  video: TrackSummary
  audio: (TrackSummary & { sampleRate: number; channels: number }) | null
  /** 실제로 끝까지 해독해 센 프레임 수(decode=true 일 때만) */
  decodedFrames: number | null
}

/** 결과 검증용(glm.md 7장): 파일을 다시 열어 길이·프레임 수·해상도·소리 트랙을 요약한다. */
export async function summarizeMedia(blob: Blob, decode = false): Promise<MediaSummary> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('영상 트랙이 없습니다')
    const audio = await input.getPrimaryAudioTrack()

    const summarize = async (track: NonNullable<typeof video> | NonNullable<typeof audio>): Promise<TrackSummary> => {
      const stats = await track.computePacketStats()
      const first = await new EncodedPacketSink(track).getFirstPacket()
      return {
        codec: track.codec,
        packets: stats.packetCount,
        firstTimestamp: await track.getFirstTimestamp(),
        endTimestamp: await track.computeDuration(),
        startsWithKey: first?.type === 'key',
      }
    }

    let decodedFrames: number | null = null
    if (decode) {
      decodedFrames = 0
      for await (const sample of new VideoSampleSink(video).samples()) {
        sample.close()
        decodedFrames += 1
      }
    }

    return {
      durationSec: await input.computeDuration(),
      width: video.displayWidth,
      height: video.displayHeight,
      rotation: video.rotation,
      video: await summarize(video),
      audio: audio ? { ...(await summarize(audio)), sampleRate: audio.sampleRate, channels: audio.numberOfChannels } : null,
      decodedFrames,
    }
  } finally {
    input.dispose()
  }
}

async function grabFrame(blob: Blob, timeSec: number): Promise<{ data: Uint8ClampedArray; width: number; height: number; timestamp: number }> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('영상 트랙이 없습니다')
    const sample = await new VideoSampleSink(video).getSample(timeSec)
    if (!sample) throw new Error(`${timeSec}초 위치의 프레임이 없습니다`)
    try {
      const canvas = new OffscreenCanvas(video.displayWidth, video.displayHeight)
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('캔버스를 만들지 못했습니다')
      sample.draw(context, 0, 0)
      const image = context.getImageData(0, 0, canvas.width, canvas.height)
      return { data: image.data, width: canvas.width, height: canvas.height, timestamp: sample.timestamp }
    } finally {
      sample.close()
    }
  } finally {
    input.dispose()
  }
}

export interface FrameComparison {
  sourceTimestamp: number
  outputTimestamp: number
  /** 가린 영역 안에서 원본과 결과의 평균 밝기 차이(0~255). 커야 한다. */
  insideDiff: number
  /** 가린 영역 밖에서의 평균 차이. 재압축 오차 수준으로 작아야 한다. */
  outsideDiff: number
  /** 가린 영역 안에서 결과 화면의 가로 이웃 픽셀 차이 평균. 모자이크면 원본보다 훨씬 작다. */
  insideDetailOutput: number
  insideDetailSource: number
}

/** 같은 시각의 원본·결과 프레임을 비교해 모자이크가 실제로 적용됐는지 확인한다. */
export async function compareFrames(source: Blob, output: Blob, timeSec: number, masks: Rect[]): Promise<FrameComparison> {
  const [a, b] = await Promise.all([grabFrame(source, timeSec), grabFrame(output, timeSec)])
  const width = Math.min(a.width, b.width)
  const height = Math.min(a.height, b.height)
  const inside = new Uint8Array(width * height)
  for (const mask of masks) {
    for (let y = Math.max(0, Math.floor(mask.y)); y < Math.min(height, mask.y + mask.height); y += 1) {
      for (let x = Math.max(0, Math.floor(mask.x)); x < Math.min(width, mask.x + mask.width); x += 1) inside[y * width + x] = 1
    }
  }
  const luma = (data: Uint8ClampedArray, stride: number, x: number, y: number) => {
    const i = (y * stride + x) * 4
    return 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)
  }
  let insideSum = 0
  let insideCount = 0
  let outsideSum = 0
  let outsideCount = 0
  let detailOutput = 0
  let detailSource = 0
  let detailCount = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const la = luma(a.data, a.width, x, y)
      const lb = luma(b.data, b.width, x, y)
      if (inside[y * width + x]) {
        insideSum += Math.abs(la - lb)
        insideCount += 1
        if (x + 1 < width && inside[y * width + x + 1]) {
          detailOutput += Math.abs(lb - luma(b.data, b.width, x + 1, y))
          detailSource += Math.abs(la - luma(a.data, a.width, x + 1, y))
          detailCount += 1
        }
      } else {
        outsideSum += Math.abs(la - lb)
        outsideCount += 1
      }
    }
  }
  return {
    sourceTimestamp: a.timestamp,
    outputTimestamp: b.timestamp,
    insideDiff: insideCount > 0 ? insideSum / insideCount : 0,
    outsideDiff: outsideCount > 0 ? outsideSum / outsideCount : 0,
    insideDetailOutput: detailCount > 0 ? detailOutput / detailCount : 0,
    insideDetailSource: detailCount > 0 ? detailSource / detailCount : 0,
  }
}

/** 조각이 실제로 재생되는지 확인: 맨 앞과 맨 끝의 프레임을 count 장씩 해독해 성공한 장수를 돌려준다. */
export async function decodeEdges(blob: Blob, count: number): Promise<{ head: number; tail: number }> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('영상 트랙이 없습니다')
    const sink = new VideoSampleSink(video)
    const first = await video.getFirstTimestamp()
    const end = await video.computeDuration()
    let head = 0
    for await (const sample of sink.samples(first)) {
      sample.close()
      head += 1
      if (head >= count) break
    }
    let tail = 0
    for await (const sample of sink.samples(Math.max(first, end - 1))) {
      sample.close()
      tail += 1
    }
    return { head, tail }
  } finally {
    input.dispose()
  }
}

/**
 * 주어진 시각들의 프레임에서 검출되는 얼굴 상자를 돌려준다(전체 화면 + 2x2 타일).
 * 분할 경계 전후 프레임에 얼굴이 드러나지 않았는지 확인하는 데 쓴다.
 */
export async function detectFacesAt(blob: Blob, timesSec: number[], scoreThreshold: number): Promise<Rect[][]> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  const pool = await DetectorPool.create(1, 'yunet', scoreThreshold)
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('영상 트랙이 없습니다')
    const width = video.displayWidth
    const height = video.displayHeight
    const halfW = Math.ceil(width * 0.6)
    const halfH = Math.ceil(height * 0.6)
    const tiles = [
      { x: 0, y: 0, width: halfW, height: halfH },
      { x: width - halfW, y: 0, width: halfW, height: halfH },
      { x: 0, y: height - halfH, width: halfW, height: halfH },
      { x: width - halfW, y: height - halfH, width: halfW, height: halfH },
    ]
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('캔버스를 만들지 못했습니다')
    const sink = new VideoSampleSink(video)
    const counts: Rect[][] = []
    for (const time of timesSec) {
      const sample = await sink.getSample(time)
      if (!sample) {
        counts.push([])
        continue
      }
      try {
        sample.draw(context, 0, 0, width, height)
      } finally {
        sample.close()
      }
      await pool.acquire()
      const boxes = await pool.detect(canvas.transferToImageBitmap(), tiles)
      counts.push(boxes.map((box) => ({ x: box.x, y: box.y, width: box.width, height: box.height })))
    }
    return counts
  } finally {
    pool.dispose()
    input.dispose()
  }
}
