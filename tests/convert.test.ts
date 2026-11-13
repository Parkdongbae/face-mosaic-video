import { describe, expect, it } from 'vitest'
import { buildConvertArgs, parseStreams } from '../src/pipeline/convert'

const AVI_LOG = `Input #0, avi, from '/input/source.avi':
  Metadata:
    software        : Lavf61.7.100
  Duration: 00:00:10.03, start: 0.000000, bitrate: 3866 kb/s
  Stream #0:0: Video: mpeg4 (Simple Profile) (FMP4 / 0x34504D46), yuv420p, 1280x720 [SAR 1:1 DAR 16:9], 3725 kb/s, 30 fps, 30 tbr, 30 tbn
  Stream #0:1: Audio: mp3 (U[0][0][0] / 0x0055), 48000 Hz, stereo, fltp, 128 kb/s
At least one output file must be specified`

const MTS_LOG = `Input #0, mpegts, from '/input/source.mts':
  Duration: 01:02:03.50, start: 1.400000, bitrate: 1650 kb/s
  Program 1
  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(progressive), 1920x1080 [SAR 1:1 DAR 16:9], 30 fps, 30 tbr, 90k tbn
  Stream #0:1[0x101](und): Audio: ac3 ([129][0][0][0] / 0x0081), 48000 Hz, stereo, fltp, 192 kb/s`

describe('ffmpeg 입력 정보 읽기', () => {
  it('AVI: 길이·코덱·해상도', () => {
    expect(parseStreams(AVI_LOG)).toEqual({ durationSec: 10.03, videoCodec: 'mpeg4', audioCodec: 'mp3', width: 1280, height: 720 })
  })
  it('MTS: 한 시간이 넘는 길이와 H.264 + AC3', () => {
    const streams = parseStreams(MTS_LOG)
    expect(streams.durationSec).toBeCloseTo(3723.5, 5)
    expect(streams.videoCodec).toBe('h264')
    expect(streams.audioCodec).toBe('ac3')
    expect(streams.width).toBe(1920)
  })
  it('소리가 없는 파일', () => {
    expect(parseStreams(AVI_LOG.split('\n').filter((line) => !line.includes('Audio')).join('\n')).audioCodec).toBeNull()
  })
  it('영상 정보를 찾지 못하면 null', () => {
    expect(parseStreams('Invalid data found when processing input').videoCodec).toBeNull()
  })
})

describe('변환 명령 만들기', () => {
  it('H.264 가 아닌 영상은 다시 압축하고 소리는 AAC 로 바꾼다', () => {
    const args = buildConvertArgs('/input/source.avi', parseStreams(AVI_LOG), null)
    expect(args.join(' ')).toContain('-c:v libx264')
    expect(args.join(' ')).toContain('-c:a aac')
    expect(args.at(-1)).toBe('converted.mp4')
  })
  it('H.264 영상은 재압축 없이 복사한다', () => {
    const args = buildConvertArgs('/input/source.mts', parseStreams(MTS_LOG), null)
    expect(args.join(' ')).toContain('-c:v copy')
    expect(args.join(' ')).toContain('-c:a aac')
  })
  it('AAC 소리는 그대로 복사하고, 소리가 없으면 -an', () => {
    const streams = parseStreams(MTS_LOG)
    expect(buildConvertArgs('/in', { ...streams, audioCodec: 'aac' }, null).join(' ')).toContain('-c:a copy')
    expect(buildConvertArgs('/in', { ...streams, audioCodec: null }, null)).toContain('-an')
  })
  it('구간 변환은 입력 앞에서 건너뛰고 길이만큼만 읽는다', () => {
    const args = buildConvertArgs('/in', parseStreams(MTS_LOG), { startSec: 600, endSec: 1200.5 })
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'))
    expect(args[args.indexOf('-ss') + 1]).toBe('600.000')
    expect(args[args.indexOf('-t') + 1]).toBe('600.500')
  })
})
