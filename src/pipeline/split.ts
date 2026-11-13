import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  type EncodedPacket,
  type StreamTargetChunk,
} from 'mediabunny'
import type { KeyFrameIndex, SplitPiece } from '../core/split-plan'
import type { JobHooks } from './analyze'
import { JobCanceledError } from './types'

/**
 * 키프레임 위치와 누적 용량을 읽는다. 패킷의 머리 정보만 읽으므로(내용은 읽지 않음) 큰 파일도 빠르고 메모리를 거의 쓰지 않는다.
 * 소리 용량은 평균 비트레이트로 어림한다.
 */
export async function buildKeyFrameIndex(file: Blob, hooks: JobHooks = {}): Promise<KeyFrameIndex> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('영상 트랙이 없는 파일입니다.')
    const audio = await input.getPrimaryAudioTrack()
    const audioBytesPerSec = audio ? (await audio.computePacketStats()).averageBitrate / 8 : 0
    const firstSec = await video.getFirstTimestamp()
    const endSec = await video.computeDuration()

    const keyFrames: KeyFrameIndex['keyFrames'] = []
    let videoBytes = 0
    const sink = new EncodedPacketSink(video)
    for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
      if (hooks.signal?.aborted) throw new JobCanceledError()
      if (packet.type === 'key') {
        keyFrames.push({
          timeSec: packet.timestamp,
          bytesBefore: Math.round(videoBytes + audioBytesPerSec * Math.max(0, packet.timestamp - firstSec)),
        })
      }
      videoBytes += packet.byteLength
    }
    keyFrames.sort((a, b) => a.timeSec - b.timeSec)
    return { keyFrames, endSec, totalBytes: Math.round(videoBytes + audioBytesPerSec * Math.max(0, endSec - firstSec)) }
  } finally {
    input.dispose()
  }
}

export interface SplitPieceResult {
  index: number
  videoPackets: number
  audioPackets: number
  bytes: number
  /** 디스크에 바로 쓰지 않은 경우에만 파일 내용 */
  buffer: ArrayBuffer | null
}

/**
 * 재압축 없이 영상을 조각으로 나눈다(스트림 복사). 해독·압축을 하지 않는다.
 * - 각 조각은 키프레임에서 시작하고, 타임스탬프는 0부터 다시 시작한다.
 * - 소리는 같은 구간의 패킷을 함께 넣는다.
 * - 조각은 하나씩 차례로 쓰고, 다 쓴 뒤에야 다음 조각으로 간다. 원본은 읽기만 한다.
 */
export async function splitVideo(
  file: Blob,
  pieces: SplitPiece[],
  handles: Array<FileSystemFileHandle | null>,
  hooks: JobHooks = {},
): Promise<SplitPieceResult[]> {
  const started = performance.now()
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  const results: SplitPieceResult[] = []
  const totalBytes = Math.max(1, pieces.reduce((sum, piece) => sum + piece.estimatedBytes, 0))
  let doneBytes = 0
  let donePackets = 0
  let lastReport = 0

  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video) throw new Error('영상 트랙이 없는 파일입니다.')
    if (!video.codec) throw new Error('영상 코덱을 알 수 없어 나눌 수 없습니다.')
    const audio = await input.getPrimaryAudioTrack()
    const videoConfig = await video.getDecoderConfig()
    const audioConfig = audio ? await audio.getDecoderConfig() : null
    if (!videoConfig) throw new Error('영상 설정 정보를 읽지 못해 나눌 수 없습니다.')
    const videoSink = new EncodedPacketSink(video)
    const audioSink = audio && audio.codec && audioConfig ? new EncodedPacketSink(audio) : null

    for (let position = 0; position < pieces.length; position += 1) {
      const piece = pieces[position]!
      const isLast = position === pieces.length - 1
      // 조각 파일은 쓸 차례가 됐을 때 연다(한꺼번에 열어 두지 않는다).
      const writable = (await handles[position]?.createWritable()) ?? null
      let bytesWritten = 0
      const target = writable
        ? new StreamTarget(
            // Mediabunny 는 취소·오류 때도 스트림을 닫으므로, 실제 저장 확정(close)은 성공했을 때 직접 한다.
            new WritableStream<StreamTargetChunk>({
              async write(chunk) {
                await writable.write({ type: 'write', data: chunk.data, position: chunk.position })
                bytesWritten = Math.max(bytesWritten, chunk.position + chunk.data.byteLength)
              },
            }),
            { chunked: true },
          )
        : new BufferTarget()
      const output = new Output({ format: new Mp4OutputFormat(writable ? { fastStart: false } : {}), target })
      const videoSource = new EncodedVideoPacketSource(video.codec)
      output.addVideoTrack(videoSource, { rotation: video.rotation })
      const audioSource = audioSink && audio?.codec ? new EncodedAudioPacketSource(audio.codec) : null
      if (audioSource) output.addAudioTrack(audioSource)

      try {
        await output.start()
        const startKey = await videoSink.getKeyPacket(piece.startSec)
        if (!startKey || Math.abs(startKey.timestamp - piece.startSec) > 1e-3) {
          throw new Error(`조각 ${piece.index}의 시작 위치(${piece.startSec.toFixed(3)}초)에서 키프레임을 찾지 못했습니다.`)
        }
        const endKey = isLast ? undefined : ((await videoSink.getKeyPacket(piece.endSec)) ?? undefined)
        const videoPackets = videoSink.packets(startKey, endKey)

        let audioPackets: AsyncGenerator<EncodedPacket, void, unknown> | null = null
        if (audioSink) {
          const first = position === 0 ? await audioSink.getFirstPacket() : await audioSink.getPacket(piece.startSec)
          if (first) audioPackets = audioSink.packets(first)
        }

        // 영상·소리 패킷을 시간 순서로 번갈아 넣는다(한쪽만 먼저 몰아 넣으면 메모리에 쌓인다).
        let nextVideo = await videoPackets.next()
        let nextAudio = audioPackets ? await audioPackets.next() : null
        // 앞 조각에 속하는 소리 패킷(시작 시각보다 앞에서 시작)은 건너뛴다.
        while (position > 0 && nextAudio && !nextAudio.done && nextAudio.value.timestamp < piece.startSec - 1e-6) {
          nextAudio = await audioPackets!.next()
        }
        let videoCount = 0
        let audioCount = 0
        const inRange = (packet: EncodedPacket) => isLast || packet.timestamp < piece.endSec - 1e-6

        for (;;) {
          if (hooks.signal?.aborted) throw new JobCanceledError()
          const audioReady = nextAudio !== null && !nextAudio.done && inRange(nextAudio.value)
          const videoReady = !nextVideo.done
          if (!videoReady && !audioReady) break
          const takeAudio = audioReady && (!videoReady || nextAudio!.value!.timestamp <= nextVideo.value!.timestamp)
          if (takeAudio) {
            const packet = nextAudio!.value!
            await audioSource!.add(
              packet.clone({ timestamp: packet.timestamp - piece.startSec }),
              audioCount === 0 && audioConfig ? { decoderConfig: audioConfig } : undefined,
            )
            audioCount += 1
            doneBytes += packet.byteLength
            nextAudio = await audioPackets!.next()
          } else {
            const packet = nextVideo.value!
            await videoSource.add(
              packet.clone({ timestamp: packet.timestamp - piece.startSec }),
              videoCount === 0 ? { decoderConfig: videoConfig } : undefined,
            )
            videoCount += 1
            doneBytes += packet.byteLength
            nextVideo = await videoPackets.next()
          }
          donePackets += 1
          const now = performance.now()
          if (now - lastReport > 250) {
            lastReport = now
            hooks.onProgress?.({
              phase: 'split',
              fraction: Math.min(1, doneBytes / totalBytes),
              frames: donePackets,
              fps: (donePackets * 1000) / Math.max(1, now - started),
            })
          }
        }
        // 반복기를 끝까지 돌지 않았을 수 있으므로 정리한다.
        await videoPackets.return()
        await audioPackets?.return()

        await output.finalize()
        const buffer = target instanceof BufferTarget ? target.buffer : null
        if (writable) await writable.close()
        results.push({
          index: piece.index,
          videoPackets: videoCount,
          audioPackets: audioCount,
          bytes: writable ? bytesWritten : (buffer?.byteLength ?? 0),
          buffer,
        })
      } catch (error) {
        if (output.state === 'started') await output.cancel().catch(() => undefined)
        await writable?.abort().catch(() => undefined)
        throw error
      }
    }
    hooks.onProgress?.({ phase: 'split', fraction: 1, frames: donePackets, fps: (donePackets * 1000) / Math.max(1, performance.now() - started) })
    return results
  } finally {
    input.dispose()
  }
}
