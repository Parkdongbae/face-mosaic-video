import * as ort from 'onnxruntime-web'
import { nms } from '../../harness/metrics'
import type {
  AnchorOrder,
  DetectionOutput,
  DetectorConfig,
  DetectorDiagnostics,
  DetectSource,
  SourceRegion,
  FaceDetectorAdapter,
  FaceBox,
  NormalizationVariant,
  OnnxTuning,
} from '../types'
import { decodeScrfd, decodeYunet } from './decode'
import { ensureOrtConfigured } from './ort-env'
import { mapBoxesToSource, prepareInput } from './preprocess'

export type OnnxDetectorTuning = OnnxTuning

interface ResolvedTuning {
  variant: NormalizationVariant
  anchorOrder: AnchorOrder
  inputSize: number
  nmsThreshold: number
}

const BASE_TUNING: ResolvedTuning = {
  variant: 'rgb128',
  anchorOrder: 'anchor-minor',
  inputSize: 640,
  nmsThreshold: 0.4,
}

function resolveTuning(family: 'yunet' | 'scrfd', tuning: OnnxDetectorTuning): ResolvedTuning {
  // 모델별 기본값. YuNet: BGR 0~255 원값, 칸당 앵커 1개. SCRFD: RGB (x-127.5)/128, 칸당 앵커 2개가 칸 순서대로 나열.
  const familyDefaults: Partial<ResolvedTuning> = family === 'yunet' ? { variant: 'bgr255' } : { variant: 'rgb128' }
  return { ...BASE_TUNING, ...familyDefaults, ...tuning }
}

/**
 * ONNX 얼굴 검출기(YuNet / SCRFD 공용 실행기).
 * 전처리 정규화와 앵커 순서는 모델마다 다를 수 있어 tuning 으로 바꿀 수 있게 두었다.
 */
export function createOnnxDetector(
  config: DetectorConfig,
  family: 'yunet' | 'scrfd',
  tuning: OnnxDetectorTuning = {},
  log?: (message: string) => void,
): FaceDetectorAdapter {
  const resolved = resolveTuning(family, tuning)
  const resolvedTuning = { current: resolved }
  let session: ort.InferenceSession | null = null
  let canvas: OffscreenCanvas | null = null
  let modelDiagnostics: DetectorDiagnostics | null = null

  return {
    config,
    updateTuning(next: OnnxDetectorTuning) {
      resolvedTuning.current = { ...resolvedTuning.current, ...next }
    },
    async init() {
      const runtime = ensureOrtConfigured()
      session = await runtime.InferenceSession.create(config.modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })
      canvas = new OffscreenCanvas(resolvedTuning.current.inputSize, resolvedTuning.current.inputSize)
      modelDiagnostics = {
        inputNames: [...session.inputNames],
        outputNames: [...session.outputNames],
        inputDims: [],
        outputDims: [],
      }
      log?.(`${config.id}: ONNX 로딩 완료 입출력=${session.inputNames.join(',')} / ${session.outputNames.join(',')}`)
    },
    diagnostics() {
      return modelDiagnostics
    },
    async detect(source: DetectSource, region?: SourceRegion): Promise<DetectionOutput> {
      if (!session || !canvas) throw new Error(`${config.id}: init()을 먼저 호출해야 합니다`)
      const current = resolvedTuning.current
      const started = performance.now()
      const prepared = prepareInput(source, current.inputSize, current.variant, canvas, region)
      const inputName = session.inputNames[0]
      if (!inputName) throw new Error(`${config.id}: 모델 입력 이름을 찾지 못했습니다`)
      const tensor = new ort.Tensor('float32', prepared.tensor, [1, 3, current.inputSize, current.inputSize])
      const outputs = await session.run({ [inputName]: tensor })

      if (modelDiagnostics && modelDiagnostics.outputDims.length === 0) {
        modelDiagnostics.inputDims = [tensor.dims as number[]]
        modelDiagnostics.outputDims = Object.values(outputs).map((value) => [...value.dims])
      }

      const decoded =
        family === 'yunet'
          ? decodeYunet(outputs, {
              inputSize: current.inputSize,
              scoreThreshold: config.scoreThreshold,
              anchorOrder: current.anchorOrder,
            })
          : decodeScrfd(outputs, {
              inputSize: current.inputSize,
              scoreThreshold: config.scoreThreshold,
              anchorOrder: current.anchorOrder,
            })

      const boxes: FaceBox[] = mapBoxesToSource(
        nms(decoded, current.nmsThreshold),
        prepared.transform,
        source.width,
        source.height,
        region?.x ?? 0,
        region?.y ?? 0,
      )
      const ms = performance.now() - started
      return { boxes, ms }
    },
    dispose() {
      void session?.release()
      session = null
      canvas = null
      modelDiagnostics = null
    },
  }
}
