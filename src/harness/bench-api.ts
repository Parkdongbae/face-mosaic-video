import { createDetector, detectorConfigs } from '../detectors/registry'
import type { AnchorOrder, FaceBox, NormalizationVariant, OnnxTuning } from '../detectors/types'
import {
  loadFrameBitmap,
  loadManifest,
  runBenchmark,
  type BenchmarkResult,
  type FixtureManifest,
  type RunOptions,
} from './benchmark'
import { describeEnvironment, type EnvironmentInfo } from './environment'
import { renderOverlayPngs, type OverlayOptions, type OverlayPng } from './overlay'

export interface CalibrationRow {
  detectorId: string
  variant: NormalizationVariant
  anchorOrder: AnchorOrder | 'default'
  detections: number
  topScore: number
  ms: number
}

export interface BenchApi {
  listClips(): Promise<FixtureManifest>
  runAll(options?: RunOptions): Promise<BenchmarkResult>
  renderOverlays(result: BenchmarkResult, options?: OverlayOptions): Promise<OverlayPng[]>
  calibrate(frameUrl?: string): Promise<CalibrationRow[]>
  environment(): Promise<EnvironmentInfo>
}

function topScore(boxes: FaceBox[]): number {
  return boxes.reduce((max, box) => Math.max(max, box.score), 0)
}

async function calibrate(frameUrl?: string): Promise<CalibrationRow[]> {
  const manifest = await loadManifest()
  const clip = manifest.clips.find((item) => item.id === 'closeup') ?? manifest.clips[0]
  const url = frameUrl ?? clip?.frames[0]
  if (!url) throw new Error('캘리브레이션에 쓸 프레임이 없습니다')
  const bitmap = await loadFrameBitmap(url)
  const rows: CalibrationRow[] = []
  const variants: NormalizationVariant[] = ['rgb128', 'bgr128', 'rgb01', 'bgrmean', 'bgr255']

  for (const config of detectorConfigs.filter((item) => item.kind === 'onnx')) {
    const adapter = createDetector(config)
    await adapter.init()
    const apply = (tuning: OnnxTuning) => adapter.updateTuning?.(tuning)

    const variantScores: Array<{ variant: NormalizationVariant; detections: number }> = []
    for (const variant of variants) {
      apply({ variant })
      const detection = await adapter.detect(bitmap)
      variantScores.push({ variant, detections: detection.boxes.length })
      rows.push({
        detectorId: config.id,
        variant,
        anchorOrder: 'default',
        detections: detection.boxes.length,
        topScore: topScore(detection.boxes),
        ms: detection.ms,
      })
    }

    const best = variantScores.reduce((winner, current) =>
      current.detections > winner.detections ? current : winner,
    )
    for (const anchorOrder of ['anchor-minor', 'anchor-major'] as AnchorOrder[]) {
      apply({ variant: best.variant, anchorOrder })
      const detection = await adapter.detect(bitmap)
      rows.push({
        detectorId: config.id,
        variant: best.variant,
        anchorOrder,
        detections: detection.boxes.length,
        topScore: topScore(detection.boxes),
        ms: detection.ms,
      })
    }
    adapter.dispose()
  }

  bitmap.close()
  return rows
}

export function installBenchApi(): void {
  window.__mosaicBench = {
    listClips: loadManifest,
    runAll: runBenchmark,
    renderOverlays: renderOverlayPngs,
    calibrate,
    environment: describeEnvironment,
  }
}
