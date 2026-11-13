export interface EnvironmentInfo {
  userAgent: string
  cores: number
  deviceMemoryGb: number | null
  crossOriginIsolated: boolean
  sharedArrayBuffer: boolean
  webgpuAdapter: boolean
  webgl2: boolean
}

interface NavigatorWithHints extends Navigator {
  deviceMemory?: number
  gpu?: { requestAdapter(): Promise<unknown> }
}

export async function describeEnvironment(): Promise<EnvironmentInfo> {
  const hints = navigator as NavigatorWithHints
  let webgpuAdapter = false
  if (hints.gpu) {
    try {
      webgpuAdapter = (await hints.gpu.requestAdapter()) !== null
    } catch {
      webgpuAdapter = false
    }
  }

  let webgl2 = false
  try {
    const canvas = document.createElement('canvas')
    webgl2 = canvas.getContext('webgl2') !== null
  } catch {
    webgl2 = false
  }

  return {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency || 0,
    deviceMemoryGb: hints.deviceMemory ?? null,
    crossOriginIsolated: self.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    webgpuAdapter,
    webgl2,
  }
}
