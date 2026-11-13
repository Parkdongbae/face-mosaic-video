import { describe, expect, it } from 'vitest'
import { samplePatch, trackThrough, type GrayFrame } from '../src/core/template-track'

const WIDTH = 320
const HEIGHT = 180

/** 무늬 있는 배경 위에, 고유한 무늬를 가진 30x36 "얼굴"을 (x, y)에 그린 흑백 프레임 */
function frameWithFace(x: number, y: number, withFace = true): GrayFrame {
  const data = new Uint8Array(WIDTH * HEIGHT)
  for (let py = 0; py < HEIGHT; py += 1) {
    for (let px = 0; px < WIDTH; px += 1) data[py * WIDTH + px] = 90 + ((px * 7 + py * 13) % 23)
  }
  if (withFace) {
    for (let fy = 0; fy < 36; fy += 1) {
      for (let fx = 0; fx < 30; fx += 1) {
        const px = Math.round(x) + fx
        const py = Math.round(y) + fy
        if (px < 0 || py < 0 || px >= WIDTH || py >= HEIGHT) continue
        const eye = (fy > 10 && fy < 16 && ((fx > 5 && fx < 11) || (fx > 18 && fx < 24))) || (fy > 24 && fy < 28 && fx > 9 && fx < 21)
        data[py * WIDTH + px] = eye ? 25 : 200 - Math.abs(fx - 15) * 3 - Math.abs(fy - 18)
      }
    }
  }
  return { data, width: WIDTH, height: HEIGHT }
}

describe('수동 추가 얼굴 따라가기', () => {
  it('앞으로: 프레임마다 조금씩 움직이는 얼굴을 따라간다', () => {
    const frames = Array.from({ length: 30 }, (_, i) => frameWithFace(60 + i * 3, 50 + i))
    const results = trackThrough(frames, 0, { x: 60, y: 50, width: 30, height: 36 }, 1)
    expect(results).toHaveLength(29)
    const last = results[results.length - 1]!
    expect(last.index).toBe(29)
    expect(Math.abs(last.box.x - (60 + 29 * 3))).toBeLessThanOrEqual(2)
    expect(Math.abs(last.box.y - (50 + 29))).toBeLessThanOrEqual(2)
  })

  it('뒤로: 표시한 프레임보다 앞선 프레임도 채운다', () => {
    const frames = Array.from({ length: 20 }, (_, i) => frameWithFace(200 - i * 4, 80))
    const results = trackThrough(frames, 19, { x: 200 - 19 * 4, y: 80, width: 30, height: 36 }, -1)
    expect(results).toHaveLength(19)
    const first = results[results.length - 1]!
    expect(first.index).toBe(0)
    expect(Math.abs(first.box.x - 200)).toBeLessThanOrEqual(2)
  })

  it('얼굴이 사라지면 거기서 멈춘다(엉뚱한 곳을 계속 가리지 않는다)', () => {
    const frames = Array.from({ length: 20 }, (_, i) => frameWithFace(100 + i * 2, 60, i < 10))
    const results = trackThrough(frames, 0, { x: 100, y: 60, width: 30, height: 36 }, 1)
    expect(results.length).toBeGreaterThanOrEqual(8)
    expect(results.length).toBeLessThanOrEqual(10)
  })

  it('무늬가 없는 곳(단색)은 따라갈 수 없다', () => {
    const flat: GrayFrame = { data: new Uint8Array(WIDTH * HEIGHT).fill(128), width: WIDTH, height: HEIGHT }
    expect(samplePatch(flat, { x: 10, y: 10, width: 30, height: 30 })).toBeNull()
    expect(trackThrough([flat, flat], 0, { x: 10, y: 10, width: 30, height: 30 }, 1)).toEqual([])
  })
})
