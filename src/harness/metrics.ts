import type { FaceBox } from '../detectors/types'

/** 두 상자의 교집합/합집합 비율. 0..1 */
export function iou(a: FaceBox, b: FaceBox): number {
  const left = Math.max(a.x, b.x)
  const top = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top)
  if (intersection === 0) return 0
  const union = a.width * a.height + b.width * b.height - intersection
  return union <= 0 ? 0 : intersection / union
}

export interface MatchResult {
  matched: number
  missed: number
  extra: number
  /** 예측 인덱스 -> 정답 인덱스 */
  matches: Array<{ prediction: number; target: number; iou: number }>
}

/**
 * 일대일 그리디 매칭. IoU가 높은 쌍부터 확정한다.
 * 정답(target) 기준 미검출(missed)과 예측(prediction) 기준 초과(extra)를 함께 돌려준다.
 */
export function matchBoxes(predictions: FaceBox[], targets: FaceBox[], threshold = 0.5): MatchResult {
  const candidates: Array<{ prediction: number; target: number; iou: number }> = []
  for (let p = 0; p < predictions.length; p += 1) {
    for (let t = 0; t < targets.length; t += 1) {
      const value = iou(predictions[p]!, targets[t]!)
      if (value >= threshold) candidates.push({ prediction: p, target: t, iou: value })
    }
  }
  candidates.sort((a, b) => b.iou - a.iou)

  const usedPredictions = new Set<number>()
  const usedTargets = new Set<number>()
  const matches: MatchResult['matches'] = []
  for (const candidate of candidates) {
    if (usedPredictions.has(candidate.prediction) || usedTargets.has(candidate.target)) continue
    usedPredictions.add(candidate.prediction)
    usedTargets.add(candidate.target)
    matches.push(candidate)
  }

  return {
    matched: matches.length,
    missed: targets.length - usedTargets.size,
    extra: predictions.length - usedPredictions.size,
    matches,
  }
}

/** 점수 높은 상자부터 남기고 겹치는 낮은 점수 상자를 버린다. */
export function nms(boxes: FaceBox[], threshold = 0.5): FaceBox[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score)
  const kept: FaceBox[] = []
  for (const box of sorted) {
    if (kept.every((other) => iou(box, other) < threshold)) kept.push(box)
  }
  return kept
}

export function clampBox(box: FaceBox, width: number, height: number): FaceBox {
  const x = Math.max(0, Math.min(box.x, width - 1))
  const y = Math.max(0, Math.min(box.y, height - 1))
  const right = Math.max(x + 1, Math.min(box.x + box.width, width))
  const bottom = Math.max(y + 1, Math.min(box.y + box.height, height))
  return { x, y, width: right - x, height: bottom - y, score: box.score }
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}
