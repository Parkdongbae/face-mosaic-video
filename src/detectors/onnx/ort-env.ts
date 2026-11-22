import * as ort from 'onnxruntime-web'

let configured = false

const WASM_PREFIX = '/wasm/ort/'

let threadLimit: number | null = null

/**
 * ONNX Runtime 스레드 수 상한. 검출 워커를 여러 개 띄울 때 워커마다 1개로 제한해 코어를 나눠 쓴다.
 * 첫 모델 로딩 전에 불러야 적용된다(ONNX Runtime 은 첫 세션을 만들 때 스레드 수를 읽는다).
 */
export function limitOrtThreads(limit: number): void {
  threadLimit = Math.max(1, Math.floor(limit))
  // 이미 설정을 마쳤어도 아직 첫 세션 전이면 반영되도록 줄여 둔다(늘리지는 않는다).
  if (configured) ort.env.wasm.numThreads = Math.min(ort.env.wasm.numThreads ?? 1, threadLimit)
}

/**
 * ONNX Runtime Web 설정. WASM 파일은 public/wasm/ort 에서만 읽는다.
 * SharedArrayBuffer(멀티스레드)는 교차 출처 격리가 켜진 경우에만 사용한다.
 */
export function ensureOrtConfigured(): typeof ort {
  if (!configured) {
    const automatic = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) : 1
    ort.env.wasm.wasmPaths = WASM_PREFIX
    ort.env.wasm.simd = true
    ort.env.wasm.numThreads = threadLimit === null ? automatic : Math.min(automatic, threadLimit)
    ort.env.logLevel = 'warning'
    configured = true
  }
  return ort
}

export function describeOrtEnvironment(): string {
  ensureOrtConfigured()
  return `wasmPaths=${WASM_PREFIX}, threads=${ort.env.wasm.numThreads}, simd=${String(ort.env.wasm.simd)}, crossOriginIsolated=${String(self.crossOriginIsolated)}`
}
