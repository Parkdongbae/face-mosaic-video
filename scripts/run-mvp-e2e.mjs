// 2단계(MVP) 검증: 시험 영상을 실제 브라우저에서 분석 → 모자이크 → MP4 저장까지 돌리고 결과 파일을 다시 열어 확인한다.
// 사용: npm run e2e            (10초짜리 720p 시험 영상)
//       npm run e2e -- --long  (5분짜리 1080p 시험 영상, 완료 기준 확인용)
//       npm run e2e -- --video=경로.mp4 [--sensitivity=low|normal|high] [--keep]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'
import { chromium } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const videoDir = path.join(root, 'tests', 'fixtures', 'videos')
const reportDir = path.join(root, 'reports')
const baseUrl = 'http://127.0.0.1:5173/'

const args = process.argv.slice(2)
const option = (name) => args.find((item) => item.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const long = args.includes('--long')
const sensitivity = option('sensitivity') ?? 'normal'

function log(message) {
  console.log(`[e2e] ${message}`)
}

/** 공개 라이선스 사진으로 만든 교실 클립을 반복하고 소리(사인파)를 붙여 시험 영상을 만든다. */
function buildFixture(destination, { seconds, width, height }) {
  if (existsSync(destination)) return
  log(`시험 영상 생성: ${path.relative(root, destination)}`)
  const source = path.join(root, 'tests', 'fixtures', 'clips', 'classroom-wide.mp4')
  if (!existsSync(source)) throw new Error('tests/fixtures/clips/classroom-wide.mp4 가 없습니다. 먼저 npm run fixtures 를 실행하세요.')
  const result = spawnSync(
    ffmpegPath,
    [
      '-nostdin', '-y',
      '-stream_loop', '-1', '-i', source,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', String(seconds),
      '-vf', `scale=${width}:${height}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-g', '60',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', '+faststart',
      destination,
    ],
    { windowsHide: true, encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`ffmpeg 실패: ${result.stderr?.slice(-600)}`)
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
  await mkdir(videoDir, { recursive: true })
  await mkdir(reportDir, { recursive: true })
  let videoPath = option('video')
  if (!videoPath) {
    videoPath = path.join(videoDir, long ? 'mvp-5min-1080p.mp4' : 'mvp-10s-720p.mp4')
    buildFixture(videoPath, long ? { seconds: 300, width: 1920, height: 1080 } : { seconds: 10, width: 1280, height: 720 })
  }
  videoPath = path.resolve(videoPath)
  log(`입력: ${videoPath}`)

  const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const serverLog = []
  server.stdout.on('data', (chunk) => serverLog.push(chunk.toString()))
  server.stderr.on('data', (chunk) => serverLog.push(chunk.toString()))

  let browser
  let failed = false
  try {
    await waitForServer()
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.on('console', (message) => {
      const text = message.text()
      if (message.type() === 'error' && !text.startsWith('INFO:')) log(`페이지 오류: ${text}`)
    })
    page.on('pageerror', (error) => log(`페이지 예외: ${error.message}`))

    // 개인정보 검사(glm.md 7장): 처리 중 같은 도메인 밖으로 나가는 요청이 없어야 한다.
    const requests = []
    page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }))

    await page.goto(`${baseUrl}?e2e`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'e2e-file'
      document.body.append(input)
    })
    await page.setInputFiles('#e2e-file', videoPath)
    const requestsBeforeJob = requests.length

    page.on('console', (message) => {
      if (message.text().startsWith('[job]')) log(message.text().slice(6))
    })

    const result = await page.evaluate(async ({ sensitivity }) => {
      const { MosaicClient } = await import('/src/pipeline/client.ts')
      const { MOSAIC_DEFAULTS } = await import('/src/config/mosaic-defaults.ts')
      const { probeVideo } = await import('/src/pipeline/probe.ts')
      const { prepareSource } = await import('/src/pipeline/source.ts')
      const { summarizeMedia, compareFrames } = await import('/src/pipeline/verify.ts')
      const { buildMaskPlan } = await import('/src/core/tracker.ts')

      // 원본을 처리할 수 있는 형태로 준비한다(바로 열 수 없는 형식이면 ffmpeg.wasm 으로 변환).
      const original = document.querySelector('#e2e-file').files[0]
      const convertStarted = performance.now()
      const prepared = await prepareSource(original, {})
      const convertSec = (performance.now() - convertStarted) / 1000
      const file = prepared.workFile
      const info = await probeVideo(file)
      const settings = {
        regions: [],
        sensitivity,
        quality: MOSAIC_DEFAULTS.quality,
        marginRatio: MOSAIC_DEFAULTS.marginRatio,
        blocksAcross: MOSAIC_DEFAULTS.blocksAcross,
        maxGapFrames: MOSAIC_DEFAULTS.maxGapFrames,
        padFrames: MOSAIC_DEFAULTS.padFrames,
      }

      // 메모리 추이: 처리 내내 주기적으로 잰다(워커 포함).
      const memory = []
      let sampling = true
      const startedAt = performance.now()
      const sampleMemory = async () => {
        while (sampling) {
          try {
            const measured = await performance.measureUserAgentSpecificMemory()
            memory.push({ sec: Math.round((performance.now() - startedAt) / 1000), mb: Math.round(measured.bytes / 1048576) })
          } catch {
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 5000))
        }
      }
      void sampleMemory()

      let lastLog = 0
      const report = (progress) => {
        const now = performance.now()
        if (now - lastLog < 10000 && progress.fraction < 1) return
        lastLog = now
        console.log(`[job] ${progress.phase === 'analyze' ? '분석' : '저장'} ${(progress.fraction * 100).toFixed(0)}% · ${progress.frames}프레임 · 초당 ${progress.fps.toFixed(1)}장`)
      }

      const client = new MosaicClient()
      const analysis = await client.analyze(file, settings, report)
      const directory = await navigator.storage.getDirectory()
      const handle = await directory.getFileHandle('e2e_mosaic.mp4', { create: true })
      const rendered = await client.render(file, analysis, settings, handle, report)
      client.dispose()
      sampling = false

      const outputFile = await handle.getFile()
      const [source, output] = await Promise.all([summarizeMedia(file, false), summarizeMedia(outputFile, true)])

      // 가림이 있는 프레임 몇 장을 골라 원본과 결과를 비교한다.
      const plan = buildMaskPlan(analysis.tracks, {
        frameCount: analysis.frameCount,
        frameWidth: analysis.width,
        frameHeight: analysis.height,
        maxGapFrames: settings.maxGapFrames,
        padFrames: settings.padFrames,
        marginRatio: settings.marginRatio,
      })
      const masked = plan.map((boxes, frame) => (boxes.length > 0 ? frame : -1)).filter((frame) => frame >= 0)
      const picks = [0.1, 0.5, 0.9].map((ratio) => masked[Math.floor(masked.length * ratio)]).filter((frame) => frame !== undefined)
      const comparisons = []
      for (const frame of picks) {
        const timeSec = analysis.timestampsUs[frame] / 1e6
        comparisons.push({ frame, masks: plan[frame].length, ...(await compareFrames(file, outputFile, timeSec, plan[frame])) })
      }

      return {
        info,
        original: { name: original.name, sizeBytes: original.size },
        route: prepared.route,
        convertSec,
        conversion: prepared.conversion
          ? { streams: prepared.conversion.streams, videoTranscoded: prepared.conversion.videoTranscoded, audioAction: prepared.conversion.audioAction, bytes: file.size }
          : null,
        settings,
        analysis: {
          frameCount: analysis.frameCount,
          tracks: analysis.tracks.length,
          detections: analysis.detections,
          elapsedSec: analysis.elapsedMs / 1000,
          framesWithMask: masked.length,
        },
        render: { ...rendered.stats, elapsedSec: rendered.stats.elapsedMs / 1000 },
        outputBytes: outputFile.size,
        source,
        output,
        comparisons,
        memory,
      }
    }, { sensitivity })

    const external = requests.slice(requestsBeforeJob).filter((request) => !request.url.startsWith(baseUrl) && !request.url.startsWith('blob:') && !request.url.startsWith('data:'))
    const nonGet = requests.slice(requestsBeforeJob).filter((request) => request.method !== 'GET')

    if (args.includes('--keep')) {
      // 결과 파일을 디스크로 꺼내 직접 재생해 볼 수 있게 한다.
      const base64 = await page.evaluate(async () => {
        const directory = await navigator.storage.getDirectory()
        const file = await (await directory.getFileHandle('e2e_mosaic.mp4')).getFile()
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return btoa(binary)
      })
      const kept = path.join(reportDir, `${path.basename(videoPath, path.extname(videoPath))}_mosaic.mp4`)
      await writeFile(kept, Buffer.from(base64, 'base64'))
      log(`결과 파일 저장: ${path.relative(root, kept)}`)
    }

    const { source, output } = result
    const frameTime = 1 / Math.max(1, result.info.fps)
    const checks = [
      ['해상도가 원본과 같다', output.width === source.width - (source.width % 2) && output.height === source.height - (source.height % 2)],
      ['프레임 수가 원본과 같다', output.video.packets === source.video.packets && output.decodedFrames === source.video.packets],
      ['영상 길이가 원본과 같다(오차 1프레임 이내)', Math.abs(output.video.endTimestamp - source.video.endTimestamp) <= frameTime],
      ['출력이 H.264다', output.video.codec === 'avc'],
      ['첫 프레임이 키프레임이다', output.video.startsWithKey],
      ['소리 트랙이 유지된다', (source.audio === null) === (output.audio === null)],
      ['소리 길이가 원본과 같다(오차 0.05초 이내)', !source.audio || (output.audio && Math.abs(output.audio.endTimestamp - source.audio.endTimestamp) <= 0.05)],
      ['소리·영상 시작 시각 차이가 원본과 같다(싱크)', !source.audio || (output.audio && Math.abs((output.audio.firstTimestamp - output.video.firstTimestamp) - (source.audio.firstTimestamp - source.video.firstTimestamp)) <= 0.01)],
      ['소리가 재압축 없이 복사됐다(패킷 수 동일)', !source.audio || (output.audio && output.audio.packets === source.audio.packets && output.audio.codec === source.audio.codec)],
      ['분석·렌더링 프레임 시각이 모두 일치한다', result.render.timestampMismatches === 0 && result.render.frames === result.analysis.frameCount],
      ['얼굴이 검출되어 가려진 프레임이 있다', result.analysis.framesWithMask > 0 && result.comparisons.length > 0],
      ['가린 영역 안은 모자이크로 뭉개졌다', result.comparisons.every((item) => item.insideDetailOutput < item.insideDetailSource * 0.6)],
      ['가린 영역 밖은 원본과 거의 같다', result.comparisons.every((item) => item.outsideDiff < 6)],
      ['같은 도메인 밖으로 나간 요청이 없다', external.length === 0],
      ['처리 중 전송(POST 등) 요청이 없다', nonGet.length === 0],
    ]

    const report = { generatedAt: new Date().toISOString(), video: path.relative(root, videoPath), ...result, externalRequests: external, nonGetRequests: nonGet, checks: checks.map(([name, ok]) => ({ name, ok: Boolean(ok) })) }
    const reportFile = path.join(reportDir, option('video') ? `e2e-${path.basename(videoPath).replace(/[^A-Za-z0-9._-]/g, '_')}.json` : long ? 'step2-e2e-long.json' : 'step2-e2e.json')
    await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

    if (result.route === 'convert') {
      const c = result.conversion
      log(`변환 경로: 원본 ${c.streams.videoCodec}${c.streams.audioCodec ? ` + ${c.streams.audioCodec}` : ''} → H.264 MP4 (${c.videoTranscoded ? '영상 재압축' : '영상 복사'}, 소리 ${c.audioAction}), ${result.convertSec.toFixed(1)}초, 중간 파일 ${(c.bytes / 1048576).toFixed(1)}MB`)
    } else {
      log('빠른 경로: 변환 없이 바로 처리')
    }
    log(`영상: ${result.info.width}x${result.info.height}${result.info.rotation ? `(회전 ${result.info.rotation}°)` : ''}, ${result.info.durationSec.toFixed(1)}초, ${result.info.fps.toFixed(2)}fps, ${(result.info.sizeBytes / 1048576).toFixed(1)}MB, 소리=${result.info.audioCodec ?? '없음'}`)
    log(`분석: ${result.analysis.elapsedSec.toFixed(1)}초, 추적 ${result.analysis.tracks}개, 가린 프레임 ${result.analysis.framesWithMask}/${result.analysis.frameCount}`)
    log(`저장: ${result.render.elapsedSec.toFixed(1)}초, 결과 ${(result.outputBytes / 1048576).toFixed(1)}MB`)
    log(`총 처리 시간 / 영상 길이 = ${((result.analysis.elapsedSec + result.render.elapsedSec) / result.info.durationSec).toFixed(2)}배`)
    if (result.memory.length > 0) {
      const values = result.memory.map((item) => item.mb)
      log(`메모리(MB) 표본 ${values.length}개: 처음 ${values[0]}, 최대 ${Math.max(...values)}, 마지막 ${values[values.length - 1]}`)
    } else {
      log('메모리: 측정하지 못함')
    }
    console.table(result.comparisons.map((item) => ({ frame: item.frame, masks: item.masks, insideDiff: item.insideDiff.toFixed(1), outsideDiff: item.outsideDiff.toFixed(2), detailSrc: item.insideDetailSource.toFixed(2), detailOut: item.insideDetailOutput.toFixed(2) })))
    for (const [name, ok] of checks) console.log(`${ok ? '  통과' : '  실패'}  ${name}`)
    failed = checks.some(([, ok]) => !ok)
    log(`보고서: ${path.relative(root, reportFile)}`)
  } finally {
    await browser?.close()
    if (server.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true })
      else server.kill('SIGTERM')
    }
    if (serverLog.length > 0) await writeFile(path.join(reportDir, 'dev-server-e2e.log'), serverLog.join(''), 'utf8')
  }
  if (failed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
