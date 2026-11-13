// 5단계(검토·수정) 검증: 자동 검출이 놓친 얼굴을 한 프레임에서 직접 표시하면 앞뒤 프레임이 자동으로 채워지는지 확인한다.
// "놓친 얼굴"은 실제 얼굴 자리에 제외 영역을 씌워 자동 가림이 빠지게 해서 만든다.
// 사용: npm run e2e:review
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const reportDir = path.join(root, 'reports')
const baseUrl = 'http://127.0.0.1:5173/'
const videoPath = path.join(root, 'tests', 'fixtures', 'videos', 'mvp-10s-720p.mp4')

function log(message) {
  console.log(`[review] ${message}`)
}

async function waitForServer(timeoutMs = 90000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(baseUrl, { cache: 'no-store' })).ok) return
    } catch {
      // 아직 준비되지 않음
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('개발 서버가 제한 시간 안에 응답하지 않았습니다')
}

async function main() {
  if (!existsSync(videoPath)) throw new Error('시험 영상이 없습니다. 먼저 npm run e2e 를 한 번 실행하세요.')
  await mkdir(reportDir, { recursive: true })
  const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  })

  let browser
  let failed = false
  try {
    await waitForServer()
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('pageerror', (error) => log(`페이지 예외: ${error.message}`))
    await page.goto(`${baseUrl}?e2e`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'e2e-file'
      document.body.append(input)
    })
    await page.setInputFiles('#e2e-file', videoPath)

    const result = await page.evaluate(async () => {
      const { MosaicClient } = await import('/src/pipeline/client.ts')
      const { MOSAIC_DEFAULTS } = await import('/src/config/mosaic-defaults.ts')
      const { planMasks } = await import('/src/core/mask-plan.ts')
      const { rectIou } = await import('/src/core/geometry.ts')
      const { compareFrames, summarizeMedia } = await import('/src/pipeline/verify.ts')
      const file = document.querySelector('#e2e-file').files[0]
      const client = new MosaicClient()
      const base = {
        sensitivity: MOSAIC_DEFAULTS.sensitivity,
        quality: MOSAIC_DEFAULTS.quality,
        marginRatio: MOSAIC_DEFAULTS.marginRatio,
        blocksAcross: MOSAIC_DEFAULTS.blocksAcross,
        maxGapFrames: MOSAIC_DEFAULTS.maxGapFrames,
        padFrames: MOSAIC_DEFAULTS.padFrames,
      }
      const analysis = await client.analyze(file, { ...base, regions: [] })

      // 가장 오래 이어진 얼굴 추적을 "놓친 얼굴" 역할로 고른다.
      const track = [...analysis.tracks].sort((a, b) => b.points.length - a.points.length)[0]
      // 장면 전환 직후가 아니라 장면 한가운데의 프레임을 고른다(시험 영상은 1.25초=37.5프레임마다 장면이 바뀌므로 1/4, 1/2 지점은 전환 직후다).
      const middle = track.points[Math.floor((track.points.length * 3) / 8)]
      const frame = middle.frame
      const face = middle.box
      // 그 얼굴이 움직이는 범위를 제외 영역으로 덮어 자동 가림이 빠지게 한다.
      const xs = track.points.flatMap((point) => [point.box.x, point.box.x + point.box.width])
      const ys = track.points.flatMap((point) => [point.box.y, point.box.y + point.box.height])
      const pad = 40
      const hole = {
        id: 'missed',
        shape: { kind: 'rect', rect: { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, width: Math.max(...xs) - Math.min(...xs) + pad * 2, height: Math.max(...ys) - Math.min(...ys) + pad * 2 } },
        exclude: true,
        startSec: null,
        endSec: null,
      }
      const settings = { ...base, regions: [hole] }
      const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
      const covers = (masks, point) => masks.some((mask) => point.x >= mask.x && point.x <= mask.x + mask.width && point.y >= mask.y && point.y <= mask.y + mask.height)

      const before = planMasks(analysis, settings, { manualTracks: [], removedTrackIds: [] })
      const coveredBefore = covers(before[frame], center(face))

      // 한 프레임에서만 얼굴을 표시한다 → 앞뒤 프레임은 추적으로 채워져야 한다.
      const started = performance.now()
      const points = await client.trackFace(file, analysis.timestampsUs[frame], face, MOSAIC_DEFAULTS.manualTrackSpanSec)
      const trackSec = (performance.now() - started) / 1000
      const edits = { manualTracks: [{ id: -1, points }], removedTrackIds: [] }
      const after = planMasks(analysis, settings, edits)

      // 따라간 상자가 실제 얼굴(자동 검출이 잡았던 위치)과 얼마나 겹치는지
      const byTime = new Map(points.map((point) => [point.timeUs, point.box]))
      const overlaps = []
      let coveredFrames = 0
      let comparable = 0
      for (const point of track.points) {
        const manualBox = byTime.get(analysis.timestampsUs[point.frame])
        if (manualBox) overlaps.push(rectIou(manualBox, point.box))
        // 추적이 닿은 구간 안에서, 실제 얼굴의 중심이 가림 안에 들어가는 프레임 수
        const time = analysis.timestampsUs[point.frame]
        if (time >= points[0].timeUs && time <= points[points.length - 1].timeUs) {
          comparable += 1
          if (covers(after[point.frame], center(point.box))) coveredFrames += 1
        }
      }

      // 실제로 저장해서 그 자리(앞·표시한 프레임·뒤)가 모자이크로 뭉개졌는지 확인한다.
      const directory = await navigator.storage.getDirectory()
      const handle = await directory.getFileHandle('review_mosaic.mp4', { create: true })
      const rendered = await client.render(file, analysis, settings, handle, undefined, null, edits)
      client.dispose()
      const output = await handle.getFile()
      const summary = await summarizeMedia(output, false)
      const frameOf = (timeUs) => analysis.timestampsUs.indexOf(timeUs)
      const firstFrame = frameOf(points[0].timeUs)
      const lastFrame = frameOf(points[points.length - 1].timeUs)
      const picks = [...new Set([Math.round((firstFrame + frame) / 2), frame, Math.round((frame + lastFrame) / 2)])]
      const comparisons = []
      for (const pick of picks) {
        const masks = after[pick].filter((mask) => mask.trackId === -1)
        comparisons.push({ frame: pick, masks: masks.length, ...(await compareFrames(file, output, analysis.timestampsUs[pick] / 1e6, masks)) })
      }

      return {
        frames: analysis.frameCount,
        markedFrame: frame,
        face,
        trackPoints: track.points.length,
        coveredBefore,
        manualPoints: points.length,
        manualFirstFrame: firstFrame,
        manualLastFrame: lastFrame,
        trackSec,
        meanIou: overlaps.reduce((sum, value) => sum + value, 0) / Math.max(1, overlaps.length),
        minIou: Math.min(...overlaps),
        coveredFrames,
        comparable,
        mismatches: rendered.stats.timestampMismatches,
        outputFrames: summary.video.packets,
        comparisons,
      }
    })

    log(`놓친 얼굴 역할: 프레임 ${result.markedFrame} 의 얼굴 (${Math.round(result.face.width)}x${Math.round(result.face.height)}px), 자동 검출은 이 얼굴을 ${result.trackPoints}프레임 동안 잡고 있었음`)
    log(`한 프레임에서 표시 → ${result.manualPoints}프레임 채움 (프레임 ${result.manualFirstFrame}~${result.manualLastFrame}), 추적 ${result.trackSec.toFixed(1)}초`)
    log(`따라간 상자와 실제 얼굴의 겹침(IoU): 평균 ${result.meanIou.toFixed(2)}, 최소 ${result.minIou.toFixed(2)}`)
    log(`채운 구간에서 실제 얼굴 중심이 가림 안에 든 프레임: ${result.coveredFrames}/${result.comparable}`)
    console.table(result.comparisons.map((item) => ({ frame: item.frame, masks: item.masks, insideDiff: item.insideDiff.toFixed(1), outsideDiff: item.outsideDiff.toFixed(2), detailSrc: item.insideDetailSource.toFixed(2), detailOut: item.insideDetailOutput.toFixed(2) })))

    const checks = [
      ['(준비) 수정 전에는 그 얼굴이 가려지지 않는다', result.coveredBefore === false],
      ['얼굴을 한 프레임에서 추가하면 여러 프레임이 채워진다', result.manualPoints >= 10],
      ['표시한 프레임보다 앞쪽 프레임도 채워진다', result.manualFirstFrame < result.markedFrame],
      ['표시한 프레임보다 뒤쪽 프레임도 채워진다', result.manualLastFrame > result.markedFrame],
      ['따라간 상자가 실제 얼굴 위치와 맞는다(평균 IoU 0.6 이상)', result.meanIou >= 0.6],
      ['채운 구간의 모든 프레임에서 실제 얼굴이 가림 안에 있다', result.comparable > 0 && result.coveredFrames === result.comparable],
      ['저장한 영상에서 그 자리(앞·표시한 프레임·뒤)가 모자이크로 뭉개졌다', result.comparisons.length >= 3 && result.comparisons.every((item) => item.masks > 0 && item.insideDetailOutput < item.insideDetailSource * 0.6)],
      ['저장한 영상의 프레임 수·시각이 원본과 일치한다', result.outputFrames === result.frames && result.mismatches === 0],
    ]
    for (const [name, ok] of checks) console.log(`${ok ? '  통과' : '  실패'}  ${name}`)
    failed = checks.some(([, ok]) => !ok)
    await writeFile(path.join(reportDir, 'step5-review.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), ...result, checks: checks.map(([name, ok]) => ({ name, ok: Boolean(ok) })) }, null, 2)}\n`, 'utf8')
  } finally {
    await browser?.close()
    if (server.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true })
      else server.kill('SIGTERM')
    }
  }
  if (failed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
