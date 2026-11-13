// 6단계(마무리) 검증: 배포본을 배포 설정(vercel.json)과 같은 헤더로 띄운 뒤,
// 인터넷을 끊은 상태에서 앱이 열리고 불러오기 → 얼굴 찾기 → 저장 → 형식 변환까지 되는지,
// 그동안 밖으로 나가는 요청이 없는지 확인한다.
// 사용: npm run e2e:pwa   (먼저 배포본을 새로 만든다)
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const reportDir = path.join(root, 'reports')
const baseUrl = 'http://127.0.0.1:4173/'
const videoPath = path.join(root, 'tests', 'fixtures', 'videos', 'mvp-10s-720p.mp4')
const aviPath = path.join(root, 'tests', 'fixtures', 'videos', 'fmt-avi.avi')
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')

function log(message) {
  console.log(`[pwa] ${message}`)
}

async function waitForServer(timeoutMs = 60000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      if ((await fetch(baseUrl, { cache: 'no-store' })).ok) return
    } catch {
      // 아직 준비되지 않음
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('미리보기 서버가 제한 시간 안에 응답하지 않았습니다')
}

async function main() {
  if (!existsSync(videoPath) || !existsSync(aviPath)) throw new Error('시험 영상이 없습니다. 먼저 npm run e2e 를 한 번 실행하세요.')
  await mkdir(reportDir, { recursive: true })

  log('배포본 만들기')
  const build = spawnSync(process.execPath, [vite, 'build'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (build.status !== 0) throw new Error(`빌드 실패: ${build.stderr?.slice(-800)}`)
  const precache = JSON.parse((await readFile(path.join(root, 'dist', 'precache-manifest.js'), 'utf8')).replace('self.__PRECACHE = ', ''))
  const vercel = JSON.parse(await readFile(path.join(root, 'vercel.json'), 'utf8'))
  const deployHeaders = Object.fromEntries(vercel.headers.find((rule) => rule.source === '/(.*)').headers.map((header) => [header.key.toLowerCase(), header.value]))

  const server = spawn(process.execPath, [vite, 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], { cwd: root, stdio: 'ignore', windowsHide: true })
  let browser
  const checks = []
  const report = {}
  try {
    await waitForServer()
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
    await context.addInitScript(() => {
      window.__violations = []
      document.addEventListener('securitypolicyviolation', (event) => window.__violations.push(`${event.violatedDirective}: ${event.blockedURI}`))
      window.showSaveFilePicker = async (options) => {
        const directory = await navigator.storage.getDirectory()
        return directory.getFileHandle(options?.suggestedName ?? 'out.mp4', { create: true })
      }
    })
    const page = await context.newPage()
    const problems = []
    page.on('pageerror', (error) => problems.push(error.message))
    page.on('console', (message) => {
      const text = message.text()
      if (message.type() === 'error' && !text.startsWith('INFO:')) problems.push(text)
    })
    const requests = []
    const failures = []
    page.on('request', (request) => requests.push({ url: request.url(), method: request.method(), type: request.resourceType(), fromSw: false }))
    page.on('requestfailed', (request) => failures.push(`${request.url()} ${request.failure()?.errorText}`))
    context.on('serviceworker', (worker) => {
      worker.on('console', (message) => {
        if (message.type() === 'error') problems.push(`sw: ${message.text()}`)
      })
    })

    // ── 1. 온라인 첫 방문: 헤더·매니페스트·오프라인 저장 ──
    const response = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    const headers = response.headers()
    for (const [key, value] of Object.entries(deployHeaders)) {
      checks.push([`응답 헤더 ${key} 가 배포 설정과 같다`, headers[key] === value])
    }
    const started = Date.now()
    await page.evaluate(() => navigator.serviceWorker.ready)
    const installSec = (Date.now() - started) / 1000
    const cached = await page.evaluate(async () => {
      const names = await caches.keys()
      const cache = await caches.open(names.find((name) => name.startsWith('mosaic-')))
      return (await cache.keys()).map((request) => new URL(request.url).pathname)
    })
    log(`오프라인용 파일 ${cached.length}/${precache.files.length}개 저장 (${installSec.toFixed(1)}초)`)
    checks.push(['서비스 워커가 설치되고 모든 앱 파일을 저장한다', precache.files.every((file) => cached.includes(file))])
    const manifest = await page.evaluate(async () => {
      const link = document.querySelector('link[rel=manifest]')
      const data = await (await fetch(link.href)).json()
      const icons = await Promise.all(data.icons.map(async (icon) => (await fetch(icon.src)).ok))
      return { name: data.name, display: data.display, start: data.start_url, icons }
    })
    checks.push(['웹 앱 매니페스트와 아이콘이 있다(설치 가능)', manifest.name === '얼굴 모자이크' && manifest.display === 'standalone' && manifest.icons.length === 3 && manifest.icons.every(Boolean)])
    await page.getByText('오프라인 준비 완료').waitFor({ timeout: 30000 })
    checks.push(['사용 안내 화면이 보이고 오프라인 준비 상태를 알려 준다', (await page.getByText('영상은 밖으로 나가지 않습니다.').isVisible()) && (await page.locator('.guide-steps > li').count()) === 6 && (await page.locator('.faq > details').count()) >= 5])
    await page.screenshot({ path: path.join(reportDir, 'pwa-1-guide.png'), fullPage: true })

    // ── 2. 인터넷을 끊고 다시 연다 ──
    await context.setOffline(true)
    const offlineFrom = requests.length
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('영상은 이 컴퓨터에서만 처리됩니다').waitFor({ timeout: 30000 })
    checks.push(['오프라인에서 앱이 열린다', true])
    checks.push(['오프라인에서도 교차 출처 격리가 유지된다(저장된 응답의 헤더)', await page.evaluate(() => self.crossOriginIsolated)])
    // 인터넷이 정말 끊겼는지: 캐시에 없는 주소는 받아올 수 없어야 한다.
    const problemsBeforeProbe = problems.length
    const reallyOffline = await page.evaluate(() => fetch(`/not-cached-${Date.now()}`).then(() => false, () => true))
    await page.waitForTimeout(300)
    // 위 확인용 요청이 실패하면서 콘솔에 남긴 오류 한 줄은 화면 오류로 치지 않는다.
    problems.splice(problemsBeforeProbe)
    checks.push(['(확인) 인터넷이 실제로 끊긴 상태다', reallyOffline])

    await page.getByText('이 컴퓨터에서 처리할 수 있는지 확인하는 중').waitFor({ state: 'detached', timeout: 180000 })
    const verdict = await page.locator('section.spec .verdict strong').first().innerText()
    checks.push([`오프라인에서 사양 점검(검출 벤치마크 포함)이 끝난다: ${verdict}`, ['적합', '주의'].includes(verdict)])
    for (const name of ['계속 진행', '그래도 진행 (저사양 모드)']) {
      const button = page.getByRole('button', { name })
      if (await button.count()) await button.click()
    }
    await page.setInputFiles('.dropzone input[type=file]', videoPath)
    await page.getByText('2. 가릴 영역 그리기').waitFor({ timeout: 30000 })
    // 얼굴 찾기는 영상을 열면 자동으로 시작된다.
    await page.locator('.result').first().waitFor({ timeout: 300000 })
    const summary = await page.locator('.result').first().innerText()
    checks.push(['오프라인에서 얼굴 찾기가 된다', /얼굴 \d+개를 찾았습니다/.test(summary) && !summary.startsWith('얼굴 0개')])
    await page.getByRole('button', { name: '모자이크 영상 저장' }).click()
    await page.getByText('저장을 마쳤습니다').waitFor({ timeout: 300000 })
    const savedSize = await page.evaluate(async () => {
      const directory = await navigator.storage.getDirectory()
      return (await (await directory.getFileHandle('mvp-10s-720p_mosaic.mp4')).getFile()).size
    })
    checks.push(['오프라인에서 모자이크 영상이 저장된다', savedSize > 100000])
    await page.screenshot({ path: path.join(reportDir, 'pwa-2-offline-saved.png'), fullPage: true })

    await page.setInputFiles('.dropzone input[type=file]', aviPath)
    await page.getByText('처리할 수 있는 형식으로 변환했습니다').waitFor({ timeout: 180000 })
    checks.push(['오프라인에서 형식 변환(ffmpeg.wasm)이 된다', true])

    // ── 3. 요청 점검 ──
    const during = requests.slice(offlineFrom)
    const external = during.filter((request) => !request.url.startsWith(baseUrl) && !request.url.startsWith('blob:') && !request.url.startsWith('data:'))
    const sending = during.filter((request) => request.method !== 'GET')
    // 영상 관련 요청: 영상·소리 자원을 서버(http)에서 가져오거나 서버로 보내는 요청. 미리보기는 이 컴퓨터 안의 blob: 주소만 쓴다.
    const mediaOverNetwork = during.filter((request) => request.type === 'media' && !request.url.startsWith('blob:'))
    const violations = await page.evaluate(() => window.__violations)
    log(`오프라인 구간 요청 ${during.length}건: 같은 도메인 ${during.filter((request) => request.url.startsWith(baseUrl)).length}, blob/data ${during.filter((request) => /^(blob|data):/.test(request.url)).length}, 외부 ${external.length}, 전송 ${sending.length}`)
    // 일부러 실패시킨 확인용 요청(/not-cached-…)과, 영상을 바꿀 때 중단된 이 컴퓨터 안의 미리보기(blob:)는 뺀다.
    const realFailures = failures.filter((item) => !item.includes('/not-cached-') && !item.startsWith('blob:'))
    checks.push([`오프라인 구간에서 앱 파일 요청이 실패하지 않는다(필요한 파일이 모두 저장돼 있다)${realFailures.length ? `: ${realFailures.slice(0, 3).join(' | ')}` : ''}`, realFailures.length === 0])
    checks.push(['같은 도메인 밖으로 나간 요청 0건', external.length === 0])
    checks.push(['서버로 보내는 요청(POST 등) 0건', sending.length === 0])
    checks.push(['영상 관련 네트워크 요청 0건', mediaOverNetwork.length === 0])
    checks.push([`보안 정책(CSP) 위반 0건${violations.length ? `: ${violations.slice(0, 3).join(' | ')}` : ''}`, violations.length === 0])
    checks.push([`화면 오류 없음${problems.length ? `: ${problems.slice(0, 3).join(' | ')}` : ''}`, problems.length === 0])
    if (realFailures.length) log(`실패한 요청: ${realFailures.slice(0, 5).join(' | ')}`)
    Object.assign(report, { installSec, cached: cached.length, precache: precache.files.length, manifest, verdict, requests: during.length, external, sending, failures, violations, problems })
  } finally {
    await browser?.close()
    if (server.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true })
      else server.kill('SIGTERM')
    }
  }
  for (const [name, ok] of checks) console.log(`${ok ? '  통과' : '  실패'}  ${name}`)
  await writeFile(path.join(reportDir, 'step6-pwa.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report, checks: checks.map(([name, ok]) => ({ name, ok: Boolean(ok) })) }, null, 2)}\n`, 'utf8')
  if (checks.length < 20 || checks.some(([, ok]) => !ok)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
