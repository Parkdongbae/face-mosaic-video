/**
 * 영상 분할 계획(PRD F-16, glm.md 3-7). 자르는 위치는 항상 키프레임이다.
 * 이 파일은 계산만 한다(파일을 읽거나 쓰지 않는다).
 */

/** 키프레임 하나. bytesBefore 는 이 키프레임 앞까지의 누적 용량(영상+소리 추정). */
export interface KeyFramePoint {
  timeSec: number
  bytesBefore: number
}

export interface KeyFrameIndex {
  /** 시간 순서. 첫 항목이 영상의 첫 키프레임 */
  keyFrames: KeyFramePoint[]
  /** 영상이 끝나는 시각 */
  endSec: number
  /** 전체 용량(영상+소리 추정) */
  totalBytes: number
}

export interface SplitPiece {
  /** 1부터 */
  index: number
  startSec: number
  endSec: number
  estimatedBytes: number
}

export type SplitMode = { kind: 'count'; count: number } | { kind: 'size'; maxBytes: number }

export const SPLIT_LIMITS = {
  minCount: 2,
  maxCount: 20,
  /** 컨테이너 부가 정보·소리 추정 오차를 감안해 상한의 이 비율까지만 채운다. */
  sizeTargetRatio: 0.97,
} as const

/** 키프레임 사이 간격이 용량 상한보다 커서 상한을 지킬 수 없을 때 */
export class SplitNotPossibleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SplitNotPossibleError'
  }
}

function toPieces(index: KeyFrameIndex, cutPositions: number[]): SplitPiece[] {
  // cutPositions: 조각이 시작하는 키프레임 번호(첫 조각의 0 포함), 오름차순·중복 없음
  const pieces: SplitPiece[] = []
  for (let i = 0; i < cutPositions.length; i += 1) {
    const start = index.keyFrames[cutPositions[i]!]!
    const nextPosition = cutPositions[i + 1]
    const next = nextPosition === undefined ? null : index.keyFrames[nextPosition]!
    pieces.push({
      index: i + 1,
      startSec: start.timeSec,
      endSec: next ? next.timeSec : index.endSec,
      estimatedBytes: (next ? next.bytesBefore : index.totalBytes) - start.bytesBefore,
    })
  }
  return pieces
}

/** 개수 분할: 목표 시각(전체 길이 × k/N)에서 가장 가까운 키프레임에서 자른다. */
export function planByCount(index: KeyFrameIndex, count: number): SplitPiece[] {
  if (!Number.isInteger(count) || count < SPLIT_LIMITS.minCount || count > SPLIT_LIMITS.maxCount) {
    throw new RangeError(`파일 개수는 ${SPLIT_LIMITS.minCount}~${SPLIT_LIMITS.maxCount} 사이여야 합니다.`)
  }
  const frames = index.keyFrames
  if (frames.length === 0) throw new SplitNotPossibleError('키프레임을 찾지 못해 나눌 수 없습니다.')
  const startSec = frames[0]!.timeSec
  const span = index.endSec - startSec
  const cuts = [0]
  for (let k = 1; k < count; k += 1) {
    const target = startSec + (span * k) / count
    let best = -1
    let bestDistance = Infinity
    for (let i = cuts[cuts.length - 1]! + 1; i < frames.length; i += 1) {
      const distance = Math.abs(frames[i]!.timeSec - target)
      if (distance < bestDistance) {
        best = i
        bestDistance = distance
      } else if (frames[i]!.timeSec > target) {
        break
      }
    }
    // 키프레임이 모자라면 조각 수가 줄어든다(같은 키프레임에서 두 번 자르지 않는다).
    if (best > 0) cuts.push(best)
  }
  return toPieces(index, cuts)
}

/**
 * 용량 분할: 누적 용량이 상한에 닿기 직전의 키프레임에서 자른다. 어떤 조각도 상한을 넘지 않는다.
 * 키프레임 간격 하나가 상한보다 크면 지킬 수 없으므로 오류를 던진다.
 */
export function planBySize(index: KeyFrameIndex, maxBytes: number): SplitPiece[] {
  if (!(maxBytes > 0)) throw new RangeError('파일당 최대 용량은 0보다 커야 합니다.')
  const frames = index.keyFrames
  if (frames.length === 0) throw new SplitNotPossibleError('키프레임을 찾지 못해 나눌 수 없습니다.')
  const limit = maxBytes * SPLIT_LIMITS.sizeTargetRatio
  const cuts = [0]
  let start = 0
  for (;;) {
    const base = frames[start]!.bytesBefore
    if (index.totalBytes - base <= limit) break
    // start 뒤에서, 조각 용량이 limit 이하가 되는 마지막 키프레임을 찾는다.
    let next = -1
    for (let i = start + 1; i < frames.length; i += 1) {
      if (frames[i]!.bytesBefore - base <= limit) next = i
      else break
    }
    if (next < 0) {
      const from = frames[start]!.timeSec
      throw new SplitNotPossibleError(
        `${from.toFixed(1)}초 부근은 키프레임 간격이 너무 길어 이 용량으로는 나눌 수 없습니다. 상한을 높이거나 개수로 나눠 주세요.`,
      )
    }
    cuts.push(next)
    start = next
  }
  return toPieces(index, cuts)
}

export function planSplit(index: KeyFrameIndex, mode: SplitMode): SplitPiece[] {
  return mode.kind === 'count' ? planByCount(index, mode.count) : planBySize(index, mode.maxBytes)
}

/** 조각 파일 이름: 원본이름_part01.mp4 / 원본이름_part01_mosaic.mp4 (두 자리 번호) */
export function pieceFileName(originalName: string, pieceIndex: number, mosaic: boolean): string {
  const dot = originalName.lastIndexOf('.')
  const base = dot > 0 ? originalName.slice(0, dot) : originalName
  return `${base}_part${String(pieceIndex).padStart(2, '0')}${mosaic ? '_mosaic' : ''}.mp4`
}
