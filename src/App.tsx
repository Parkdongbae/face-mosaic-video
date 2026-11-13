import { useEffect, useMemo, useRef, useState } from 'react'
import { detectorConfigs } from './detectors/registry'
import {
  aggregateMetrics,
  loadFrameBitmap,
  loadManifest,
  referenceForFrame,
  runBenchmark,
  type BenchmarkResult,
  type ClipMetrics,
  type FixtureClip,
  type FixtureManifest,
  type RunProgress,
} from './harness/benchmark'
import { describeEnvironment, type EnvironmentInfo } from './harness/environment'
import { formatPercent } from './harness/metrics'

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id]
}

function drawFrame(
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
  result: BenchmarkResult,
  clip: FixtureClip,
  frameIndex: number,
  detectorIds: string[],
): void {
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d')
  if (!context) return
  context.drawImage(bitmap, 0, 0)

  const reference = referenceForFrame(result.detectors, clip.id, frameIndex)
  context.strokeStyle = 'rgba(255,255,255,0.9)'
  context.setLineDash([10, 6])
  context.lineWidth = 2
  for (const box of reference) context.strokeRect(box.x, box.y, box.width, box.height)
  context.setLineDash([])

  for (const detectorId of detectorIds) {
    const detector = result.detectors.find((item) => item.id === detectorId)
    if (!detector) continue
    const frame = detector.clips[clip.id]?.frames.find((item) => item.frameIndex === frameIndex)
    if (!frame) continue
    context.strokeStyle = detector.color
    context.lineWidth = 3
    context.font = 'bold 20px sans-serif'
    for (const box of frame.boxes) {
      context.strokeRect(box.x, box.y, box.width, box.height)
      context.fillStyle = detector.color
      context.fillText(`${box.score.toFixed(2)}`, box.x, Math.max(20, box.y - 6))
    }
  }
}

function MetricRow({ label, metrics, color }: { label: string; metrics: ClipMetrics; color: string }) {
  return (
    <tr>
      <th scope="row">
        <span className="dot" style={{ background: color }} />
        {label}
      </th>
      <td>{formatPercent(metrics.recall)}</td>
      <td>{formatPercent(metrics.precision)}</td>
      <td>{metrics.missed}</td>
      <td>{metrics.extra}</td>
      <td>{metrics.smallReference > 0 ? formatPercent(metrics.smallRecall) : '-'}</td>
      <td>{metrics.avgMs.toFixed(1)}</td>
      <td>{metrics.fps.toFixed(1)}</td>
      <td>{(metrics.loadMs / 1000).toFixed(1)}s</td>
    </tr>
  )
}

export default function App() {
  const [manifest, setManifest] = useState<FixtureManifest | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([])
  const [selectedDetectorIds, setSelectedDetectorIds] = useState<string[]>(detectorConfigs.map((item) => item.id))
  const [iouThreshold, setIouThreshold] = useState(0.5)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<RunProgress | null>(null)
  const [result, setResult] = useState<BenchmarkResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [environment, setEnvironment] = useState<EnvironmentInfo | null>(null)
  const [viewClipId, setViewClipId] = useState<string | null>(null)
  const [viewFrameIndex, setViewFrameIndex] = useState(0)
  const [viewDetectorIds, setViewDetectorIds] = useState<string[]>(detectorConfigs.map((item) => item.id))
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [loaded, env] = await Promise.all([loadManifest(), describeEnvironment()])
        if (cancelled) return
        setManifest(loaded)
        setEnvironment(env)
        setSelectedClipIds(loaded.clips.map((clip) => clip.id))
        setViewClipId(loaded.clips[0]?.id ?? null)
      } catch (cause) {
        if (cancelled) return
        setManifestError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const viewClip = useMemo(
    () => result?.clips.find((clip) => clip.id === viewClipId) ?? null,
    [result, viewClipId],
  )

  useEffect(() => {
    if (!result || !viewClip) return
    const url = viewClip.frames[viewFrameIndex]
    if (!url) return
    let cancelled = false
    let bitmap: ImageBitmap | null = null
    void (async () => {
      bitmap = await loadFrameBitmap(url)
      if (cancelled) {
        bitmap.close()
        return
      }
      if (canvasRef.current) {
        drawFrame(canvasRef.current, bitmap, result, viewClip, viewFrameIndex, viewDetectorIds)
      }
    })()
    return () => {
      cancelled = true
      bitmap?.close()
    }
  }, [result, viewClip, viewFrameIndex, viewDetectorIds])

  async function handleRun() {
    setRunning(true)
    setError(null)
    setProgress({ phase: '준비', done: 0, total: 0 })
    try {
      const benchmark = await runBenchmark({
        clipIds: selectedClipIds,
        detectorIds: selectedDetectorIds,
        iouThreshold,
        onProgress: setProgress,
      })
      setResult(benchmark)
      if (!viewClipId) setViewClipId(benchmark.clips[0]?.id ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
    }
  }

  function handleDownload() {
    if (!result) return
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'step1-results.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const progressPercent =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">1단계 · 검출 모델 비교 시험</p>
          <h1>영상 얼굴 모자이크</h1>
          <p className="lede">
            같은 시험 프레임으로 후보 얼굴 검출 모델의 재현율·누락·속도를 비교합니다. 영상과 얼굴 정보는
            이 컴퓨터 밖으로 나가지 않습니다.
          </p>
        </div>
        <div className="badge">영상은 이 컴퓨터에서만 처리됩니다</div>
      </header>

      <section className="panel">
        <h2>시험 조건</h2>
        {manifestError ? (
          <p className="alert">
            {manifestError}
            <br />
            <code>npm run fixtures</code> 로 시험 프레임을 만든 뒤 새로고침하세요.
          </p>
        ) : null}

        <div className="grid two">
          <div>
            <h3>시험 클립</h3>
            {manifest ? (
              <ul className="checklist">
                {manifest.clips.map((clip) => (
                  <li key={clip.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedClipIds.includes(clip.id)}
                        onChange={() => setSelectedClipIds((current) => toggle(current, clip.id))}
                      />
                      <span>
                        <strong>{clip.label}</strong>
                        <small>
                          {clip.description} · 프레임 {clip.frames.length}장 · {clip.width}x{clip.height}
                        </small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">시험 목록을 불러오는 중입니다…</p>
            )}
          </div>

          <div>
            <h3>후보 모델</h3>
            <ul className="checklist">
              {detectorConfigs.map((config) => (
                <li key={config.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={selectedDetectorIds.includes(config.id)}
                      onChange={() => setSelectedDetectorIds((current) => toggle(current, config.id))}
                    />
                    <span>
                      <strong>
                        <span className="dot" style={{ background: config.color }} />
                        {config.label}
                      </strong>
                      <small>{config.note}</small>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <label className="inline">
              매칭 IoU
              <select value={iouThreshold} onChange={(event) => setIouThreshold(Number(event.target.value))}>
                <option value={0.3}>0.3 (느슨)</option>
                <option value={0.5}>0.5 (표준)</option>
              </select>
            </label>
          </div>
        </div>

        <div className="actions">
          <button type="button" onClick={handleRun} disabled={running || !manifest}>
            {running ? '측정 중…' : '측정 실행'}
          </button>
          <button type="button" className="ghost" onClick={handleDownload} disabled={!result}>
            결과 JSON 내려받기
          </button>
          {progress ? (
            <span className="progress-label">
              {progress.phase} · {progressPercent}%
            </span>
          ) : null}
        </div>
        {progress && running ? (
          <div className="progress" aria-label="진행률">
            <div style={{ width: `${progressPercent}%` }} />
          </div>
        ) : null}
        {error ? <p className="alert">{error}</p> : null}

        {environment ? (
          <ul className="chips">
            <li>코어 {environment.cores}</li>
            <li>{environment.crossOriginIsolated ? '교차 출처 격리 켜짐' : '교차 출처 격리 꺼짐'}</li>
            <li>{environment.webgpuAdapter ? 'WebGPU 사용 가능' : 'WebGPU 없음'}</li>
            <li>{environment.webgl2 ? 'WebGL2 사용 가능' : 'WebGL2 없음'}</li>
            <li>메모리 {environment.deviceMemoryGb ?? '확인 불가'}</li>
          </ul>
        ) : null}
      </section>

      {result ? (
        <section className="panel">
          <h2>비교 결과</h2>
          <p className="muted">
            기준 상자는 같은 프레임에서 <strong>다른 모델들이 합의한 상자</strong>입니다(의사 정답). 모델마다
            자기 자신을 뺀 합의와 비교하므로 자기 검출로 점수를 올릴 수 없습니다. 사람이 확인하기 전 수치이므로
            아래 오버레이로 누락·오검출을 함께 보세요.
          </p>

          <h3>전체</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">검출기</th>
                  <th scope="col">재현율</th>
                  <th scope="col">정밀도</th>
                  <th scope="col">누락</th>
                  <th scope="col">합의 외 검출</th>
                  <th scope="col">작은 얼굴 재현율</th>
                  <th scope="col">ms/프레임</th>
                  <th scope="col">fps</th>
                  <th scope="col">모델 로딩</th>
                </tr>
              </thead>
              <tbody>
                {result.detectors.map((detector) => (
                  <MetricRow
                    key={detector.id}
                    label={detector.label}
                    color={detector.color}
                    metrics={aggregateMetrics(
                      detector,
                      result.clips.map((clip) => clip.id),
                    )}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {result.clips.map((clip) => (
            <div key={clip.id}>
              <h3>{clip.label}</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">검출기</th>
                      <th scope="col">재현율</th>
                      <th scope="col">정밀도</th>
                      <th scope="col">누락</th>
                      <th scope="col">합의 외 검출</th>
                      <th scope="col">작은 얼굴 재현율</th>
                      <th scope="col">ms/프레임</th>
                      <th scope="col">fps</th>
                      <th scope="col">모델 로딩</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.detectors.map((detector) => {
                      const clipResult = detector.clips[clip.id]
                      if (!clipResult) return null
                      return (
                        <MetricRow
                          key={detector.id}
                          label={detector.label}
                          color={detector.color}
                          metrics={clipResult.metrics}
                        />
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <details>
            <summary>모델 진단 정보(실제 입출력)</summary>
            <pre>{JSON.stringify(result.detectors.map((detector) => ({ id: detector.id, diagnostics: detector.diagnostics })), null, 2)}</pre>
          </details>
        </section>
      ) : null}

      {result && viewClip ? (
        <section className="panel">
          <h2>오버레이 확인</h2>
          <div className="viewer-controls">
            <label>
              클립
              <select
                value={viewClip.id}
                onChange={(event) => {
                  setViewClipId(event.target.value)
                  setViewFrameIndex(0)
                }}
              >
                {result.clips.map((clip) => (
                  <option key={clip.id} value={clip.id}>
                    {clip.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              프레임 {viewFrameIndex + 1}/{viewClip.frames.length}
              <input
                type="range"
                min={0}
                max={Math.max(0, viewClip.frames.length - 1)}
                value={viewFrameIndex}
                onChange={(event) => setViewFrameIndex(Number(event.target.value))}
              />
            </label>
          </div>
          <ul className="chips">
            {result.detectors.map((detector) => (
              <li key={detector.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={viewDetectorIds.includes(detector.id)}
                    onChange={() => setViewDetectorIds((current) => toggle(current, detector.id))}
                  />
                  <span className="dot" style={{ background: detector.color }} />
                  {detector.label}
                </label>
              </li>
            ))}
          </ul>
          <div className="canvas-wrap">
            <canvas ref={canvasRef} />
          </div>
          <p className="muted">흰 점선은 다른 모델 합의 상자, 색 상자는 선택한 모델의 검출입니다.</p>
        </section>
      ) : null}

      <footer className="foot">
        <p>
          1단계 시험판입니다. 시험 영상은 Wikimedia Commons의 CC0 사진을 합성해 만들었고, 실제 학생 얼굴
          영상은 사용하지 않았습니다.
        </p>
      </footer>
    </div>
  )
}
