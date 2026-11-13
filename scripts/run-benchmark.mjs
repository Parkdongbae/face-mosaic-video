// 개발 서버를 띄우고 Chrome에서 1단계 벤치마크를 실행해 결과 JSON과 오버레이 PNG를 저장한다.
// 사용: npm run bench  (옵션: --skip-calibrate, --frames=3)
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const reportDir = path.join(root, 'reports')
const overlayDir = path.join(reportDir, 'overlays')
const baseUrl = 'http://127.0.0.1:5173/'

const args = new Set(process.argv.slice(2))
const skipCalibrate = args.has('--skip-calibrate')
const framesArg = [...args].find((item) => item.startsWith('--frames='))
const framesPerClip = framesArg ? Number(framesArg.split('=')[1]) : 3

function log(message) {
  console.log(`[bench] ${message}`)
}

async function waitForServer(timeoutMs = 90000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(baseUrl, { cache: 'no-store' })
      if (response.ok) return
    } catch {
      // 서버가 아직 준비되지 않음
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('개발 서버가 제한 시간 안에 응답하지 않았습니다')
}

function stopServer(server) {
  if (server.exitCode !== null || server.killed) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  server.kill('SIGTERM')
}

async function main() {
  await mkdir(overlayDir, { recursive: true })

  log('개발 서버 시작')
  const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const serverLog = []
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()))
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()))

  let browser
  try {
    await waitForServer()
    log('Chrome 실행 (headless)')
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('console', (message) => {
      if (message.type() === 'error') log(`페이지 오류: ${message.text()}`)
    })
    page.on('pageerror', (error) => log(`페이지 예외: ${error.message}`))

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => Boolean(window.__mosaicBench), null, { timeout: 60000 })

    const environment = await page.evaluate(() => window.__mosaicBench.environment())
    log(`환경: ${JSON.stringify(environment)}`)

    if (!skipCalibrate) {
      log('캘리브레이션 실행')
      const calibration = await page.evaluate(() => window.__mosaicBench.calibrate())
      await writeFile(path.join(reportDir, 'calibration.json'), `${JSON.stringify(calibration, null, 2)}\n`, 'utf8')
      console.table(calibration)
    }

    log('벤치마크 실행 (전체 클립 × 전체 모델)')
    const result = await page.evaluate(
      () => window.__mosaicBench.runAll({ iouThreshold: 0.5, warmupRuns: 2 }),
    )
    await writeFile(path.join(reportDir, 'step1-results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

    log('오버레이 렌더링')
    const overlays = await page.evaluate(
      ([benchmark, count]) => window.__mosaicBench.renderOverlays(benchmark, { framesPerClip: count }),
      [result, framesPerClip],
    )
    for (const overlay of overlays) {
      const name = `${overlay.clipId}-f${String(overlay.frameIndex + 1).padStart(2, '0')}-${overlay.detectorId}.png`
      const base64 = overlay.pngDataUrl.split(',')[1] ?? ''
      await writeFile(path.join(overlayDir, name), Buffer.from(base64, 'base64'))
    }
    log(`오버레이 ${overlays.length}장 저장: ${path.relative(root, overlayDir)}`)

    const rows = result.detectors.map((detector) => {
      const clips = Object.values(detector.clips)
      const frames = clips.reduce((sum, clip) => sum + clip.metrics.frames, 0)
      const matched = clips.reduce((sum, clip) => sum + clip.metrics.matched, 0)
      const reference = clips.reduce((sum, clip) => sum + clip.metrics.reference, 0)
      const detections = clips.reduce((sum, clip) => sum + clip.metrics.detections, 0)
      const smallReference = clips.reduce((sum, clip) => sum + clip.metrics.smallReference, 0)
      const smallMatched = clips.reduce((sum, clip) => sum + clip.metrics.smallMatched, 0)
      const ms = clips.reduce((sum, clip) => sum + clip.metrics.avgMs, 0) / Math.max(1, clips.length)
      return {
        detector: detector.id,
        recall: reference > 0 ? (matched / reference).toFixed(3) : '-',
        precision: detections > 0 ? (matched / detections).toFixed(3) : '-',
        missed: reference - matched,
        extra: detections - matched,
        smallRecall: smallReference > 0 ? (smallMatched / smallReference).toFixed(3) : '-',
        msPerFrame: ms.toFixed(1),
        fps: ms > 0 ? (1000 / ms).toFixed(1) : '-',
        loadMs: clips[0]?.metrics.loadMs.toFixed(0) ?? '-',
        frames,
      }
    })
    console.table(rows)
  } finally {
    await browser?.close()
    stopServer(server)
    if (serverLog.length > 0) await writeFile(path.join(reportDir, 'dev-server.log'), serverLog.join(''), 'utf8')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
