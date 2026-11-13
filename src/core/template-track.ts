import type { Rect } from './geometry'

/**
 * 사용자가 직접 표시한 얼굴을 앞뒤 프레임으로 따라가는 추적(F-11).
 * 얼굴이 누구인지는 다루지 않고, 표시한 자리의 그림 무늬가 다음 프레임에서 어디로 옮겨 갔는지만 찾는다.
 * 계산은 작게 줄인 흑백 프레임에서 한다.
 */

export interface GrayFrame {
  data: Uint8Array | Uint8ClampedArray
  width: number
  height: number
}

/** 비교용 조각의 한 변 길이(픽셀) */
const PATCH = 20
const SCALES = [1, 0.94, 1.06]

export interface TemplateTrackOptions {
  /** 이 값보다 닮은 정도가 낮으면 놓친 것으로 보고 멈춘다(0~1) */
  minScore: number
  /** 한 프레임에 움직일 수 있는 최대 거리(상자 크기 대비) */
  searchRatio: number
  /** 따라가면서 기준 무늬를 조금씩 새 모습으로 바꾸는 비율(0이면 고정) */
  adapt: number
}

export const TEMPLATE_TRACK_DEFAULTS: TemplateTrackOptions = { minScore: 0.55, searchRatio: 0.4, adapt: 0.12 }

/** 상자 안을 PATCH x PATCH 로 줄여 뽑고 평균 0·크기 1 로 맞춘다. 무늬가 없으면(단색) null. */
export function samplePatch(frame: GrayFrame, box: Rect): Float32Array | null {
  const patch = new Float32Array(PATCH * PATCH)
  let sum = 0
  for (let py = 0; py < PATCH; py += 1) {
    const y = Math.min(frame.height - 1, Math.max(0, Math.round(box.y + ((py + 0.5) * box.height) / PATCH - 0.5)))
    for (let px = 0; px < PATCH; px += 1) {
      const x = Math.min(frame.width - 1, Math.max(0, Math.round(box.x + ((px + 0.5) * box.width) / PATCH - 0.5)))
      const value = frame.data[y * frame.width + x] ?? 0
      patch[py * PATCH + px] = value
      sum += value
    }
  }
  const mean = sum / patch.length
  let energy = 0
  for (let i = 0; i < patch.length; i += 1) {
    const value = (patch[i] ?? 0) - mean
    patch[i] = value
    energy += value * value
  }
  if (energy < 1e-3) return null
  const norm = Math.sqrt(energy)
  for (let i = 0; i < patch.length; i += 1) patch[i] = (patch[i] ?? 0) / norm
  return patch
}

/** 두 조각이 닮은 정도(정규화 상관, -1~1) */
function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0)
  return dot
}

export interface Located {
  box: Rect
  score: number
}

/** 다음 프레임에서 기준 무늬와 가장 닮은 자리를 찾는다. 먼저 성기게 훑고 가장 좋은 자리 주변을 촘촘히 다시 본다. */
export function locate(frame: GrayFrame, template: Float32Array, previous: Rect, options: TemplateTrackOptions): Located | null {
  const reach = Math.max(3, Math.round(Math.max(previous.width, previous.height) * options.searchRatio))
  const coarse = Math.max(1, Math.round(reach / 6))
  let best: Located | null = null
  const consider = (dx: number, dy: number, scale: number) => {
    const width = previous.width * scale
    const height = previous.height * scale
    const box = {
      x: previous.x + previous.width / 2 + dx - width / 2,
      y: previous.y + previous.height / 2 + dy - height / 2,
      width,
      height,
    }
    // 대부분이 화면 밖이면 후보에서 뺀다.
    if (box.x + width * 0.5 < 0 || box.y + height * 0.5 < 0 || box.x + width * 0.5 > frame.width || box.y + height * 0.5 > frame.height) return
    const patch = samplePatch(frame, box)
    if (!patch) return
    const score = similarity(template, patch)
    if (!best || score > best.score) best = { box, score }
  }
  for (let dy = -reach; dy <= reach; dy += coarse) {
    for (let dx = -reach; dx <= reach; dx += coarse) consider(dx, dy, 1)
  }
  if (!best) return null
  const anchor: Located = best
  const centerDx = anchor.box.x + anchor.box.width / 2 - (previous.x + previous.width / 2)
  const centerDy = anchor.box.y + anchor.box.height / 2 - (previous.y + previous.height / 2)
  for (const scale of SCALES) {
    for (let dy = -coarse; dy <= coarse; dy += 1) {
      for (let dx = -coarse; dx <= coarse; dx += 1) consider(centerDx + dx, centerDy + dy, scale)
    }
  }
  return best
}

/**
 * start 번째 프레임의 상자에서 시작해 direction(+1 앞으로, -1 뒤로) 방향으로 따라간다.
 * 놓치면(닮은 정도가 기준 미만) 거기서 멈춘다. 돌려주는 배열에는 시작 프레임이 들어 있지 않다.
 */
export function trackThrough(
  frames: GrayFrame[],
  start: number,
  box: Rect,
  direction: 1 | -1,
  options: TemplateTrackOptions = TEMPLATE_TRACK_DEFAULTS,
): Array<{ index: number; box: Rect; score: number }> {
  const first = frames[start]
  if (!first) return []
  const initial = samplePatch(first, box)
  if (!initial) return []
  let template: Float32Array = initial
  const results: Array<{ index: number; box: Rect; score: number }> = []
  let current = box
  for (let index = start + direction; index >= 0 && index < frames.length; index += direction) {
    const frame = frames[index]
    if (!frame) break
    const found = locate(frame, template, current, options)
    if (!found || found.score < options.minScore) break
    current = found.box
    results.push({ index, box: current, score: found.score })
    if (options.adapt > 0) {
      const fresh = samplePatch(frame, current)
      if (fresh) {
        const blended: Float32Array = new Float32Array(template.length)
        let energy = 0
        for (let i = 0; i < blended.length; i += 1) {
          const value = (template[i] ?? 0) * (1 - options.adapt) + (fresh[i] ?? 0) * options.adapt
          blended[i] = value
          energy += value * value
        }
        const norm = Math.sqrt(energy) || 1
        for (let i = 0; i < blended.length; i += 1) blended[i] = (blended[i] ?? 0) / norm
        template = blended
      }
    }
  }
  return results
}
