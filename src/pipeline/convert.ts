import { FFFSType, FFmpeg } from '@ffmpeg/ffmpeg'
import { JobCanceledError } from './types'

// ffmpeg.wasm 실행 파일은 public/wasm/ffmpeg 에서만 읽는다(외부 CDN 금지).
const CORE_PATH = '/wasm/ffmpeg/ffmpeg-core.js'
const WASM_PATH = '/wasm/ffmpeg/ffmpeg-core.wasm'
const INPUT_DIR = '/input'
const OUTPUT_NAME = 'converted.mp4'

/** 형식 변환 기능(ffmpeg.wasm 실행 파일)이 이 설치본에 들어 있지 않을 때 */
export const CONVERTER_MISSING_MESSAGE =
  '이 설치본에는 형식 변환 기능(ffmpeg.wasm)이 들어 있지 않아 이 파일을 열 수 없습니다. MP4·MOV·WebM 파일로 바꿔서 불러오거나, 설치 안내(README 하단)에 따라 변환 기능을 직접 설치하세요.'

/**
 * ffmpeg.wasm 실행 파일은 GPL 이라 저장소·기본 배포본에 넣지 않는다(쓰는 사람이 직접 설치).
 * 없으면 알아듣기 어려운 오류 대신 안내를 보여 준다. 같은 도메인의 앱 파일만 확인한다.
 */
async function ensureCoreInstalled(base: string): Promise<void> {
  let installed = false
  try {
    const response = await fetch(`${base}${CORE_PATH}`, { method: 'HEAD' })
    installed = response.ok && (response.headers.get('content-type') ?? '').includes('javascript')
  } catch {
    installed = false
  }
  if (!installed) throw new Error(CONVERTER_MISSING_MESSAGE)
}

export interface SourceStreams {
  durationSec: number | null
  videoCodec: string | null
  audioCodec: string | null
  width: number | null
  height: number | null
}

export interface ConvertRange {
  startSec: number
  endSec: number
}

export interface ConvertHooks {
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export interface ConvertResult {
  /** 변환된 H.264 MP4 중간 파일 */
  file: File
  streams: SourceStreams
  /** 영상을 다시 압축했는지(false 면 영상은 그대로 복사하고 소리만 바꿈) */
  videoTranscoded: boolean
  audioAction: 'none' | 'copied' | 'transcoded'
}

/** `ffmpeg -i` 가 찍는 정보에서 길이·코덱을 읽는다. */
export function parseStreams(log: string): SourceStreams {
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log)
  const video = /Stream #\d+:\d+.*?: Video: ([A-Za-z0-9_]+).*?,\s(\d{2,5})x(\d{2,5})/.exec(log)
  const audio = /Stream #\d+:\d+.*?: Audio: ([A-Za-z0-9_]+)/.exec(log)
  return {
    durationSec: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    videoCodec: video?.[1] ?? null,
    audioCodec: audio?.[1] ?? null,
    width: video ? Number(video[2]) : null,
    height: video ? Number(video[3]) : null,
  }
}

/** 변환 명령의 인자를 만든다. 영상이 H.264 면 다시 압축하지 않고 복사해 빠르게 끝낸다. */
export function buildConvertArgs(inputPath: string, streams: SourceStreams, range: ConvertRange | null): string[] {
  const args = ['-hide_banner', '-nostdin', '-y']
  // -ss 를 -i 앞에 두면 그 위치로 건너뛰어 읽으므로 앞부분을 해독하지 않는다.
  if (range) args.push('-ss', range.startSec.toFixed(3))
  args.push('-i', inputPath)
  if (range) args.push('-t', Math.max(0.001, range.endSec - range.startSec).toFixed(3))
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn')
  if (streams.videoCodec === 'h264') {
    args.push('-c:v', 'copy')
  } else {
    // 중간 파일이므로 빠르게(ultrafast), 화질 손실은 작게(crf 18) 만든다. 최종 압축은 뒤 단계에서 한다.
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p', '-g', '60')
  }
  if (streams.audioCodec === null) args.push('-an')
  else if (streams.audioCodec === 'aac') args.push('-c:a', 'copy')
  else args.push('-c:a', 'aac', '-b:a', '160k')
  args.push(OUTPUT_NAME)
  return args
}

async function storeIntermediate(data: Uint8Array<ArrayBuffer>, name: string): Promise<File> {
  // 변환 결과를 메모리에 계속 들고 있지 않도록 브라우저 내부 저장소(이 컴퓨터 안)에 내려 둔다.
  try {
    const directory = await navigator.storage.getDirectory()
    const handle = await directory.getFileHandle(name, { create: true })
    const writable = await handle.createWritable()
    await writable.write(data)
    await writable.close()
    return await handle.getFile()
  } catch {
    return new File([data], name, { type: 'video/mp4' })
  }
}

/** 이전 작업이 남긴 중간 파일을 지운다. */
export async function clearIntermediates(): Promise<void> {
  try {
    const directory = await navigator.storage.getDirectory()
    const names: string[] = []
    for await (const name of (directory as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.startsWith('intermediate-')) names.push(name)
    }
    for (const name of names) await directory.removeEntry(name).catch(() => undefined)
  } catch {
    // 내부 저장소를 쓸 수 없는 환경이면 지울 것도 없다.
  }
}

let intermediateCounter = 0

/**
 * 브라우저가 바로 열지 못하는 형식을 ffmpeg.wasm 으로 H.264 MP4 중간 파일로 바꾼다(glm.md 3-5).
 * - ffmpeg.wasm 은 이 함수가 처음 불릴 때 읽는다.
 * - 입력은 WORKERFS 로 연결해 메모리에 복사하지 않는다. 원본 파일은 읽기만 한다.
 * - 끝나면 가상 파일을 지우고 워커를 종료한다.
 */
export async function convertToMp4(file: File, range: ConvertRange | null, hooks: ConvertHooks = {}): Promise<ConvertResult> {
  if (hooks.signal?.aborted) throw new JobCanceledError()
  const ffmpeg = new FFmpeg()
  const logs: string[] = []
  ffmpeg.on('log', ({ message }) => {
    logs.push(message)
    if (logs.length > 400) logs.splice(0, 200)
  })
  const onAbort = () => ffmpeg.terminate()
  hooks.signal?.addEventListener('abort', onAbort)

  try {
    const base = window.location.origin
    await ensureCoreInstalled(base)
    await ffmpeg.load({ coreURL: `${base}${CORE_PATH}`, wasmURL: `${base}${WASM_PATH}` })
    await ffmpeg.createDir(INPUT_DIR)
    // 파일 이름에 한글·공백이 있어도 문제없도록 고정된 이름으로 연결한다.
    const extension = /\.[A-Za-z0-9]+$/.exec(file.name)?.[0] ?? ''
    const inputName = `source${extension.toLowerCase()}`
    await ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name: inputName, data: file }] }, INPUT_DIR)
    const inputPath = `${INPUT_DIR}/${inputName}`

    // 출력 파일 없이 실행하면 입력 정보만 찍고 끝난다(종료 코드는 0이 아님).
    await ffmpeg.exec(['-hide_banner', '-i', inputPath])
    const streams = parseStreams(logs.join('\n'))
    if (!streams.videoCodec) {
      throw new Error('영상을 열 수 없습니다. 손상됐거나 지원하지 않는 형식입니다.')
    }

    const totalSec = range ? range.endSec - range.startSec : streams.durationSec
    ffmpeg.on('progress', ({ progress, time }) => {
      const byTime = totalSec && totalSec > 0 ? time / 1e6 / totalSec : progress
      const value = Number.isFinite(byTime) ? byTime : progress
      hooks.onProgress?.(Math.max(0, Math.min(1, value)))
    })
    logs.length = 0
    const code = await ffmpeg.exec(buildConvertArgs(inputPath, streams, range))
    if (code !== 0) {
      const reason = logs.filter((line) => /error|invalid|unsupported|failed/i.test(line)).slice(-2).join(' / ')
      throw new Error(`형식 변환에 실패했습니다${reason ? `: ${reason}` : '.'}`)
    }

    const data = await ffmpeg.readFile(OUTPUT_NAME)
    await ffmpeg.deleteFile(OUTPUT_NAME)
    if (typeof data === 'string' || data.byteLength === 0) throw new Error('형식 변환 결과가 비어 있습니다.')
    intermediateCounter += 1
    const stored = await storeIntermediate(new Uint8Array(data), `intermediate-${Date.now()}-${intermediateCounter}.mp4`)
    hooks.onProgress?.(1)
    return {
      file: stored,
      streams,
      videoTranscoded: streams.videoCodec !== 'h264',
      audioAction: streams.audioCodec === null ? 'none' : streams.audioCodec === 'aac' ? 'copied' : 'transcoded',
    }
  } catch (error) {
    if (hooks.signal?.aborted) throw new JobCanceledError()
    throw error
  } finally {
    hooks.signal?.removeEventListener('abort', onAbort)
    ffmpeg.terminate()
  }
}
