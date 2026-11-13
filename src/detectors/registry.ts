import { createMediaPipeDetector } from './mediapipe'
import { createOnnxDetector, type OnnxDetectorTuning } from './onnx/detector'
import type { DetectorConfig, FaceDetectorAdapter } from './types'

export const detectorConfigs: DetectorConfig[] = [
  {
    id: 'mp_short',
    label: 'MediaPipe BlazeFace short-range',
    kind: 'mediapipe',
    modelPath: '/models/blaze_face_short_range.tflite',
    scoreThreshold: 0.3,
    color: '#e11d48',
    note: '카메라에 가까운 얼굴용 기본 모델',
  },
  {
    id: 'mp_full',
    label: 'MediaPipe BlazeFace full-range',
    kind: 'mediapipe',
    modelPath: '/models/blaze_face_full_range.tflite',
    scoreThreshold: 0.3,
    color: '#7c3aed',
    note: '영상·원거리 얼굴용 모델',
  },
  {
    id: 'yunet',
    label: 'YuNet 2023mar (ONNX)',
    kind: 'onnx',
    family: 'yunet',
    modelPath: '/models/face_detection_yunet_2023mar.onnx',
    scoreThreshold: 0.3,
    color: '#0891b2',
    note: 'OpenCV Zoo, 경량',
  },
  {
    id: 'scrfd',
    label: 'SCRFD-10G (ONNX)',
    kind: 'onnx',
    family: 'scrfd',
    modelPath: '/models/scrfd_10g_gnkps_fp32.onnx',
    scoreThreshold: 0.3,
    color: '#ca8a04',
    note: 'InsightFace 계열, 고정밀 대형 모델',
  },
]

export function findDetectorConfig(id: string): DetectorConfig {
  const config = detectorConfigs.find((item) => item.id === id)
  if (!config) throw new Error(`알 수 없는 검출기: ${id}`)
  return config
}

export interface DetectorFactoryOptions {
  tuning?: OnnxDetectorTuning
  log?: (message: string) => void
}

export function createDetector(config: DetectorConfig, options: DetectorFactoryOptions = {}): FaceDetectorAdapter {
  if (config.kind === 'mediapipe') return createMediaPipeDetector(config, options.log)
  const family = config.family ?? 'yunet'
  return createOnnxDetector(config, family, options.tuning, options.log)
}
