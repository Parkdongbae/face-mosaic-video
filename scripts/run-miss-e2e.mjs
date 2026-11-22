// 얼굴 놓침 점검: 자동 검출이 얼굴을 놓치지 않는지 실제 브라우저에서 확인한다.
//
// 사용: npm run e2e:miss
//         공개 사진으로 만든 시험 영상으로 회귀 점검을 한다.
//         - 작게 찍힌 얼굴이 모여 있는 화면에서 어려운 얼굴(옆얼굴, 고개 숙인 얼굴)까지 가려지는지
//         - 어려운 얼굴(옆얼굴, 고개 숙인 얼굴, 화면 끝에 걸린 얼굴)이 가려지는지
//         - 카메라를 빠르게 돌려도 모자이크가 얼굴을 따라가는지
//         - 장면이 바뀐 뒤 앞 장면의 얼굴 자리를 계속 가리지 않는지
//
//       npm run e2e:miss -- --video=경로.mp4 [--every=3] [--sensitivity=low,normal,high]
//         내 영상에서 '찾는 정도'별로 얼굴이 얼마나 가려지는지 잰다.
//         기준은 아주 느린 정밀 검출(여러 배율로 화면을 나눠 본 것)이 높은 점수로 찾은 얼굴이다.
//         화면 그림은 어디에도 저장·전송하지 않고 숫자만 남긴다(영상은 이 컴퓨터 밖으로 나가지 않는다).
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

function log(message) {
  console.log(`[miss] ${message}`)
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

/** 상자 안에 고르게 찍은 점들 가운데 가림 사각형 안에 든 비율 */
function coverage(box, masks) {
  if (masks.length === 0) return 0
  const steps = 6
  let inside = 0
  for (let iy = 0; iy < steps; iy += 1) {
    for (let ix = 0; ix < steps; ix += 1) {
      const x = box.x + ((ix + 0.5) / steps) * box.width
      const y = box.y + ((iy + 0.5) / steps) * box.height
      if (masks.some((mask) => x >= mask.x && x <= mask.x + mask.width && y >= mask.y && y <= mask.y + mask.height)) inside += 1
    }
  }
  return inside / (steps * steps)
}

const pointCovered = (masks, [x, y]) => masks.some((mask) => x >= mask.x && x <= mask.x + mask.width && y >= mask.y && y <= mask.y + mask.height)

// ── 시험 영상: 빠른 화면 이동 ──
// 공개 사진(CC0) 한 장을 2배로 키우고 그 위에서 화면을 좌우로 빠르게 움직인다. 움직임 번짐(모션 블러)도 넣는다.
// 사진 속 얼굴 위치를 알고 있으므로 프레임마다 정답 위치를 계산할 수 있다.
const PAN_PHOTO = 'Students reading in a classroom.jpg'
/** 사진(1920x1279)에서의 얼굴 상자 → 2배로 키운 좌표. 여러 배율 검출 결과를 눈으로 확인해 정했다. */
const PAN_FACES = [
  { x: 1249, y: 408, width: 154, height: 190 },
  { x: 892, y: 331, width: 184, height: 251 },
  { x: 564, y: 273, width: 138, height: 211 },
].map((box) => ({ x: box.x * 2, y: box.y * 2, width: box.width * 2, height: box.height * 2 }))
const PAN = { cropY: 300, seconds: 6, fps: 30, width: 1920, height: 1080 }
const panCropX = (time, period) => 960 + 900 * Math.sin((2 * Math.PI * time) / period)

function buildPanClip(period) {
  const destination = path.join(videoDir, `miss-pan-${String(period).replace('.', '_')}s.mp4`)
  if (existsSync(destination)) return destination
  const photo = path.join(root, 'tests', 'fixtures', 'photos', 'raw', PAN_PHOTO)
  if (!existsSync(photo)) throw new Error('시험 사진이 없습니다. 먼저 npm run assets 를 실행하세요.')
  log(`시험 영상 생성: ${path.relative(root, destination)}`)
  const result = spawnSync(
    ffmpegPath,
    [
      '-nostdin', '-y', '-framerate', '90', '-loop', '1', '-t', String(PAN.seconds), '-i', photo,
      // 초당 90장으로 만든 뒤 3장씩 평균해 30fps 로 줄인다: 카메라 셔터가 열려 있는 동안 번지는 것과 같다.
      '-vf', `scale=3840:-2,crop=${PAN.width}:${PAN.height}:x='960+900*sin(2*PI*t/${period})':y=${PAN.cropY},tmix=frames=3,fps=${PAN.fps},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '60', '-movflags', '+faststart', destination,
    ],
    { windowsHide: true, encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`ffmpeg 실패: ${result.stderr?.slice(-600)}`)
  return destination
}

/** 빠른 화면 이동 영상에서, 화면 안에 60% 이상 보이는 얼굴이 가려진 비율 */
function panCoverage(run, period) {
  let total = 0
  let covered = 0
  let worst = 1
  let peakSpeed = 0
  for (let frame = 0; frame < run.analysis.frameCount; frame += 1) {
    // 출력 프레임 n 은 앞의 두 부프레임과 평균한 것이므로 중심 시각은 (3n-1)/90 초다.
    const time = Math.max(0, (3 * frame - 1) / 90)
    const cropX = panCropX(time, period)
    peakSpeed = Math.max(peakSpeed, Math.abs(panCropX(time + 1 / PAN.fps, period) - cropX))
    for (const face of PAN_FACES) {
      const left = Math.max(0, face.x - cropX)
      const right = Math.min(PAN.width, face.x - cropX + face.width)
      if (right - left < face.width * 0.6) continue
      const top = Math.max(0, face.y - PAN.cropY)
      const visible = { x: left, y: top, width: right - left, height: Math.min(PAN.height, face.y - PAN.cropY + face.height) - top }
      const value = coverage(visible, run.plan[frame] ?? [])
      total += 1
      worst = Math.min(worst, value)
      if (value >= 0.9) covered += 1
    }
  }
  return { total, covered, ratio: total > 0 ? covered / total : 0, worst, peakSpeed }
}

// ── 시험 영상: 장면 전환과 어려운 얼굴 ──
// npm run e2e 가 만드는 10초짜리 영상(공개 사진 4장이 차례로 바뀐다).
const CUT_VIDEO = path.join(videoDir, 'mvp-10s-720p.mp4')
/** 사진이 바뀌는 간격(프레임). ffmpeg 의 장면 전환 검출(select=gt(scene,0.2))로 확인한 값: 38, 76, 114, … */
const CUT_EVERY_FRAMES = 38
/**
 * 세 번째 사진(프레임 76~113, 여럿이 휴대폰을 내려다보는 장면)에서 얼굴이 있는 자리(1280x720 좌표).
 * 예전 기본 설정에서는 옆얼굴·화면 끝에 걸린 얼굴이 기준 점수(0.4) 근처여서 가려졌다 말았다 했다.
 */
const HARD_FACES = [
  ['맨 왼쪽 학생(고개 숙임)', [135, 150]],
  ['히잡 쓴 학생(옆얼굴)', [310, 245]],
  ['뒤에서 내려다보는 학생', [400, 155]],
  ['교사', [610, 205]],
  ['웃는 학생', [780, 215]],
  ['앞줄 학생', [870, 345]],
  ['키 큰 학생', [973, 110]],
  ['오른쪽 끝에 걸린 사람', [1225, 140]],
]

// ── 시험 영상: 작게 찍힌 얼굴이 모여 있는 화면 ──
// npm run fixtures 가 만드는 6초짜리 영상(공개 사진 4장을 2x2 로 붙인 720p, 얼굴 폭 23~84px).
// 실제 교실 영상처럼 얼굴이 화면에 작게 찍히고, 고개를 숙이거나 돌린 얼굴이 섞여 있다.
const SMALL_VIDEO = path.join(root, 'tests', 'fixtures', 'clips', 'classroom-tiles.mp4')
/** 사진별 얼굴 상자(사진 원본 좌표). 여러 배율 검출 결과를 눈으로 확인해 골랐다. hard: 옆얼굴·고개 숙임·화면 끝에 걸림. */
const SMALL_PHOTOS = {
  reopening: { width: 720, height: 403, faces: [[483, 176, 49, 66], [658, 45, 35, 44], [476, 30, 30, 41], [234, 148, 38, 61], [595, 78, 40, 54], [244, 57, 26, 34], [378, 69, 37, 42], [93, 96, 33, 34], [311, 305, 78, 83]].map((box) => ({ box })) },
  reading: { width: 1920, height: 1279, faces: [[1249, 408, 154, 190], [892, 331, 184, 251], [564, 273, 138, 211]].map((box) => ({ box })) },
  teacher: {
    width: 1920,
    height: 1279,
    faces: [
      { box: [1389, 171, 132, 183] },
      { box: [1094, 327, 144, 191] },
      { box: [854, 322, 126, 172] },
      { box: [1224, 532, 139, 209] },
      { box: [525, 255, 148, 163], hard: true },
      { box: [174, 258, 132, 170], hard: true },
      { box: [1789, 204, 121, 209], hard: true },
      { box: [397, 365, 144, 198], hard: true },
    ],
  },
  asking: { width: 1920, height: 1306, faces: [{ box: [977, 287, 221, 293] }, { box: [44, 447, 91, 113] }] },
  happy: { width: 1920, height: 1322, faces: [{ box: [803, 544, 252, 306] }, { box: [755, 219, 181, 199] }, { box: [1066, 135, 114, 134] }, { box: [898, 106, 99, 132] }] },
}
/** 앞 3초(프레임 0~89)와 뒤 3초(90~179)에 사진이 2x2 로 놓인다(scripts/build-fixtures.mjs 의 DISTANT 순서). */
const SMALL_SEGMENTS = [
  { from: 0, to: 89, tiles: ['reopening', 'reading', 'teacher', 'asking'] },
  { from: 90, to: 179, tiles: ['reading', 'teacher', 'asking', 'happy'] },
]
const SMALL_TILE = { width: 640, height: 360 }

/** 영상 좌표로 옮긴 얼굴 상자. 사진을 칸에 맞춰 자를 때 절반 넘게 잘려 나간 얼굴은 뺀다. */
function smallFaces() {
  const faces = []
  for (const segment of SMALL_SEGMENTS) {
    segment.tiles.forEach((name, index) => {
      const photo = SMALL_PHOTOS[name]
      const scale = Math.max(SMALL_TILE.width / photo.width, SMALL_TILE.height / photo.height)
      const offsetX = (photo.width * scale - SMALL_TILE.width) / 2
      const offsetY = (photo.height * scale - SMALL_TILE.height) / 2
      const originX = (index % 2) * SMALL_TILE.width
      const originY = Math.floor(index / 2) * SMALL_TILE.height
      for (const face of photo.faces) {
        const [x, y, w, h] = face.box
        const left = Math.max(0, x * scale - offsetX)
        const top = Math.max(0, y * scale - offsetY)
        const right = Math.min(SMALL_TILE.width, (x + w) * scale - offsetX)
        const bottom = Math.min(SMALL_TILE.height, (y + h) * scale - offsetY)
        if (right - left < w * scale * 0.5 || bottom - top < h * scale * 0.5) continue
        faces.push({ from: segment.from, to: segment.to, hard: face.hard === true, box: { x: left + originX, y: top + originY, width: right - left, height: bottom - top } })
      }
    })
  }
  return faces
}

/** 얼굴·프레임 가운데 90% 이상 가려진 비율(전체 / 어려운 얼굴). 사진이 바뀌는 곳 앞뒤 5프레임은 뺀다. */
function smallCoverage(run) {
  const totals = { all: [0, 0], hard: [0, 0] }
  for (const face of smallFaces()) {
    for (let frame = face.from + 5; frame <= Math.min(face.to, run.analysis.frameCount - 1) - 5; frame += 1) {
      const ok = coverage(face.box, run.plan[frame] ?? []) >= 0.9
      for (const key of face.hard ? ['all', 'hard'] : ['all']) {
        totals[key][0] += 1
        if (ok) totals[key][1] += 1
      }
    }
  }
  return { all: totals.all[1] / Math.max(1, totals.all[0]), hard: totals.hard[1] / Math.max(1, totals.hard[0]) }
}

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.on('console', (message) => {
    const text = message.text()
    if (text.startsWith('[lab]')) log(text.slice(6))
    else if (message.type() === 'error' && !text.startsWith('INFO:')) log(`페이지 오류: ${text}`)
  })
  page.on('pageerror', (error) => log(`페이지 예외: ${error.message}`))
  await page.goto(`${baseUrl}?e2e`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.id = 'e2e-file'
    document.body.append(input)
  })
  return page
}

/** 앱과 같은 경로로 분석하고 가림 계획을 만든다. */
async function runPipeline(page, sensitivity) {
  return page.evaluate(async (level) => {
    const lab = await import('/src/harness/miss-lab.ts')
    const file = document.querySelector('#e2e-file').files[0]
    return lab.runPipeline(file, lab.defaultSettings(level), (text) => console.log(`[lab] ${text}`))
  }, sensitivity)
}

async function regression(browser) {
  const checks = []
  const report = {}
  const page = await openPage(browser)
  const requests = []
  page.on('request', (request) => requests.push({ url: request.url(), method: request.method() }))

  // 1) 빠른 화면 이동
  for (const { period, minRatio } of [
    { period: 3, minRatio: 0.99 },
    { period: 1.5, minRatio: 0.97 },
  ]) {
    await page.setInputFiles('#e2e-file', buildPanClip(period))
    const run = await runPipeline(page, 'normal')
    const result = panCoverage(run, period)
    report[`pan-${period}s`] = { ...result, sceneCuts: run.analysis.sceneCuts, analyzeSec: run.analysis.elapsedMs / 1000 }
    log(`화면 이동(최고 ${result.peakSpeed.toFixed(0)}px/프레임): 얼굴·프레임 ${result.total}개 중 ${result.covered}개 가림(${(result.ratio * 100).toFixed(1)}%), 가장 덜 가려진 프레임 ${(result.worst * 100).toFixed(0)}%`)
    checks.push([`화면 이동 ${result.peakSpeed.toFixed(0)}px/프레임: 얼굴이 ${(minRatio * 100).toFixed(0)}% 이상의 프레임에서 가려진다`, result.ratio >= minRatio])
    checks.push([`화면 이동 ${result.peakSpeed.toFixed(0)}px/프레임: 장면 전환으로 잘못 보지 않는다`, run.analysis.sceneCuts.length === 0])
  }

  // 2) 작게 찍힌 얼굴이 모여 있는 화면
  // 기준값의 근거(2026-11-22 측정): 수정 전 코드는 보통 전체 89.7%·어려운 얼굴 62.5%, 빠르게 84.6%·50.0% 였고,
  // 수정 뒤에는 보통 94.8%·87.3%, 빠르게 94.1%·83.9% 다. 남는 것은 화면 끝에 반쯤 걸린 얼굴과 위가 잘린 얼굴이다.
  // (타일 검출을 더 자주 하면 조금 더 오른다: 보통을 4프레임마다 하면 94.9%·87.5%, 빠르게를 8프레임마다 하면 94.7%·86.7%.)
  if (!existsSync(SMALL_VIDEO)) throw new Error('시험 영상이 없습니다. 먼저 npm run fixtures 를 실행하세요.')
  await page.setInputFiles('#e2e-file', SMALL_VIDEO)
  for (const level of ['low', 'normal']) {
    const small = smallCoverage(await runPipeline(page, level))
    report[`small-${level}`] = small
    log(`작은 얼굴 화면 · ${level}: 전체 ${(small.all * 100).toFixed(1)}%, 어려운 얼굴 ${(small.hard * 100).toFixed(1)}%`)
    checks.push([`작은 얼굴 화면 · ${level === 'low' ? '빠르게' : '보통'}: 얼굴이 92% 이상의 프레임에서 가려진다`, small.all >= 0.92])
    checks.push([`작은 얼굴 화면 · ${level === 'low' ? '빠르게' : '보통'}: 옆얼굴·고개 숙인 얼굴도 80% 이상의 프레임에서 가려진다`, small.hard >= 0.8])
  }

  // 3) 장면 전환 + 어려운 얼굴
  if (!existsSync(CUT_VIDEO)) throw new Error('시험 영상이 없습니다. 먼저 npm run e2e 를 한 번 실행하세요.')
  await page.setInputFiles('#e2e-file', CUT_VIDEO)
  const run = await runPipeline(page, 'normal')
  const { analysis, plan } = run
  const expectedCuts = []
  for (let cut = CUT_EVERY_FRAMES; cut < analysis.frameCount - 1; cut += CUT_EVERY_FRAMES) expectedCuts.push(cut)
  const cutsMatch =
    analysis.sceneCuts.length === expectedCuts.length && analysis.sceneCuts.every((cut, index) => Math.abs(cut - expectedCuts[index]) <= 2)
  log(`장면 전환: 찾은 곳 ${JSON.stringify(analysis.sceneCuts)} (실제 ${expectedCuts.join(', ')})`)
  checks.push([`사진이 바뀌는 곳 ${expectedCuts.length}군데를 모두 장면 전환으로 찾는다`, cutsMatch])

  const missed = []
  for (const frame of [86, 96, 104, 110]) {
    for (const [name, point] of HARD_FACES) if (!pointCovered(plan[frame] ?? [], point)) missed.push(`${name}@${frame}`)
  }
  log(`어려운 얼굴 ${HARD_FACES.length}개 × 4프레임: 놓친 곳 ${missed.length === 0 ? '없음' : missed.join(', ')}`)
  checks.push(['옆얼굴·고개 숙인 얼굴·화면 끝에 걸린 얼굴까지 모두 가려진다', missed.length === 0])

  // 장면이 바뀌고 20프레임 뒤에 남아 있는 가림은 모두 새 장면에서 (다시) 잡힌 얼굴의 것이어야 한다.
  const pointsOf = new Map(analysis.tracks.map((track) => [track.id, track.points]))
  let stale = 0
  for (const cut of analysis.sceneCuts) {
    const frame = cut + 20
    for (const mask of plan[frame] ?? []) {
      const points = pointsOf.get(mask.trackId) ?? []
      if (!points.some((point) => point.frame >= cut && point.frame <= frame + 15)) stale += 1
    }
  }
  checks.push(['장면이 바뀐 뒤에는 앞 장면의 얼굴 자리를 계속 가리지 않는다', stale === 0])

  const area = (plan[100] ?? []).reduce((sum, mask) => sum + mask.width * mask.height, 0) / (analysis.width * analysis.height)
  log(`사람 9명이 화면을 채운 장면에서 가림 면적: 화면의 ${(area * 100).toFixed(1)}%`)
  checks.push(['가림이 화면을 과하게 덮지 않는다(얼굴 9개 장면에서 화면의 35% 이하)', area <= 0.35])

  const external = requests.filter((request) => !request.url.startsWith(baseUrl) && !request.url.startsWith('blob:') && !request.url.startsWith('data:'))
  checks.push(['같은 도메인 밖으로 나간 요청이 없다', external.length === 0])
  checks.push(['처리 중 전송(POST 등) 요청이 없다', requests.every((request) => request.method === 'GET')])

  report.cuts = { found: analysis.sceneCuts, expected: expectedCuts, missedHardFaces: missed, staleMasks: stale, maskAreaAtFrame100: area }
  return { checks, report }
}

/** 내 영상에서 감도별 가림률을 잰다. 숫자만 남긴다. */
async function measure(browser, videoPath) {
  const every = Math.max(1, Number(option('every') ?? 3))
  const levels = (option('sensitivity') ?? 'low,normal,high').split(',').filter(Boolean)
  const page = await openPage(browser)
  await page.setInputFiles('#e2e-file', videoPath)

  const probe = await page.evaluate(async () => {
    const lab = await import('/src/harness/miss-lab.ts')
    return lab.probeSource(document.querySelector('#e2e-file').files[0], 3)
  })
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
  log(`영상: ${probe.width}x${probe.height}, 코덱 ${probe.codecString ?? probe.codec}, ${probe.hdr ? 'HDR' : '일반 밝기 범위'}, 해독 ${probe.canDecode ? '가능' : '불가'}`)
  if (probe.frames.length > 0) {
    log(`분석 단계가 보는 화면의 밝기: 평균 ${mean(probe.frames.map((item) => item.mean)).toFixed(0)}/255, 대비(표준편차) ${mean(probe.frames.map((item) => item.std)).toFixed(0)}`)
  }
  if (!probe.canDecode) throw new Error('이 브라우저에서 바로 해독할 수 없는 영상입니다. 앱에서 한 번 열어 변환한 뒤 그 파일로 재 보세요.')

  log(`기준 정밀 검출 시작(${every}프레임마다, 매우 느립니다)`)
  const reference = await page.evaluate(async (step) => {
    const lab = await import('/src/harness/miss-lab.ts')
    const file = document.querySelector('#e2e-file').files[0]
    return lab.exhaustiveDetect(file, { scoreThreshold: 0.2, grids: [[3, 2], [5, 3]], overlap: 0.25, every: step }, (text) => console.log(`[lab] ${text}`))
  }, every)
  const fps = (reference.timestampsUs.length - 1) / Math.max(1e-6, (reference.timestampsUs.at(-1) - reference.timestampsUs[0]) / 1e6)

  const bands = [
    { label: '확실한 얼굴(0.8점 이상)', min: 0.8, max: 2 },
    { label: '0.6~0.8점', min: 0.6, max: 0.8 },
    { label: '0.4~0.6점', min: 0.4, max: 0.6 },
  ]
  const rows = []
  for (const level of levels) {
    log(`'찾는 정도' ${level} 분석 시작`)
    const run = await runPipeline(page, level)
    const row = { '찾는 정도': level }
    for (const band of bands) {
      let total = 0
      let covered = 0
      for (const { frame, boxes } of reference.frames) {
        for (const box of boxes) {
          if (box.score < band.min || box.score >= band.max) continue
          total += 1
          if (coverage(box, run.plan[frame] ?? []) >= 0.75) covered += 1
        }
      }
      row[`${band.label} (${total}건)`] = total > 0 ? `${((covered / total) * 100).toFixed(1)}%` : '-'
    }
    let area = 0
    for (const boxes of run.plan) for (const box of boxes) area += box.width * box.height
    row['가림 면적'] = `${((area / (run.analysis.width * run.analysis.height * run.plan.length)) * 100).toFixed(1)}%`
    row['얼굴로 본 추적'] = run.analysis.tracks.length - run.rejected.length
    row['분석 시간'] = `${(run.analysis.elapsedMs / 1000).toFixed(0)}초 (영상 길이의 ${(run.analysis.elapsedMs / 1000 / (run.analysis.frameCount / fps)).toFixed(1)}배)`
    rows.push(row)
  }
  console.table(rows)
  log('표의 %는 "정밀 검출이 그 점수로 찾은 얼굴 가운데 가림 계획이 덮은 비율"입니다. 정밀 검출도 놓치는 얼굴이 있을 수 있으니, 결과 영상은 꼭 직접 확인하세요.')
  return { checks: [], report: { video: path.basename(videoPath), every, fps, probe: { ...probe, frames: probe.frames.length }, rows } }
}

async function main() {
  await mkdir(videoDir, { recursive: true })
  await mkdir(reportDir, { recursive: true })
  const videoPath = option('video') ? path.resolve(option('video')) : null
  if (videoPath && !existsSync(videoPath)) throw new Error(`영상 파일이 없습니다: ${videoPath}`)

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
    const { checks, report } = videoPath ? await measure(browser, videoPath) : await regression(browser)
    for (const [name, ok] of checks) console.log(`${ok ? '  통과' : '  실패'}  ${name}`)
    failed = checks.some(([, ok]) => !ok)
    const reportFile = path.join(reportDir, videoPath ? `miss-${path.basename(videoPath).replace(/[^A-Za-z0-9._-]/g, '_')}.json` : 'step7-miss.json')
    await writeFile(reportFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report, checks: checks.map(([name, ok]) => ({ name, ok: Boolean(ok) })) }, null, 2)}\n`, 'utf8')
    log(`보고서: ${path.relative(root, reportFile)}`)
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
