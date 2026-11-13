import { SPEC_THRESHOLDS } from '../config/spec-thresholds'

export type DeviceKind = 'desktop' | 'tablet' | 'mobile'
export type EncodeSupport = 'hardware' | 'software' | 'none'

/** 브라우저에서 실제로 잰 값. 알 수 없는 값은 null 로 둔다(없다고 부적합으로 보지 않는다). */
export interface SpecMeasurements {
  browserName: string
  isChromium: boolean
  webCodecs: boolean
  webAssembly: boolean
  deviceKind: DeviceKind
  cores: number | null
  deviceMemoryGb: number | null
  webgpu: boolean
  webgl2: boolean
  /** 점검한 해상도에서의 H.264 인코딩 지원 */
  h264Encode: EncodeSupport
  encodeCheckedAt: { width: number; height: number }
  /** 브라우저 저장소 여유 공간(바이트) */
  storageFreeBytes: number | null
  /** 실제 검출 속도(초당 프레임). 벤치마크가 실패하면 null */
  detectFps: number | null
  /** 720p 기준 H.264 인코딩 속도(초당 프레임). 재지 못하면 null */
  encodeFps720p: number | null
}

export interface SpecVideo {
  durationSec: number
  fps: number
  width: number
  height: number
  sizeBytes: number
}

export type ItemStatus = 'good' | 'warn' | 'fail' | 'unknown'
export type Verdict = 'fit' | 'caution' | 'unfit'

export interface SpecItem {
  id: 'browser' | 'device' | 'cpu' | 'memory' | 'gpu' | 'codec' | 'storage' | 'speed' | 'time'
  label: string
  /** 이 컴퓨터의 값 */
  value: string
  min: string
  recommended: string
  status: ItemStatus
}

export interface SpecEstimate {
  /** 예상 처리 시간(초) */
  processSec: number
  /** 영상 길이 대비 배수 */
  ratio: number
  /** 실제 불러온 영상 기준이면 true, 가정한 영상(1080p 10분) 기준이면 false */
  forLoadedVideo: boolean
  videoDurationSec: number
}

export interface SpecJudgement {
  verdict: Verdict
  items: SpecItem[]
  estimate: SpecEstimate | null
}

export interface DeviceHints {
  /** navigator.userAgentData.mobile (없으면 null) */
  uaDataMobile: boolean | null
  userAgent: string
  maxTouchPoints: number
  screenWidth: number
  screenHeight: number
}

/** 모바일·태블릿 판정. 한 가지 신호만 보지 않는다(glm.md 5장). */
export function classifyDevice(hints: DeviceHints): DeviceKind {
  const ua = hints.userAgent
  const touch = hints.maxTouchPoints > 0
  const shortSide = Math.min(hints.screenWidth, hints.screenHeight)
  const phoneUa = /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(ua)
  // iPadOS 는 맥으로 위장하므로 "맥 + 터치 여러 점"이면 태블릿으로 본다.
  const tabletUa = /iPad|Tablet|Android(?!.*Mobile)/i.test(ua) || (/Macintosh/i.test(ua) && hints.maxTouchPoints > 1)

  if (hints.uaDataMobile === true || phoneUa) return touch && shortSide >= 600 && !phoneUa ? 'tablet' : 'mobile'
  if (tabletUa && touch) return 'tablet'
  if (touch && shortSide < 600) return 'mobile'
  return 'desktop'
}

const DEVICE_LABEL: Record<DeviceKind, string> = { desktop: '데스크톱·노트북', tablet: '태블릿', mobile: '휴대폰' }

/** 시간을 읽기 쉬운 말로 바꾼다(90초 미만은 초, 그 이상은 분·시간). */
export function formatSpan(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}초`
  const minutes = Math.round(seconds / 60)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`
}

function formatGb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`
}

/** 예상 처리 시간 = 분석(검출 속도) + 저장(인코딩 속도, 해상도에 반비례한다고 가정). */
export function estimateProcessing(measurements: SpecMeasurements, video: SpecVideo | null): SpecEstimate | null {
  if (!measurements.detectFps || measurements.detectFps <= 0) return null
  const target = video ?? { ...SPEC_THRESHOLDS.referenceVideo, sizeBytes: 0 }
  const frames = target.durationSec * target.fps
  if (!(frames > 0) || !(target.durationSec > 0)) return null
  const analyzeSec = frames / measurements.detectFps
  let renderSec = analyzeSec
  if (measurements.encodeFps720p && measurements.encodeFps720p > 0) {
    const pixelRatio = (target.width * target.height) / (1280 * 720)
    renderSec = frames / (measurements.encodeFps720p / Math.max(0.25, pixelRatio))
  }
  const processSec = analyzeSec + renderSec
  return { processSec, ratio: processSec / target.durationSec, forLoadedVideo: video !== null, videoDurationSec: target.durationSec }
}

/**
 * 잰 값으로 적합/주의/부적합을 판정한다.
 * - 하나라도 최소 미달, 예상 처리 시간이 영상 길이의 10배 초과, 모바일·태블릿 → 부적합
 * - 최소는 넘지만 권장 미달 → 주의
 * - 확인할 수 없는 항목(unknown)은 판정에 넣지 않고 벤치마크 결과에 맡긴다.
 */
export function judgeSpec(measurements: SpecMeasurements, video: SpecVideo | null = null): SpecJudgement {
  const t = SPEC_THRESHOLDS
  const items: SpecItem[] = []
  const rank = (value: number, limits: { min: number; recommended: number }): ItemStatus =>
    value < limits.min ? 'fail' : value < limits.recommended ? 'warn' : 'good'

  items.push({
    id: 'browser',
    label: '브라우저',
    value: `${measurements.browserName}${measurements.webCodecs ? '' : ' (WebCodecs 없음)'}${measurements.webAssembly ? '' : ' (WebAssembly 없음)'}`,
    min: 'WebCodecs 지원 브라우저',
    recommended: '크롬·엣지·웨일 최신 버전',
    status: !measurements.webCodecs || !measurements.webAssembly ? 'fail' : measurements.isChromium ? 'good' : 'warn',
  })
  items.push({
    id: 'device',
    label: '기기 종류',
    value: DEVICE_LABEL[measurements.deviceKind],
    min: '데스크톱·노트북',
    recommended: '데스크톱',
    status: measurements.deviceKind === 'desktop' ? 'good' : 'fail',
  })
  items.push({
    id: 'cpu',
    label: 'CPU',
    value: measurements.cores === null ? '확인 불가' : `논리 코어 ${measurements.cores}개`,
    min: `${t.cores.min}개`,
    recommended: `${t.cores.recommended}개 이상`,
    status: measurements.cores === null ? 'unknown' : rank(measurements.cores, t.cores),
  })
  items.push({
    id: 'memory',
    label: '메모리',
    value:
      measurements.deviceMemoryGb === null
        ? '확인 불가 (이 브라우저는 알려 주지 않음)'
        : `${measurements.deviceMemoryGb >= 8 ? '8GB 이상' : `약 ${measurements.deviceMemoryGb}GB`}`,
    min: `${t.memoryGb.min}GB`,
    recommended: `${t.memoryGb.recommended}GB 이상`,
    status: measurements.deviceMemoryGb === null ? 'unknown' : rank(measurements.deviceMemoryGb, t.memoryGb),
  })
  items.push({
    id: 'gpu',
    label: '그래픽',
    value: measurements.webgpu ? 'WebGPU 사용 가능' : measurements.webgl2 ? 'WebGL2 사용 가능' : '그래픽 가속 없음',
    min: 'WebGL2',
    recommended: 'WebGPU',
    status: measurements.webgpu ? 'good' : measurements.webgl2 ? 'warn' : 'fail',
  })
  const size = `${measurements.encodeCheckedAt.width}×${measurements.encodeCheckedAt.height}`
  items.push({
    id: 'codec',
    label: 'H.264 저장',
    value:
      measurements.h264Encode === 'hardware'
        ? `${size} 하드웨어 가속 가능`
        : measurements.h264Encode === 'software'
          ? `${size} 가능 (가속 없음)`
          : `${size} 인코딩 불가`,
    min: '영상 해상도 인코딩 가능',
    recommended: '하드웨어 가속 가능',
    status: measurements.h264Encode === 'hardware' ? 'good' : measurements.h264Encode === 'software' ? 'warn' : 'fail',
  })

  let storageStatus: ItemStatus = 'unknown'
  let storageValue = measurements.storageFreeBytes === null ? '확인 불가' : `여유 ${formatGb(measurements.storageFreeBytes)}`
  if (video && measurements.storageFreeBytes !== null && video.sizeBytes > 0) {
    const multiple = measurements.storageFreeBytes / video.sizeBytes
    storageStatus = rank(multiple, t.storageMultiple)
    storageValue = `${storageValue} (영상의 ${multiple >= 100 ? '100배 이상' : `${multiple.toFixed(1)}배`})`
  } else if (!video && measurements.storageFreeBytes !== null) {
    storageValue = `${storageValue} · 영상을 불러오면 판정`
  }
  items.push({
    id: 'storage',
    label: '저장 공간',
    value: storageValue,
    min: `영상 용량의 ${t.storageMultiple.min}배`,
    recommended: `${t.storageMultiple.recommended}배 이상`,
    status: storageStatus,
  })
  items.push({
    id: 'speed',
    label: '검출 속도',
    value: measurements.detectFps === null ? '측정 실패' : `초당 ${measurements.detectFps.toFixed(1)}장`,
    min: `초당 ${t.detectFps.min}장`,
    recommended: `초당 ${t.detectFps.recommended}장 이상`,
    status: measurements.detectFps === null ? 'fail' : rank(measurements.detectFps, t.detectFps),
  })

  const estimate = estimateProcessing(measurements, video)
  if (estimate) {
    items.push({
      id: 'time',
      label: '예상 처리 시간',
      value: `${formatSpan(estimate.videoDurationSec)} 영상${estimate.forLoadedVideo ? '' : '(1080p 가정)'} 약 ${formatSpan(estimate.processSec)} (${estimate.ratio.toFixed(1)}배)`,
      min: `영상 길이의 ${t.maxProcessRatio}배 이내`,
      recommended: '영상 길이의 2배 이내',
      status: estimate.ratio > t.maxProcessRatio ? 'fail' : estimate.ratio > 2 ? 'warn' : 'good',
    })
  }

  const verdict: Verdict = items.some((item) => item.status === 'fail')
    ? 'unfit'
    : items.some((item) => item.status === 'warn')
      ? 'caution'
      : 'fit'
  return { verdict, items, estimate }
}
