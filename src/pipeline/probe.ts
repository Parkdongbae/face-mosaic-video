import { ALL_FORMATS, BlobSource, Input } from 'mediabunny'
import type { VideoInfo } from './types'

/** 파일을 열어 길이·해상도·코덱 등을 읽는다. 파일 내용은 필요한 부분만 읽는다. */
export async function probeVideo(file: File): Promise<VideoInfo> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    if (!(await input.canRead())) {
      throw new Error('이 형식은 아직 열 수 없습니다. 지금 단계에서는 MP4·MOV·WebM만 지원합니다.')
    }
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('영상 트랙이 없는 파일입니다.')
    const audio = await input.getPrimaryAudioTrack()
    const [durationSec, stats, canDecodeVideo, videoCodecString] = await Promise.all([
      input.computeDuration(),
      video.computePacketStats(120),
      video.canDecode(),
      video.getCodecParameterString(),
    ])
    return {
      name: file.name,
      sizeBytes: file.size,
      durationSec,
      width: video.displayWidth,
      height: video.displayHeight,
      rotation: video.rotation,
      fps: stats.averagePacketRate,
      frameCountEstimate: Math.round(stats.averagePacketRate * durationSec),
      videoCodec: video.codec,
      videoCodecString,
      audioCodec: audio?.codec ?? null,
      hasAudio: audio !== null,
      canDecodeVideo,
    }
  } finally {
    input.dispose()
  }
}
