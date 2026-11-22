import { SENSITIVITY_PRESETS } from '../config/mosaic-defaults'
import { SPEC_THRESHOLDS } from '../config/spec-thresholds'
import { detectSchedule } from '../core/detect-schedule'
import { tileGrid, tileLayout } from '../core/geometry'
import { DetectorPool, recommendedPoolSize } from '../pipeline/detector-pool'
import { MOSAIC_DEFAULTS } from '../config/mosaic-defaults'
import { classifyDevice, type EncodeSupport, type SpecMeasurements } from './judge'

interface NavigatorHints extends Navigator {
  deviceMemory?: number
  gpu?: { requestAdapter(): Promise<unknown> }
  userAgentData?: { mobile?: boolean; brands?: Array<{ brand: string; version: string }> }
}

function describeBrowser(): { name: string; isChromium: boolean } {
  const hints = navigator as NavigatorHints
  const brands = hints.userAgentData?.brands ?? []
  const named = brands.find((item) => /Whale|Edge|Chrome|Opera/i.test(item.brand) && !/Chromium/i.test(item.brand))
  const chromium = brands.find((item) => /Chromium/i.test(item.brand))
  if (named) return { name: `${named.brand.replace('Google ', '').replace('Microsoft ', '')} ${named.version}`, isChromium: true }
  if (chromium) return { name: `Chromium ${chromium.version}`, isChromium: true }
  const ua = navigator.userAgent
  const match =
    /(Whale)\/(\d+)/.exec(ua) ?? /(Edg)\/(\d+)/.exec(ua) ?? /(Firefox)\/(\d+)/.exec(ua) ?? /(Chrome)\/(\d+)/.exec(ua) ?? /Version\/(\d+).*(Safari)/.exec(ua)
  if (!match) return { name: '알 수 없는 브라우저', isChromium: false }
  const safari = match[2] === 'Safari'
  const name = safari ? 'Safari' : match[1] === 'Edg' ? 'Edge' : (match[1] ?? '')
  const version = safari ? match[1] : match[2]
  return { name: `${name} ${version ?? ''}`.trim(), isChromium: /Whale|Edg|Chrome/.test(match[1] ?? '') }
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as NavigatorHints).gpu
  if (!gpu) return false
  try {
    // navigator.gpu 가 있어도 어댑터가 null 일 수 있어 실제로 받아 본다(glm.md 5장).
    return (await gpu.requestAdapter()) !== null
  } catch {
    return false
  }
}

function hasWebGl2(): boolean {
  try {
    return document.createElement('canvas').getContext('webgl2') !== null
  } catch {
    return false
  }
}

/** 해상도에 맞는 H.264 High 프로파일 코덱 문자열(1080p 이하는 레벨 4.0, 그보다 크면 5.1). */
function avcCodecString(width: number, height: number): string {
  return width * height <= 1920 * 1088 ? 'avc1.640028' : 'avc1.640033'
}

function encoderConfig(width: number, height: number, hardwareAcceleration: HardwareAcceleration): VideoEncoderConfig {
  return {
    codec: avcCodecString(width, height),
    width: width - (width % 2),
    height: height - (height % 2),
    bitrate: Math.round(width * height * 4),
    framerate: 30,
    hardwareAcceleration,
  }
}

/** 주어진 해상도로 H.264 인코딩이 되는지, 하드웨어 가속이 되는지 확인한다. */
export async function checkH264Encode(width: number, height: number): Promise<EncodeSupport> {
  if (typeof VideoEncoder === 'undefined') return 'none'
  const supported = async (mode: HardwareAcceleration) => {
    try {
      return (await VideoEncoder.isConfigSupported(encoderConfig(width, height, mode))).supported === true
    } catch {
      return false
    }
  }
  if (await supported('prefer-hardware')) return 'hardware'
  if ((await supported('prefer-software')) || (await supported('no-preference'))) return 'software'
  return 'none'
}

function makeTestFrame(width: number, height: number): OffscreenCanvas {
  // 검출 시간은 화면 내용과 거의 무관하므로(고정 크기 신경망) 합성한 그림으로 잰다. 시험용 사진을 배포물에 넣지 않아도 된다.
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('시험 프레임을 만들지 못했습니다')
  const gradient = context.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, '#39515a')
  gradient.addColorStop(1, '#c9b79c')
  context.fillStyle = gradient
  context.fillRect(0, 0, width, height)
  for (let index = 0; index < 60; index += 1) {
    context.fillStyle = `hsl(${(index * 47) % 360} 35% ${35 + ((index * 13) % 40)}%)`
    context.beginPath()
    context.ellipse((index * 211) % width, (index * 137) % height, 30 + (index % 5) * 14, 40 + (index % 4) * 16, 0, 0, Math.PI * 2)
    context.fill()
  }
  return canvas
}

/** 실제 처리와 같은 방식(기본 감도의 전체 화면·타일 검출 간격 그대로)으로 720p 프레임을 검출해 초당 장수를 잰다. */
export async function benchmarkDetection(onProgress?: (done: number, total: number) => void): Promise<number> {
  const { frames, width, height } = SPEC_THRESHOLDS.benchmark
  const preset = SENSITIVITY_PRESETS[MOSAIC_DEFAULTS.sensitivity]
  const tileSets = preset.tileGrids
    .map((across) => {
      const grid = tileGrid(width, height, across, MOSAIC_DEFAULTS.tileOverlap)
      return tileLayout(width, height, grid.cols, grid.rows, MOSAIC_DEFAULTS.tileOverlap)
    })
    .filter((tiles) => tiles.length > 0)
  // 실제 처리처럼 검출을 건너뛰는 프레임은 그냥 지나간다(그 프레임은 추적 보간으로 채우므로 일이 없다).
  const schedule = detectSchedule(SPEC_THRESHOLDS.referenceVideo.fps, preset)
  const canvas = makeTestFrame(width, height)
  const pool = await DetectorPool.create(
    recommendedPoolSize(navigator.hardwareConcurrency || 1),
    'yunet',
    Math.min(MOSAIC_DEFAULTS.candidateScore, preset.scoreThreshold),
  )
  try {
    const run = async (count: number, report: boolean) => {
      const jobs: Array<Promise<unknown>> = []
      for (let frame = 0; frame < count; frame += 1) {
        if (frame % schedule.fullEvery === 0) {
          const bitmap = await createImageBitmap(canvas)
          try {
            await pool.acquire()
          } catch (error) {
            bitmap.close()
            throw error
          }
          const useTiles = tileSets.length > 0 && frame % schedule.tileEvery === 0
          jobs.push(pool.detect(bitmap, useTiles ? (tileSets[Math.floor(frame / schedule.tileEvery) % tileSets.length] ?? []) : []))
        }
        if (report) onProgress?.(frame + 1, count)
      }
      await Promise.all(jobs)
    }
    // 첫 추론은 준비 작업 때문에 느리므로 워커마다 한 번씩 돌린 뒤에 잰다.
    await run(pool.size * schedule.fullEvery, false)
    const started = performance.now()
    await run(frames, true)
    return (frames * 1000) / Math.max(1, performance.now() - started)
  } finally {
    pool.dispose()
  }
}

/** 720p 프레임 30장을 실제로 H.264 로 압축해 초당 장수를 잰다. 실패하면 null. */
export async function benchmarkEncode(): Promise<number | null> {
  if (typeof VideoEncoder === 'undefined') return null
  const { frames, width, height } = SPEC_THRESHOLDS.benchmark
  const canvas = makeTestFrame(width, height)
  const context = canvas.getContext('2d')
  let failed = false
  let outputs = 0
  const encoder = new VideoEncoder({
    output: () => {
      outputs += 1
    },
    error: () => {
      failed = true
    },
  })
  try {
    const config = encoderConfig(width, height, 'no-preference')
    if (!(await VideoEncoder.isConfigSupported(config)).supported) return null
    encoder.configure(config)
    const started = performance.now()
    for (let index = 0; index < frames; index += 1) {
      // 프레임마다 그림을 조금 바꿔 실제 영상처럼 압축할 내용이 있게 한다.
      context?.fillRect((index * 37) % width, (index * 53) % height, 80, 80)
      const frame = new VideoFrame(canvas, { timestamp: Math.round((index * 1e6) / 30) })
      try {
        if (failed) return null
        encoder.encode(frame, { keyFrame: index === 0 })
      } finally {
        frame.close()
      }
    }
    await encoder.flush()
    if (failed || outputs === 0) return null
    return (frames * 1000) / Math.max(1, performance.now() - started)
  } catch {
    return null
  } finally {
    if (encoder.state !== 'closed') encoder.close()
  }
}

async function storageFree(): Promise<number | null> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (!estimate || estimate.quota === undefined) return null
    return Math.max(0, estimate.quota - (estimate.usage ?? 0))
  } catch {
    return null
  }
}

export type SpecStage = '기기 정보 확인' | '저장 기능 확인' | '검출 속도 측정' | '완료'

/** 사양을 실제로 잰다. 약 10초. 영상·얼굴 정보는 쓰지 않으며 아무것도 전송하지 않는다. */
export async function collectSpec(onStage?: (stage: SpecStage, fraction: number) => void): Promise<SpecMeasurements> {
  const hints = navigator as NavigatorHints
  onStage?.('기기 정보 확인', 0.05)
  const browser = describeBrowser()
  const deviceKind = classifyDevice({
    uaDataMobile: hints.userAgentData?.mobile ?? null,
    userAgent: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
  })
  const [webgpu, storageFreeBytes] = await Promise.all([hasWebGpu(), storageFree()])
  const webCodecs = typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined'
  const reference = SPEC_THRESHOLDS.referenceVideo

  onStage?.('저장 기능 확인', 0.15)
  const h264Encode = await checkH264Encode(reference.width, reference.height)
  const encodeFps720p = h264Encode === 'none' ? null : await benchmarkEncode()

  onStage?.('검출 속도 측정', 0.3)
  let detectFps: number | null = null
  if (typeof WebAssembly !== 'undefined') {
    try {
      detectFps = await benchmarkDetection((done, total) => onStage?.('검출 속도 측정', 0.3 + 0.7 * (done / total)))
    } catch {
      detectFps = null
    }
  }
  onStage?.('완료', 1)

  return {
    browserName: browser.name,
    isChromium: browser.isChromium,
    webCodecs,
    webAssembly: typeof WebAssembly !== 'undefined',
    deviceKind,
    cores: navigator.hardwareConcurrency || null,
    deviceMemoryGb: hints.deviceMemory ?? null,
    webgpu,
    webgl2: hasWebGl2(),
    h264Encode,
    encodeCheckedAt: { width: reference.width, height: reference.height },
    storageFreeBytes,
    detectFps,
    encodeFps720p,
  }
}
