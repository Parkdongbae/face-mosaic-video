// 4단계(영상 분할) 검증: 실제 브라우저에서 재압축 없이 나누고(분할만 하기), 조각별로 모자이크 처리해 저장한 뒤 결과를 다시 연다.
// 사용: npm run e2e:split                       (5분 1080p 시험 영상, 20MB 상한 + 3개 분할)
//       npm run e2e:split -- --big              (2GB 이상 시험 영상을 만들어 500MB 상한으로 분할)
//       npm run e2e:split -- --video=경로 --max-mb=500 [--no-mosaic]
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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
const big = args.includes('--big')

function log(message) {
  console.log(`[split] ${message}`)
}

/** 2GB 를 넘는 시험 영상: 5분 1080p 시험 영상을 높은 비트레이트로 다시 압축해 14분 길이로 만든다. */
function buildBigFixture(destination) {
  if (existsSync(destination) && statSync(destination).size > 2 * 1024 ** 3) return
  log(`2GB 이상 시험 영상 생성(수 분 걸림): ${path.relative(root, destination)}`)
  const source = path.join(videoDir, 'mvp-5min-1080p.mp4')
  if (!existsSync(source)) throw new Error('mvp-5min-1080p.mp4 가 없습니다. 먼저 npm run e2e -- --long 을 실행하세요.')
  const result = spawnSync(
    ffmpegPath,
    [
      '-nostdin', '-y', '-stream_loop', '-1', '-i', source, '-t', '840',
      // 잡음을 섞어 압축이 잘 안 되게 해서 용량을 채운다. 비트레이트를 고정해 약 2.2GB 가 되게 한다.
      '-vf', 'noise=alls=18:allf=t',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '21M', '-minrate', '21M', '-maxrate', '21M', '-bufsize', '42M',
      '-pix_fmt', 'yuv420p', '-g', '60', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', destination,
    ],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
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
  await mkdir(reportDir, { recursive: true })
  let videoPath = option('video')
  if (!videoPath) {
    videoPath = path.join(videoDir, big ? 'split-2gb-1080p.mp4' : 'mvp-5min-1080p.mp4')
    if (big) buildBigFixture(videoPath)
  }
  videoPath = path.resolve(videoPath)
  const maxMb = Number(option('max-mb') ?? (big ? 500 : 20))
  const withMosaic = !args.includes('--no-mosaic') && !big
  log(`입력: ${videoPath} (${(statSync(videoPath).size / 1024 ** 2).toFixed(0)}MB), 상한 ${maxMb}MB`)

  const server = spawn(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  })

  let browser
  let failed = false
  const profileDir = path.join(reportDir, '.split-profile')
  try {
    await waitForServer()
    // 임시(시크릿) 프로필은 브라우저 내부 저장소 한도가 작아 2GB 조각을 쓸 수 없으므로, 디스크에 프로필을 두는 방식으로 띄운다.
    await rm(profileDir, { recursive: true, force: true })
    browser = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: true, viewport: { width: 1280, height: 900 } })
    const page = await browser.newPage()
    page.on('pageerror', (error) => log(`페이지 예외: ${error.message}`))
    page.on('console', (message) => {
      if (message.text().startsWith('[job]')) log(message.text().slice(6))
    })
    await page.goto(`${baseUrl}?e2e`, { waitUntil: 'domcontentloaded' })
    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.id = 'e2e-file'
      document.body.append(input)
    })
    await page.setInputFiles('#e2e-file', videoPath)

    const result = await page.evaluate(
      async ({ maxMb, withMosaic }) => {
        const { MosaicClient } = await import('/src/pipeline/client.ts')
        const { planSplit, pieceFileName } = await import('/src/core/split-plan.ts')
        const { summarizeMedia, decodeEdges, detectFacesAt } = await import('/src/pipeline/verify.ts')
        const { MOSAIC_DEFAULTS } = await import('/src/config/mosaic-defaults.ts')
        const { buildMaskPlan, nearestIndex } = await import('/src/core/tracker.ts')
        const file = document.querySelector('#e2e-file').files[0]
        const directory = await navigator.storage.getDirectory()
        const client = new MosaicClient()

        const memory = []
        let sampling = true
        const t0 = performance.now()
        void (async () => {
          while (sampling) {
            try {
              const measured = await performance.measureUserAgentSpecificMemory()
              memory.push({ sec: Math.round((performance.now() - t0) / 1000), mb: Math.round(measured.bytes / 1048576) })
            } catch {
              return
            }
            await new Promise((resolve) => setTimeout(resolve, 3000))
          }
        })()
        let lastLog = 0
        const report = (label) => (progress) => {
          const now = performance.now()
          if (now - lastLog < 10000 && progress.fraction < 1) return
          lastLog = now
          console.log(`[job] ${label} ${(progress.fraction * 100).toFixed(0)}%`)
        }

        const source = await summarizeMedia(file, false)
        const indexStarted = performance.now()
        const index = await client.keyFrames(file)
        const indexSec = (performance.now() - indexStarted) / 1000

        const outcome = { source, indexSec, keyFrames: index.keyFrames.length, plans: [] }
        const maxBytes = maxMb * 1024 * 1024
        for (const mode of [{ kind: 'size', maxBytes }, { kind: 'count', count: 3 }]) {
          const pieces = planSplit(index, mode)
          const handles = []
          for (const piece of pieces) handles.push(await directory.getFileHandle(pieceFileName(file.name, piece.index, false), { create: true }))
          const started = performance.now()
          const split = await client.split(file, pieces, handles, report(`분할(${mode.kind})`))
          const splitSec = (performance.now() - started) / 1000
          const summaries = []
          for (let i = 0; i < pieces.length; i += 1) {
            const pieceFile = await handles[i].getFile()
            const summary = await summarizeMedia(pieceFile, false)
            // 각 조각이 실제로 재생되는지: 처음과 끝의 프레임을 해독해 본다.
            const decoded = await decodeEdges(pieceFile, 15)
            summaries.push({ name: pieceFile.name, bytes: pieceFile.size, planned: pieces[i], written: split.pieces[i], summary, decoded })
          }
          outcome.plans.push({ mode, splitSec, pieces: summaries })
          // 다음 분할을 위해 방금 쓴 조각을 지워 저장 공간을 비운다.
          for (const handle of handles) await directory.removeEntry(handle.name).catch(() => undefined)
          if (mode.kind === 'count' && withMosaic) {
            // 조각별 모자이크 처리: 전체를 한 번 분석하고 조각마다 구간을 나눠 저장한다.
            const settings = {
              regions: [],
              sensitivity: MOSAIC_DEFAULTS.sensitivity,
              quality: MOSAIC_DEFAULTS.quality,
              marginRatio: MOSAIC_DEFAULTS.marginRatio,
              blocksAcross: MOSAIC_DEFAULTS.blocksAcross,
              maxGapFrames: MOSAIC_DEFAULTS.maxGapFrames,
              padFrames: MOSAIC_DEFAULTS.padFrames,
            }
            const analysis = await client.analyze(file, settings, report('분석'))
            const plan = buildMaskPlan(analysis.tracks, {
              frameCount: analysis.frameCount,
              frameWidth: analysis.width,
              frameHeight: analysis.height,
              maxGapFrames: settings.maxGapFrames,
              padFrames: settings.padFrames,
              marginRatio: settings.marginRatio,
            })
            // 얼굴 상자의 중심이 가림 사각형 안에 있으면 "가려진 얼굴"로 본다.
            const exposedAt = (boxes, sourceSec) => {
              const masks = plan[nearestIndex(analysis.timestampsUs, sourceSec * 1e6)] ?? []
              return boxes.filter((box) => {
                const cx = box.x + box.width / 2
                const cy = box.y + box.height / 2
                return !masks.some((mask) => cx >= mask.x && cx <= mask.x + mask.width && cy >= mask.y && cy <= mask.y + mask.height)
              }).length
            }
            const mosaic = []
            for (let i = 0; i < pieces.length; i += 1) {
              const piece = pieces[i]
              const handle = await directory.getFileHandle(pieceFileName(file.name, piece.index, true), { create: true })
              const range = { startSec: piece.startSec, endSec: i === pieces.length - 1 ? null : piece.endSec }
              const rendered = await client.render(file, analysis, settings, handle, report(`조각 ${piece.index} 저장`), range)
              const pieceFile = await handle.getFile()
              const summary = await summarizeMedia(pieceFile, true)
              // 경계 전후 프레임: 조각의 처음·끝 5프레임에서 얼굴이 검출되는지(결과 영상), 원본의 같은 시각에서는 몇 개 검출되는지
              const frameSec = 1 / 30
              const duration = summary.video.endTimestamp
              const edgeTimes = []
              for (let k = 0; k < 5; k += 1) edgeTimes.push(k * frameSec)
              for (let k = 5; k >= 1; k -= 1) edgeTimes.push(Math.max(0, duration - k * frameSec))
              const sourceTimes = edgeTimes.map((time) => time + piece.startSec)
              const outputBoxes = await detectFacesAt(pieceFile, edgeTimes, 0.5)
              const sourceBoxes = await detectFacesAt(file, sourceTimes, 0.5)
              // 대조군: 조각 한가운데(경계가 아닌 곳)의 프레임 10장
              const middleTimes = []
              for (let k = 0; k < 10; k += 1) middleTimes.push(duration / 2 + k * frameSec)
              const middleBoxes = await detectFacesAt(pieceFile, middleTimes, 0.5)
              mosaic.push({
                name: pieceFile.name,
                bytes: pieceFile.size,
                stats: rendered.stats,
                summary,
                // 원본에서 검출되는 얼굴 수(경계 프레임)
                sourceFaces: sourceBoxes.map((boxes) => boxes.length),
                // 원본의 얼굴 중 가림 계획에 들어 있지 않은 것(분석이 놓친 얼굴)
                sourceUncovered: sourceBoxes.map((boxes, i) => exposedAt(boxes, sourceTimes[i])),
                // 결과 영상에서 검출된 것(모자이크 무늬를 얼굴로 잡은 것 포함)
                outputFaces: outputBoxes.map((boxes) => boxes.length),
                // 결과 영상에서 가림 사각형 밖에 드러난 얼굴 = 실제 노출
                outputExposed: outputBoxes.map((boxes, i) => exposedAt(boxes, sourceTimes[i])),
                middleExposed: middleBoxes.map((boxes, i) => exposedAt(boxes, middleTimes[i] + piece.startSec)),
              })
            }
            outcome.mosaic = mosaic
          }
        }
        client.dispose()
        sampling = false
        outcome.memory = memory
        return outcome
      },
      { maxMb, withMosaic },
    )

    const { source } = result
    const frameTime = 1 / 30
    const checks = []
    log(`원본: ${source.width}x${source.height}, ${source.durationSec.toFixed(2)}초, 영상 ${source.video.packets}프레임, 소리 ${source.audio?.packets ?? 0}패킷 · 키프레임 ${result.keyFrames}개(읽는 데 ${result.indexSec.toFixed(1)}초)`)
    for (const plan of result.plans) {
      const label = plan.mode.kind === 'size' ? `용량 분할(${maxMb}MB 상한)` : `개수 분할(${plan.mode.count}개)`
      log(`${label}: ${plan.pieces.length}조각, ${plan.splitSec.toFixed(1)}초`)
      console.table(plan.pieces.map((piece) => ({
        파일: piece.name,
        시작: piece.planned.startSec.toFixed(2),
        끝: piece.planned.endSec.toFixed(2),
        '예상MB': (piece.planned.estimatedBytes / 1048576).toFixed(1),
        '실제MB': (piece.bytes / 1048576).toFixed(1),
        프레임: piece.summary.video.packets,
        소리패킷: piece.summary.audio?.packets ?? 0,
        길이: piece.summary.video.endTimestamp.toFixed(2),
        첫키프레임: piece.summary.video.startsWithKey,
        해독: `${piece.decoded.head}+${piece.decoded.tail}`,
      })))
      const frames = plan.pieces.reduce((sum, piece) => sum + piece.summary.video.packets, 0)
      const duration = plan.pieces.reduce((sum, piece) => sum + piece.summary.video.endTimestamp, 0)
      const audioPackets = plan.pieces.reduce((sum, piece) => sum + (piece.summary.audio?.packets ?? 0), 0)
      checks.push([`${label}: 프레임 수 합이 원본과 같다 (${frames}/${source.video.packets})`, frames === source.video.packets])
      checks.push([`${label}: 길이 합이 원본과 같다(오차 1프레임 이내)`, Math.abs(duration - (source.video.endTimestamp - source.video.firstTimestamp)) <= frameTime])
      checks.push([`${label}: 소리 패킷 수 합이 원본과 같다 (${audioPackets}/${source.audio?.packets ?? 0})`, audioPackets === (source.audio?.packets ?? 0)])
      checks.push([`${label}: 모든 조각의 첫 프레임이 키프레임이고 타임스탬프가 0에서 시작한다`, plan.pieces.every((piece) => piece.summary.video.startsWithKey && Math.abs(piece.summary.video.firstTimestamp) < 1e-6)])
      checks.push([`${label}: 모든 조각이 해독된다(처음·끝 프레임)`, plan.pieces.every((piece) => piece.decoded.head > 0 && piece.decoded.tail > 0)])
      checks.push([`${label}: 해상도·코덱이 원본과 같다(재압축 없음)`, plan.pieces.every((piece) => piece.summary.width === source.width && piece.summary.height === source.height && piece.summary.video.codec === source.video.codec)])
      if (plan.mode.kind === 'size') {
        const largest = Math.max(...plan.pieces.map((piece) => piece.bytes))
        checks.push([`${label}: 모든 조각이 상한 이하 (가장 큰 조각 ${(largest / 1048576).toFixed(1)}MB)`, largest <= maxMb * 1024 * 1024])
        checks.push([`${label}: 2개 이상으로 나뉜다`, plan.pieces.length >= 2])
      }
    }
    if (result.mosaic) {
      console.table(result.mosaic.map((piece) => ({
        파일: piece.name,
        'MB': (piece.bytes / 1048576).toFixed(1),
        프레임: piece.summary.video.packets,
        해독프레임: piece.summary.decodedFrames,
        소리패킷: piece.summary.audio?.packets ?? 0,
        시각불일치: piece.stats.timestampMismatches,
        '경계: 원본 얼굴': piece.sourceFaces.reduce((sum, count) => sum + count, 0),
        '경계: 가림 밖(원본)': piece.sourceUncovered.reduce((sum, count) => sum + count, 0),
        '경계: 결과에서 검출': piece.outputFaces.reduce((sum, count) => sum + count, 0),
        '경계: 가림 밖 노출': piece.outputExposed.reduce((sum, count) => sum + count, 0),
        '가운데: 가림 밖 노출': piece.middleExposed.reduce((sum, count) => sum + count, 0),
      })))
      const frames = result.mosaic.reduce((sum, piece) => sum + piece.summary.video.packets, 0)
      checks.push([`조각별 모자이크: 프레임 수 합이 원본과 같다 (${frames}/${source.video.packets})`, frames === source.video.packets])
      checks.push(['조각별 모자이크: 분석·렌더링 프레임 시각이 모두 일치한다', result.mosaic.every((piece) => piece.stats.timestampMismatches === 0)])
      checks.push(['조각별 모자이크: 모든 조각이 끝까지 해독되고 소리가 있다', result.mosaic.every((piece) => piece.summary.decodedFrames === piece.summary.video.packets && piece.summary.audio)])
      const sourceFaces = result.mosaic.reduce((sum, piece) => sum + piece.sourceFaces.reduce((a, b) => a + b, 0), 0)
      const total = (key) => result.mosaic.reduce((sum, piece) => sum + piece[key].reduce((a, b) => a + b, 0), 0)
      checks.push([`경계 전후 프레임: 원본에는 얼굴이 있다 (${sourceFaces}개)`, sourceFaces > 0])
      checks.push([`경계 전후 프레임: 원본의 얼굴이 모두 가림 계획 안에 있다 (밖 ${total('sourceUncovered')}개)`, total('sourceUncovered') === 0])
      checks.push([`경계 전후 프레임: 결과 영상에서 가림 밖으로 드러난 얼굴 0 (${total('outputExposed')}개)`, total('outputExposed') === 0])
      log(`참고: 결과 영상 경계 프레임에서 검출기가 잡은 것 ${total('outputFaces')}개(모자이크 무늬를 얼굴로 본 것 포함), 조각 가운데 프레임의 가림 밖 노출 ${total('middleExposed')}개`)
    }
    if (result.memory.length > 0) {
      const values = result.memory.map((item) => item.mb)
      const peak = Math.max(...values)
      log(`메모리(MB) 표본 ${values.length}개: 처음 ${values[0]}, 최대 ${peak}, 마지막 ${values[values.length - 1]}`)
      if (!result.mosaic) {
        checks.push([`분할 중 메모리가 원본 크기(${(statSync(videoPath).size / 1048576).toFixed(0)}MB)에 비례해 늘지 않는다 (최대 ${peak}MB)`, peak < Math.max(400, statSync(videoPath).size / 1048576 / 4)])
      }
    }
    for (const [name, ok] of checks) console.log(`${ok ? '  통과' : '  실패'}  ${name}`)
    failed = checks.some(([, ok]) => !ok)
    const reportFile = path.join(reportDir, big ? 'step4-split-big.json' : 'step4-split.json')
    await writeFile(reportFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), video: path.relative(root, videoPath), maxMb, ...result, checks: checks.map(([name, ok]) => ({ name, ok: Boolean(ok) })) }, null, 2)}\n`, 'utf8')
    log(`보고서: ${path.relative(root, reportFile)}`)
  } finally {
    await browser?.close()
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
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
