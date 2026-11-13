import { describe, expect, it } from 'vitest'
import type { Region } from '../src/core/regions'
import { buildProject, parseProject, regionsFit } from '../src/project/project-file'

const rect: Region = { id: 'a', shape: { kind: 'rect', rect: { x: 10, y: 20, width: 300, height: 400 } }, exclude: false, startSec: null, endSec: null }
const polygon: Region = {
  id: 'b',
  shape: { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }] },
  exclude: true,
  startSec: 5,
  endSec: 12.5,
}
const input = {
  video: { name: '체육대회.mp4', sizeBytes: 1234, durationSec: 60, width: 1920, height: 1080 },
  regions: [rect, polygon],
  sensitivity: 'high' as const,
  quality: 'medium' as const,
  marginRatio: 0.3,
}

describe('프로젝트 파일', () => {
  it('내보낸 파일을 다시 읽으면 영역(사각형·다각형·제외·구간)과 설정이 그대로다', () => {
    const project = buildProject(input, new Date('2026-11-13T00:00:00Z'))
    const parsed = parseProject(JSON.stringify(project))
    expect(parsed).toEqual(project)
    expect(parsed.settings.regions).toEqual([rect, polygon])
  })

  it('자동 검출 결과나 영상 내용은 들어가지 않는다', () => {
    const keys = Object.keys(buildProject(input))
    expect(keys.sort()).toEqual(['format', 'savedAt', 'settings', 'version', 'video'])
  })

  it('수동으로 추가한 얼굴은 저장되고 다시 읽힌다', () => {
    const manualTracks = [{ id: -1, points: [{ timeUs: 1_000_000, box: { x: 5, y: 6, width: 70, height: 80 } }] }]
    const parsed = parseProject(JSON.stringify(buildProject({ ...input, manualTracks })))
    expect(parsed.manualTracks).toEqual(manualTracks)
  })

  it('버전 1 파일(사각형 목록)도 읽는다', () => {
    const old = { format: 'mosaic-project', version: 1, savedAt: '', video: input.video, settings: { regions: [{ x: 1, y: 2, width: 30, height: 40 }], sensitivity: 'low', quality: 'high', marginRatio: 0.25 } }
    const parsed = parseProject(JSON.stringify(old))
    expect(parsed.version).toBe(2)
    expect(parsed.settings.regions).toHaveLength(1)
    expect(parsed.settings.regions[0]?.shape).toEqual({ kind: 'rect', rect: { x: 1, y: 2, width: 30, height: 40 } })
    expect(parsed.settings.regions[0]?.exclude).toBe(false)
  })

  it('다른 형식의 파일은 거부한다', () => {
    expect(() => parseProject('영상')).toThrow('JSON')
    expect(() => parseProject('{"format":"other"}')).toThrow('프로젝트 파일이 아닙니다')
    expect(() => parseProject('{"format":"mosaic-project","version":3}')).toThrow('버전')
  })

  it('잘못된 영역 좌표는 거부한다', () => {
    const base = buildProject(input)
    const negative = { ...base, settings: { ...base.settings, regions: [{ ...rect, shape: { kind: 'rect', rect: { x: 0, y: 0, width: -5, height: 10 } } }] } }
    expect(() => parseProject(JSON.stringify(negative))).toThrow('영역 좌표')
    const twoPoints = { ...base, settings: { ...base.settings, regions: [{ ...polygon, shape: { kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }] } }
    expect(() => parseProject(JSON.stringify(twoPoints))).toThrow('영역 좌표')
  })

  it('모르는 설정 값은 기본값으로 바꾼다', () => {
    const odd = { ...buildProject(input), settings: { regions: [], sensitivity: 'ultra', quality: 'best', marginRatio: 5 } }
    const parsed = parseProject(JSON.stringify(odd))
    expect(parsed.settings.sensitivity).toBe('normal')
    expect(parsed.settings.quality).toBe('high')
    expect(parsed.settings.marginRatio).toBe(0.6)
  })

  it('영역은 영상 해상도가 같을 때만 쓴다', () => {
    const project = buildProject(input)
    expect(regionsFit(project, 1920, 1080)).toBe(true)
    expect(regionsFit(project, 1280, 720)).toBe(false)
    expect(regionsFit(buildProject({ ...input, regions: [] }), 1280, 720)).toBe(true)
  })

  it('분할 설정과 완료 구간을 저장하고 다시 읽는다', () => {
    const split = { choice: 'size' as const, count: 3, maxMb: 500, done: [{ startSec: 0, endSec: 190 }] }
    expect(parseProject(JSON.stringify(buildProject({ ...input, split }))).split).toEqual(split)
  })
})
