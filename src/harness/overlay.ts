import type { FaceBox } from '../detectors/types'
import { loadFrameBitmap, referenceForFrame, type BenchmarkResult } from './benchmark'

export interface OverlayPng {
  clipId: string
  frameIndex: number
  detectorId: string
  pngDataUrl: string
  width: number
  height: number
}

export interface OverlayOptions {
  clips?: string[]
  framesPerClip?: number
  outputWidth?: number
}

function pickFrameIndices(frameCount: number, requested: number): number[] {
  if (frameCount === 0) return []
  if (requested <= 1) return [0]
  const indices = new Set<number>()
  for (let i = 0; i < requested; i += 1) {
    indices.add(Math.min(frameCount - 1, Math.round((i * (frameCount - 1)) / (requested - 1))))
  }
  return [...indices].sort((a, b) => a - b)
}

function drawBoxes(
  context: CanvasRenderingContext2D,
  boxes: FaceBox[],
  color: string,
  label: string,
  scale: number,
  dashed: boolean,
): void {
  context.lineWidth = dashed ? 1.5 : 2
  context.strokeStyle = color
  context.setLineDash(dashed ? [6, 4] : [])
  for (const box of boxes) {
    context.strokeRect(box.x * scale, box.y * scale, box.width * scale, box.height * scale)
  }
  context.setLineDash([])
  if (boxes.length === 0) return
  const first = boxes[0]
  if (!first) return
  const text = `${label} (${boxes.length})`
  context.font = '12px sans-serif'
  const width = context.measureText(text).width + 8
  context.fillStyle = 'rgba(0,0,0,0.65)'
  context.fillRect(Math.max(0, first.x * scale), Math.max(0, first.y * scale - 16), width, 15)
  context.fillStyle = color
  context.fillText(text, Math.max(2, first.x * scale + 4), Math.max(11, first.y * scale - 4))
}

export async function renderOverlayPngs(
  result: BenchmarkResult,
  options: OverlayOptions = {},
): Promise<OverlayPng[]> {
  const outputWidth = options.outputWidth ?? 640
  const framesPerClip = options.framesPerClip ?? 3
  const clips = result.clips.filter((clip) => !options.clips || options.clips.includes(clip.id))
  const outputs: OverlayPng[] = []

  for (const clip of clips) {
    for (const frameIndex of pickFrameIndices(clip.frames.length, framesPerClip)) {
      const frameUrl = clip.frames[frameIndex]
      if (!frameUrl) continue
      const bitmap = await loadFrameBitmap(frameUrl)
      const scale = outputWidth / bitmap.width
      const reference = referenceForFrame(result.detectors, clip.id, frameIndex)
      const drawBase = (context: CanvasRenderingContext2D) => {
        context.drawImage(bitmap, 0, 0, bitmap.width * scale, bitmap.height * scale)
      }

      for (const detector of result.detectors) {
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(bitmap.width * scale)
        canvas.height = Math.round(bitmap.height * scale)
        const context = canvas.getContext('2d')
        if (!context) throw new Error('2D 컨텍스트를 만들지 못했습니다')
        drawBase(context)
        drawBoxes(context, reference, '#ffffff', '다른 모델 합의', scale, true)
        const boxes = detector.clips[clip.id]?.frames.find((frame) => frame.frameIndex === frameIndex)?.boxes ?? []
        drawBoxes(context, boxes, detector.color, detector.id, scale, false)
        outputs.push({
          clipId: clip.id,
          frameIndex,
          detectorId: detector.id,
          pngDataUrl: canvas.toDataURL('image/png'),
          width: canvas.width,
          height: canvas.height,
        })
      }

      const combined = document.createElement('canvas')
      combined.width = Math.round(bitmap.width * scale)
      combined.height = Math.round(bitmap.height * scale)
      const combinedContext = combined.getContext('2d')
      if (!combinedContext) throw new Error('2D 컨텍스트를 만들지 못했습니다')
      drawBase(combinedContext)
      for (const detector of result.detectors) {
        const boxes = detector.clips[clip.id]?.frames.find((frame) => frame.frameIndex === frameIndex)?.boxes ?? []
        drawBoxes(combinedContext, boxes, detector.color, detector.id, scale, false)
      }
      drawBoxes(combinedContext, reference, '#ffffff', '다른 모델 합의', scale, true)
      outputs.push({
        clipId: clip.id,
        frameIndex,
        detectorId: 'combined',
        pngDataUrl: combined.toDataURL('image/png'),
        width: combined.width,
        height: combined.height,
      })

      bitmap.close()
    }
  }
  return outputs
}
