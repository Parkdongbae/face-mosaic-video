/**
 * 장면 전환(컷) 찾기.
 * 얼굴을 "같은 자리에서 다시 잡히면 같은 얼굴"로 이어 붙이고 그 사이를 계속 가리려면, 장면이 바뀌지 않았다는 전제가 필요하다.
 * 장면이 바뀌면 같은 자리에 전혀 다른 것이 있으므로, 오래 끊긴 얼굴을 이어 붙이거나 그 사이를 이어 가리는 일은 그 지점을 넘지 않는다.
 *
 * 프레임을 아주 작은 흑백 그림(서명)으로 줄여 앞 프레임과 견준다. 그림 자체는 보관하지 않고 바로 버린다.
 * 카메라를 빠르게 돌리면 화면이 통째로 밀려 그대로는 닮지 않아 보이므로, 위치를 밀어 맞춰 본 뒤에도 닮지 않을 때만 장면이 바뀐 것으로 본다.
 * (측정: 프레임당 126px 로 화면을 돌릴 때 그대로 견주면 -0.2, 위치를 맞추면 0.95. 실제 컷은 위치를 맞춰도 0.3 이하.)
 */

/** 서명 그림의 크기(픽셀). 이 정도로 줄이면 누가 찍혔는지 알아볼 수 없고, 화면 구성이 바뀌었는지만 알 수 있다. */
export const SCENE_SIGNATURE = { width: 32, height: 18 } as const

/** 이 값보다 닮은 정도가 낮으면 장면이 바뀐 것으로 본다 */
const CUT_SIMILARITY = 0.6
/** 화면 이동을 맞춰 보려고 서명을 밀어 보는 최대 거리(서명 폭·높이 대비 비율) */
const MAX_SHIFT_RATIO = 0.25
/** 밝기 변화가 이보다 작은(거의 단색인) 프레임은 견줄 무늬가 없으므로 판단하지 않는다 */
const FLAT_STD = 3

/**
 * b 를 (dx, dy) 만큼 민 것과 a 가 겹치는 부분의 닮은 정도(-1~1). 밝기·대비가 통째로 바뀐 것(조명, 플래시)은 닮은 것으로 본다.
 * 겹치는 부분이 거의 단색이면 견줄 무늬가 없으므로 null.
 */
function similarityAt(a: ArrayLike<number>, b: ArrayLike<number>, width: number, height: number, dx: number, dy: number): number | null {
  let count = 0
  let sumA = 0
  let sumB = 0
  let sumAA = 0
  let sumBB = 0
  let sumAB = 0
  for (let y = Math.max(0, dy); y < Math.min(height, height + dy); y += 1) {
    for (let x = Math.max(0, dx); x < Math.min(width, width + dx); x += 1) {
      const va = a[y * width + x] ?? 0
      const vb = b[(y - dy) * width + (x - dx)] ?? 0
      count += 1
      sumA += va
      sumB += vb
      sumAA += va * va
      sumBB += vb * vb
      sumAB += va * vb
    }
  }
  if (count === 0) return null
  const varianceA = sumAA / count - (sumA / count) ** 2
  const varianceB = sumBB / count - (sumB / count) ** 2
  if (varianceA < FLAT_STD ** 2 || varianceB < FLAT_STD ** 2) return null
  return (sumAB / count - (sumA / count) * (sumB / count)) / Math.sqrt(varianceA * varianceB)
}

/**
 * 두 서명이 닮은 정도(-1~1). 그대로 견줘서 충분히 닮았으면 그 값을, 아니면 위치를 밀어 맞춰 본 최댓값을 돌려준다
 * (카메라가 움직여 화면이 통째로 밀린 경우). 거의 단색이라 판단할 수 없으면 null.
 * 서명은 SCENE_SIGNATURE 크기여야 한다.
 */
export function sceneSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number | null {
  const { width, height } = SCENE_SIGNATURE
  if (a.length !== width * height || b.length !== a.length) return null
  const plain = similarityAt(a, b, width, height, 0, 0)
  if (plain === null || plain >= CUT_SIMILARITY) return plain
  let best = plain
  const maxX = Math.round(width * MAX_SHIFT_RATIO)
  const maxY = Math.round(height * MAX_SHIFT_RATIO)
  for (let dy = -maxY; dy <= maxY; dy += 1) {
    for (let dx = -maxX; dx <= maxX; dx += 1) {
      const value = similarityAt(a, b, width, height, dx, dy)
      if (value !== null && value > best) best = value
    }
  }
  return best
}

/** 앞 프레임과 견줘 장면이 바뀌었는지 */
export function isSceneCut(previous: ArrayLike<number>, current: ArrayLike<number>): boolean {
  const similarity = sceneSimilarity(previous, current)
  return similarity !== null && similarity < CUT_SIMILARITY
}

/**
 * 검출 워커들이 순서와 무관하게 돌려주는 서명을 프레임 순서대로 견줘 장면이 바뀌는 프레임 번호를 모은다.
 * 견준 서명은 바로 버리므로 영상 길이와 상관없이 몇 장만 들고 있다.
 */
export class SceneCutFinder {
  /** 새 장면이 시작되는 프레임 번호(오름차순) */
  readonly cuts: number[] = []
  private readonly pending = new Map<number, Uint8Array>()
  private previous: Uint8Array | null = null
  private next = 0

  /** step: 서명이 들어오는 프레임 간격(검출을 하는 프레임 간격) */
  constructor(private readonly step = 1) {}

  add(frame: number, signature: Uint8Array): void {
    this.pending.set(frame, signature)
    for (let current = this.pending.get(this.next); current; current = this.pending.get(this.next)) {
      this.pending.delete(this.next)
      if (this.previous && isSceneCut(this.previous, current)) this.cuts.push(this.next)
      this.previous = current
      this.next += this.step
    }
  }
}

/** frame 이 속한 장면의 범위 [start, end). cuts 는 새 장면이 시작되는 프레임 번호(오름차순). */
export function sceneRange(cuts: ArrayLike<number>, frame: number, frameCount: number): { start: number; end: number } {
  // frame 이하인 컷의 개수를 이분 탐색으로 센다.
  let low = 0
  let high = cuts.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((cuts[middle] ?? 0) <= frame) low = middle + 1
    else high = middle
  }
  return { start: low > 0 ? (cuts[low - 1] ?? 0) : 0, end: low < cuts.length ? (cuts[low] ?? frameCount) : frameCount }
}
