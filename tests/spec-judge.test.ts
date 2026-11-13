import { describe, expect, it } from 'vitest'
import { classifyDevice, estimateProcessing, judgeSpec, type SpecMeasurements } from '../src/spec/judge'

const good: SpecMeasurements = {
  browserName: 'Chrome 157',
  isChromium: true,
  webCodecs: true,
  webAssembly: true,
  deviceKind: 'desktop',
  cores: 12,
  deviceMemoryGb: 8,
  webgpu: true,
  webgl2: true,
  h264Encode: 'hardware',
  encodeCheckedAt: { width: 1920, height: 1080 },
  storageFreeBytes: 100 * 1024 ** 3,
  detectFps: 40,
  encodeFps720p: 200,
}
const video = { durationSec: 300, fps: 30, width: 1920, height: 1080, sizeBytes: 80 * 1024 ** 2 }
const statusOf = (measurements: SpecMeasurements, id: string, withVideo = false) =>
  judgeSpec(measurements, withVideo ? video : null).items.find((item) => item.id === id)?.status

describe('사양 판정', () => {
  it('모든 항목이 권장 이상이면 적합', () => {
    expect(judgeSpec(good, video).verdict).toBe('fit')
  })

  it('최소는 넘지만 권장에 못 미치면 주의', () => {
    const result = judgeSpec({ ...good, cores: 4 }, video)
    expect(result.verdict).toBe('caution')
    expect(result.items.find((item) => item.id === 'cpu')?.status).toBe('warn')
  })

  it('하나라도 최소 미달이면 부적합', () => {
    expect(judgeSpec({ ...good, cores: 2 }).verdict).toBe('unfit')
    expect(judgeSpec({ ...good, deviceMemoryGb: 2 }).verdict).toBe('unfit')
    expect(judgeSpec({ ...good, detectFps: 3 }).verdict).toBe('unfit')
    expect(judgeSpec({ ...good, h264Encode: 'none' }).verdict).toBe('unfit')
    expect(judgeSpec({ ...good, webgpu: false, webgl2: false }).verdict).toBe('unfit')
    expect(judgeSpec({ ...good, webCodecs: false }).verdict).toBe('unfit')
  })

  it('모바일·태블릿은 다른 항목이 좋아도 부적합', () => {
    expect(judgeSpec({ ...good, deviceKind: 'tablet' }).verdict).toBe('unfit')
    expect(judgeSpec({ ...good, deviceKind: 'mobile' }).verdict).toBe('unfit')
  })

  it('메모리 값을 알 수 없으면 부적합이 아니라 확인 불가로 둔다', () => {
    const result = judgeSpec({ ...good, deviceMemoryGb: null }, video)
    expect(result.items.find((item) => item.id === 'memory')?.status).toBe('unknown')
    expect(result.verdict).toBe('fit')
  })

  it('코어 수를 알 수 없어도 벤치마크가 좋으면 적합', () => {
    expect(judgeSpec({ ...good, cores: null }, video).verdict).toBe('fit')
  })

  it('크롬 계열이 아니면 주의', () => {
    expect(statusOf({ ...good, isChromium: false, browserName: 'Firefox 140' }, 'browser')).toBe('warn')
  })

  it('WebGPU 가 없고 WebGL2 만 있으면 주의', () => {
    expect(statusOf({ ...good, webgpu: false }, 'gpu')).toBe('warn')
  })

  it('저장 공간은 영상을 불러온 뒤에만 판정한다', () => {
    expect(statusOf(good, 'storage')).toBe('unknown')
    expect(statusOf(good, 'storage', true)).toBe('good')
    expect(statusOf({ ...good, storageFreeBytes: 100 * 1024 ** 2 }, 'storage', true)).toBe('fail')
    expect(statusOf({ ...good, storageFreeBytes: 200 * 1024 ** 2 }, 'storage', true)).toBe('warn')
  })

  it('검출 속도 벤치마크가 실패하면 부적합', () => {
    expect(judgeSpec({ ...good, detectFps: null }).verdict).toBe('unfit')
  })

  it('예상 처리 시간이 영상 길이의 10배를 넘으면 부적합', () => {
    // 검출 초당 5장(최소 통과)이어도 인코딩이 매우 느리면 10배를 넘는다.
    const result = judgeSpec({ ...good, detectFps: 5, encodeFps720p: 12 }, video)
    expect(result.estimate?.ratio).toBeGreaterThan(10)
    expect(result.items.find((item) => item.id === 'time')?.status).toBe('fail')
    expect(result.verdict).toBe('unfit')
  })
})

describe('예상 처리 시간', () => {
  it('분석 시간 + 저장 시간(해상도에 비례)', () => {
    const estimate = estimateProcessing({ ...good, detectFps: 30, encodeFps720p: 90 }, video)
    // 프레임 9000장: 분석 300초 + 저장 9000 / (90 / 2.25) = 225초
    expect(estimate?.processSec).toBeCloseTo(525, 5)
    expect(estimate?.ratio).toBeCloseTo(1.75, 5)
    expect(estimate?.forLoadedVideo).toBe(true)
  })

  it('영상이 없으면 가정한 영상(1080p 10분)으로 계산한다', () => {
    const estimate = estimateProcessing(good, null)
    expect(estimate?.forLoadedVideo).toBe(false)
    expect(estimate?.videoDurationSec).toBe(600)
  })

  it('검출 속도를 모르면 계산하지 않는다', () => {
    expect(estimateProcessing({ ...good, detectFps: null }, video)).toBeNull()
  })
})

describe('기기 종류 판정', () => {
  const desktop = { uaDataMobile: false, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/157', maxTouchPoints: 0, screenWidth: 1920, screenHeight: 1080 }

  it('일반 PC', () => {
    expect(classifyDevice(desktop)).toBe('desktop')
  })
  it('터치 화면이 달린 윈도우 노트북은 데스크톱으로 본다', () => {
    expect(classifyDevice({ ...desktop, maxTouchPoints: 10, screenWidth: 1366, screenHeight: 768 })).toBe('desktop')
  })
  it('휴대폰', () => {
    expect(classifyDevice({ uaDataMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile Chrome/157', maxTouchPoints: 5, screenWidth: 412, screenHeight: 915 })).toBe('mobile')
    expect(classifyDevice({ uaDataMobile: null, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari', maxTouchPoints: 5, screenWidth: 390, screenHeight: 844 })).toBe('mobile')
  })
  it('안드로이드 태블릿', () => {
    expect(classifyDevice({ uaDataMobile: false, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-X710) Chrome/157', maxTouchPoints: 10, screenWidth: 1600, screenHeight: 2560 })).toBe('tablet')
  })
  it('맥으로 위장한 아이패드', () => {
    expect(classifyDevice({ uaDataMobile: null, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', maxTouchPoints: 5, screenWidth: 1024, screenHeight: 1366 })).toBe('tablet')
  })
  it('터치 없는 맥은 데스크톱', () => {
    expect(classifyDevice({ uaDataMobile: null, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', maxTouchPoints: 0, screenWidth: 1728, screenHeight: 1117 })).toBe('desktop')
  })
})
