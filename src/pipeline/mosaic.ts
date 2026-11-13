import type { Rect } from '../core/geometry'

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

/**
 * 픽셀 모자이크(glm.md 4-5). 영역을 아주 작게 줄여 그렸다가 보간 없이 다시 키운다.
 * 줄이는 순간 원본 픽셀 정보가 사라지므로 결과에서 얼굴을 되살릴 수 없다(불투명하게 덮어씀).
 * scratch 는 호출 쪽에서 재사용하는 작은 캔버스다.
 */
export function applyPixelMosaic(context: Context2D, rect: Rect, blocksAcross: number, scratch: OffscreenCanvas): void {
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width < 1 || height < 1) return
  const cols = Math.max(1, Math.min(blocksAcross, width))
  const rows = Math.max(1, Math.min(Math.round((cols * height) / width), height))
  if (scratch.width !== cols || scratch.height !== rows) {
    scratch.width = cols
    scratch.height = rows
  }
  const small = scratch.getContext('2d')
  if (!small) throw new Error('모자이크용 캔버스를 만들지 못했습니다')
  small.imageSmoothingEnabled = true
  small.imageSmoothingQuality = 'medium'
  small.clearRect(0, 0, cols, rows)
  small.drawImage(context.canvas, rect.x, rect.y, width, height, 0, 0, cols, rows)

  const previous = context.imageSmoothingEnabled
  context.imageSmoothingEnabled = false
  context.drawImage(scratch, 0, 0, cols, rows, rect.x, rect.y, width, height)
  context.imageSmoothingEnabled = previous
}
