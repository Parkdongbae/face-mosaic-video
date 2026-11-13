import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import type { DetectionOutput, DetectorConfig, DetectSource, FaceDetectorAdapter, FaceBox } from './types'

type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>

let filesetPromise: Promise<WasmFileset> | null = null

function loadFileset(): Promise<WasmFileset> {
  // public/wasm/tasks-vision 아래에 두고 같은 도메인에서 제공한다(외부 CDN 금지).
  filesetPromise ??= FilesetResolver.forVisionTasks('/wasm/tasks-vision')
  return filesetPromise
}

export function createMediaPipeDetector(config: DetectorConfig, diagnostics?: (message: string) => void): FaceDetectorAdapter {
  let detector: FaceDetector | null = null

  return {
    config,
    async init() {
      const fileset = await loadFileset()
      detector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: config.modelPath, delegate: 'CPU' },
        runningMode: 'IMAGE',
        minDetectionConfidence: config.scoreThreshold,
        minSuppressionThreshold: 0.3,
      })
      diagnostics?.(`${config.id}: MediaPipe wasm 로딩 완료 (${config.modelPath})`)
    },
    async detect(source: DetectSource): Promise<DetectionOutput> {
      if (!detector) throw new Error(`${config.id}: init()을 먼저 호출해야 합니다`)
      const started = performance.now()
      const result = detector.detect(source)
      const ms = performance.now() - started
      const boxes: FaceBox[] = []
      for (const detection of result.detections) {
        const box = detection.boundingBox
        if (!box) continue
        boxes.push({
          x: box.originX,
          y: box.originY,
          width: box.width,
          height: box.height,
          score: detection.categories[0]?.score ?? 0,
        })
      }
      return { boxes, ms }
    },
    dispose() {
      detector?.close()
      detector = null
    },
  }
}
