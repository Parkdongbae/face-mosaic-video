import type { FaceBox } from '../types'

export interface LetterboxTransform {
  /** 원본 -> 모델 입력 배율 */
  scale: number
  /** 모델 입력에서 원본이 시작하는 위치(px) */
  padX: number
  padY: number
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
}

/** 원본 비율을 유지한 채 목표 크기 가운데에 맞춘다(남는 곳은 검은 여백). */
export function computeLetterbox(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): LetterboxTransform {
  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight)
  const padX = (targetWidth - sourceWidth * scale) / 2
  const padY = (targetHeight - sourceHeight * scale) / 2
  return { scale, padX, padY, sourceWidth, sourceHeight, targetWidth, targetHeight }
}

/** 모델 입력 좌표의 상자를 원본 이미지 좌표로 되돌린다. */
export function toSourceBox(box: FaceBox, transform: LetterboxTransform): FaceBox {
  return {
    x: (box.x - transform.padX) / transform.scale,
    y: (box.y - transform.padY) / transform.scale,
    width: box.width / transform.scale,
    height: box.height / transform.scale,
    score: box.score,
  }
}

/** 원본 좌표의 상자를 모델 입력 좌표로 옮긴다(테스트·검증용). */
export function toModelBox(box: FaceBox, transform: LetterboxTransform): FaceBox {
  return {
    x: box.x * transform.scale + transform.padX,
    y: box.y * transform.scale + transform.padY,
    width: box.width * transform.scale,
    height: box.height * transform.scale,
    score: box.score,
  }
}
