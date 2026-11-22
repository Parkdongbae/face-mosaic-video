import { BASE_FPS, type SensitivityPreset } from '../config/mosaic-defaults'

export interface DetectSchedule {
  /** 전체 화면 검출을 몇 프레임마다 할지 */
  fullEvery: number
  /** 타일(확대) 검출을 몇 프레임마다 할지. 전체 화면 검출을 하는 프레임과 겹치도록 fullEvery 의 배수다. */
  tileEvery: number
}

/**
 * 간격을 띄울 때 인정하는 가장 높은 프레임 속도. 파일에 적힌 프레임 속도가 잘못돼(시각 정보가 깨진 파일 등)
 * 터무니없이 크게 읽히면 검출을 너무 드물게 하게 되므로, 그보다 빠르다고 나와도 이 속도로 본다(더 자주 검출하는 쪽이 안전).
 */
const MAX_SCHEDULE_FPS = 120

/**
 * 프레임 속도에 맞춘 검출 간격. 기준값은 30fps 기준 프레임 수이므로, 60fps 영상은 같은 시간 간격이 되도록 두 배로 띄운다
 * (검출하지 않는 프레임은 추적 보간으로 채운다). 이렇게 해야 프레임 속도가 높다고 처리 시간이 두 배가 되지 않는다.
 */
export function detectSchedule(fps: number, preset: Pick<SensitivityPreset, 'fullIntervalFrames' | 'tileIntervalFrames'>): DetectSchedule {
  const speed = fps > 0 && Number.isFinite(fps) ? Math.min(fps, MAX_SCHEDULE_FPS) / BASE_FPS : 1
  const fullEvery = Math.max(1, Math.round(preset.fullIntervalFrames * speed))
  const tileEvery = Math.max(1, Math.round((preset.tileIntervalFrames * speed) / fullEvery)) * fullEvery
  return { fullEvery, tileEvery }
}
