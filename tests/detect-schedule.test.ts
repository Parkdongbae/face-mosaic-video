import { describe, expect, it } from 'vitest'
import { MOSAIC_DEFAULTS, SENSITIVITY_PRESETS } from '../src/config/mosaic-defaults'
import { detectSchedule } from '../src/core/detect-schedule'
import { frameRateOf, tileGrid, tileLayout, unionRect } from '../src/core/geometry'

describe('타일 격자: 타일이 정사각형에 가깝게', () => {
  it('16:9 화면의 짧은 변을 2장으로 나누면 4x2, 3장이면 5x3', () => {
    expect(tileGrid(1920, 1080, 2, 0.2)).toEqual({ cols: 4, rows: 2 })
    expect(tileGrid(1920, 1080, 3, 0.2)).toEqual({ cols: 5, rows: 3 })
    expect(tileGrid(1280, 720, 2, 0.2)).toEqual({ cols: 4, rows: 2 })
    expect(tileGrid(3840, 2160, 2, 0.2)).toEqual({ cols: 4, rows: 2 })
  })

  it('세로 영상은 가로·세로가 뒤바뀐 격자가 된다', () => {
    expect(tileGrid(1080, 1920, 2, 0.2)).toEqual({ cols: 2, rows: 4 })
  })

  it('4:3·정사각형 화면은 그 비율에 맞는 격자가 된다', () => {
    expect(tileGrid(1440, 1080, 2, 0.2)).toEqual({ cols: 3, rows: 2 })
    expect(tileGrid(1080, 1080, 2, 0.2)).toEqual({ cols: 2, rows: 2 })
  })

  it('0장이면 타일이 없다', () => {
    expect(tileGrid(1920, 1080, 0, 0.2)).toEqual({ cols: 0, rows: 0 })
  })

  it('해상도가 낮으면 타일이 너무 작아지지 않게 장수를 줄인다(짧은 변 256px 이상)', () => {
    // 720p 는 짧은 변 3장까지 그대로(타일 277px)
    expect(tileGrid(1280, 720, 3, 0.2)).toEqual({ cols: 5, rows: 3 })
    // 480p: 3장이면 타일이 185px 이라 2장으로 줄인다
    expect(tileGrid(854, 480, 3, 0.2)).toEqual({ cols: 4, rows: 2 })
    // 360p: 2장도 200px 이라 1장으로 줄인다
    expect(tileGrid(640, 360, 3, 0.2)).toEqual({ cols: 2, rows: 1 })
    expect(tileGrid(640, 360, 2, 0.2)).toEqual({ cols: 2, rows: 1 })
    // 짧은 변이 256px 에 못 미쳐도 1장은 남긴다
    expect(tileGrid(1920, 200, 3, 0.2)).toEqual({ cols: 11, rows: 1 })
    for (const [width, height] of [[1920, 1080], [1280, 720], [854, 480], [640, 360], [480, 854]] as const) {
      for (const across of [2, 3]) {
        const grid = tileGrid(width, height, across, 0.2)
        const tile = tileLayout(width, height, grid.cols, grid.rows, 0.2)[0]!
        // 모델 입력(640px)에 들어갈 때의 확대 배율은 타일의 긴 쪽이 정한다: 2.5배를 넘지 않는다
        expect(640 / Math.max(tile.width, tile.height), `${width}x${height} 짧은 변 ${across}장`).toBeLessThanOrEqual(2.5)
      }
    }
  })

  it('흔한 화면 비율에서 타일의 가로·세로가 크게 차이 나지 않는다(모델 입력을 낭비 없이 쓴다)', () => {
    for (const [width, height] of [[1920, 1080], [1280, 720], [3840, 2160], [1080, 1920], [1440, 1080], [2560, 1080], [1080, 1080]] as const) {
      for (const across of [2, 3]) {
        const grid = tileGrid(width, height, across, 0.2)
        const tile = tileLayout(width, height, grid.cols, grid.rows, 0.2)[0]!
        const ratio = Math.max(tile.width, tile.height) / Math.min(tile.width, tile.height)
        expect(ratio, `${width}x${height} 짧은 변 ${across}장 → ${grid.cols}x${grid.rows}`).toBeLessThanOrEqual(1.3)
      }
    }
  })

  it('예전 2x2 격자보다 얼굴이 모델에 1.7배 넘게 크게 들어간다(1080p)', () => {
    const scaleOf = (cols: number, rows: number) => {
      const tile = tileLayout(1920, 1080, cols, rows, 0.2)[0]!
      return 640 / Math.max(tile.width, tile.height)
    }
    const grid = tileGrid(1920, 1080, 2, 0.2)
    expect(scaleOf(grid.cols, grid.rows) / scaleOf(2, 2)).toBeGreaterThan(1.7)
  })
})

describe('프레임 속도에 맞춘 검출 간격', () => {
  // 30fps 기준: 전체 화면은 매 프레임, 타일은 3프레임마다
  const everyFrame = { fullIntervalFrames: 1, tileIntervalFrames: 3 }
  // 30fps 기준: 전체 화면은 2프레임마다, 타일은 4프레임마다
  const sparse = { fullIntervalFrames: 2, tileIntervalFrames: 4 }

  it('30fps: 기준 간격 그대로', () => {
    expect(detectSchedule(30, everyFrame)).toEqual({ fullEvery: 1, tileEvery: 3 })
    expect(detectSchedule(29.97, everyFrame)).toEqual({ fullEvery: 1, tileEvery: 3 })
    expect(detectSchedule(30, sparse)).toEqual({ fullEvery: 2, tileEvery: 4 })
  })

  it('60fps: 같은 시간 간격이 되도록 두 배로 띄운다', () => {
    expect(detectSchedule(60, everyFrame)).toEqual({ fullEvery: 2, tileEvery: 6 })
    expect(detectSchedule(60, sparse)).toEqual({ fullEvery: 4, tileEvery: 8 })
  })

  it('24fps: 간격이 조금 촘촘해지지만 1프레임보다 줄지는 않는다', () => {
    expect(detectSchedule(24, everyFrame)).toEqual({ fullEvery: 1, tileEvery: 2 })
    expect(detectSchedule(24, sparse)).toEqual({ fullEvery: 2, tileEvery: 4 })
  })

  it('타일 검출 프레임은 항상 전체 화면 검출 프레임과 겹친다', () => {
    for (const fps of [15, 24, 25, 30, 50, 60, 90, 120]) {
      for (const preset of [...Object.values(SENSITIVITY_PRESETS), everyFrame, sparse, { fullIntervalFrames: 2, tileIntervalFrames: 3 }]) {
        const schedule = detectSchedule(fps, preset)
        expect(schedule.fullEvery).toBeGreaterThanOrEqual(1)
        expect(schedule.tileEvery).toBeGreaterThanOrEqual(schedule.fullEvery)
        expect(schedule.tileEvery % schedule.fullEvery).toBe(0)
      }
    }
  })

  it('프레임 속도를 모르면 30fps 로 본다', () => {
    expect(detectSchedule(0, sparse)).toEqual(detectSchedule(30, sparse))
    expect(detectSchedule(Number.NaN, sparse)).toEqual(detectSchedule(30, sparse))
    expect(detectSchedule(Number.POSITIVE_INFINITY, sparse)).toEqual(detectSchedule(30, sparse))
  })

  it('프레임 속도가 터무니없이 크게 읽혀도 120fps 보다 드물게 검출하지 않는다(시각 정보가 깨진 파일)', () => {
    expect(detectSchedule(1000, sparse)).toEqual(detectSchedule(120, sparse))
    expect(detectSchedule(240, sparse)).toEqual({ fullEvery: 8, tileEvery: 16 })
  })

  it('기본 감도 설정: 같은 타일 격자를 다시 보는 간격이 약한 검출로 얼굴을 이어 가는 한도(1초)를 넘지 않는다', () => {
    // 타일에서만 잡히는 얼굴은 그 격자 차례가 돌아와야 다시 잡힌다. 그 사이가 한도보다 길면 약한 검출로는 이어 가지 못한다.
    for (const preset of Object.values(SENSITIVITY_PRESETS)) {
      for (const fps of [24, 25, 30, 50, 60]) {
        const schedule = detectSchedule(fps, preset)
        const revisitSec = (schedule.tileEvery * Math.max(1, preset.tileGrids.length)) / fps
        expect(revisitSec, `${preset.label} ${fps}fps`).toBeLessThanOrEqual(MOSAIC_DEFAULTS.weakLinkMaxSec)
      }
    }
  })

  it('기본 감도 설정: 전체 화면 검출은 0.1초 넘게 비우지 않는다(큰 얼굴은 움직임이 크게 보인다)', () => {
    for (const preset of Object.values(SENSITIVITY_PRESETS)) {
      for (const fps of [24, 25, 30, 50, 60]) {
        expect(detectSchedule(fps, preset).fullEvery / fps, `${preset.label} ${fps}fps`).toBeLessThanOrEqual(0.1)
      }
    }
  })
})

describe('보조 계산', () => {
  it('두 사각형을 모두 덮는 사각형', () => {
    expect(unionRect({ x: 10, y: 20, width: 30, height: 40 }, { x: 30, y: 10, width: 50, height: 20 })).toEqual({ x: 10, y: 10, width: 70, height: 50 })
  })

  it('프레임 시각에서 초당 프레임 수를 어림한다', () => {
    const stamps = (fps: number, count: number) => Array.from({ length: count }, (_, frame) => Math.round((frame * 1e6) / fps))
    expect(frameRateOf(stamps(30, 300))).toBeCloseTo(30, 0)
    expect(frameRateOf(stamps(60, 300))).toBeCloseTo(60, 0)
    expect(frameRateOf(stamps(29.97, 5000))).toBeCloseTo(29.97, 1)
    expect(frameRateOf([])).toBe(30)
    expect(frameRateOf([0])).toBe(30)
  })

  it('가변 프레임 영상은 중앙값 간격으로 본다(가끔 길게 비는 프레임에 끌려가지 않는다)', () => {
    const stamps: number[] = []
    let time = 0
    for (let frame = 0; frame < 200; frame += 1) {
      stamps.push(time)
      time += frame % 20 === 0 ? 200_000 : 33_333
    }
    expect(frameRateOf(stamps)).toBeCloseTo(30, 0)
  })
})
