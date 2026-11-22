// 3단계(사양 점검) 검증: 보통 조건과 저사양 조건에서 판정·안내 화면이 제대로 나오는지 실제 브라우저로 확인한다.
// 사용: npm run e2e:spec
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, devices } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const reportDir = path.join(root, 'reports')
const baseUrl = 'http://127.0.0.1:5173/'
const videoPath = path.join(root, 'tests', 'fixtures', 'videos', 'mvp-10s-720p.mp4')

function log(message) {
  console.log(`[spec] ${message}`)
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

/** 점검이 끝날 때까지 기다린 뒤 화면에 나온 판정과 항목 표를 읽는다. */
async function readSpec(page) {
  await page.getByText('이 컴퓨터에서 처리할 수 있는지 확인하는 중').waitFor({ state: 'detached', timeout: 180000 })
  const heading = await page.locator('section.spec h2').first().innerText()
  const verdict = await page.locator('section.spec .verdict strong').first().innerText()
  // 접힌 표도 읽을 수 있게 펼친다.
  await page.locator('section.spec details').evaluateAll((nodes) => nodes.forEach((node) => (node.open = true)))
  const rows = await page.locator('section.spec details .spec-table tbody tr').evaluateAll((nodes) =>
    nodes.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.innerText.trim())),
  )
  return { heading, verdict, rows }
}

function printRows(rows) {
  console.table(rows.map(([label, value, min, recommended, status]) => ({ 항목: label, '이 컴퓨터': value, 최소: min, 권장: recommended, 판정: status })))
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
  const checks = []
  const report = {}
  try {
    await waitForServer()
    browser = await chromium.launch({ channel: 'chrome', headless: true })

    // ── 1. 보통 조건(이 컴퓨터 그대로) ──
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
      const page = await context.newPage()
      const requests = []
      page.on('request', (request) => requests.push(request.url()))
      const started = Date.now()
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      const spec = await readSpec(page)
      const seconds = (Date.now() - started) / 1000
      log(`보통 조건: ${spec.verdict} (점검 ${seconds.toFixed(1)}초)`)
      printRows(spec.rows)
      report.normal = { ...spec, seconds }
      checks.push(['보통 조건: 판정이 표시된다', ['적합', '주의'].includes(spec.verdict)])
      checks.push(['보통 조건: 점검 항목 8개 이상이 표에 나온다', spec.rows.length >= 8])
      checks.push(['보통 조건: 점검이 30초 안에 끝난다', seconds < 30])
      checks.push(['점검 중 외부로 나간 요청이 없다', requests.every((url) => url.startsWith(baseUrl) || url.startsWith('blob:') || url.startsWith('data:'))])
      await page.screenshot({ path: path.join(reportDir, 'spec-1-normal.png'), fullPage: true })

      // 주의 판정이면 '계속 진행'을 눌러야 다음 단계가 열린다.
      if (spec.verdict === '주의') {
        checks.push(['주의: 진행 전에는 불러오기 화면이 숨겨진다', (await page.getByText('1. 영상 불러오기').count()) === 0])
        await page.getByRole('button', { name: '계속 진행' }).click()
      }
      await page.getByText('1. 영상 불러오기').waitFor({ timeout: 10000 })
      await page.setInputFiles('.dropzone input[type=file]', videoPath)
      await page.getByText('2. 가릴 영역 그리기').waitFor({ timeout: 30000 })
      await page.locator('section.spec details').evaluateAll((nodes) => nodes.forEach((node) => (node.open = true)))
      const timeRow = await page.locator('section.spec .spec-table tbody tr', { hasText: '예상 처리 시간' }).innerText()
      const storageRow = await page.locator('section.spec .spec-table tbody tr', { hasText: '저장 공간' }).innerText()
      log(`영상 불러온 뒤: ${timeRow.replace(/\s+/g, ' ')}`)
      checks.push(['영상을 불러오면 그 영상 기준으로 다시 판정한다', !timeRow.includes('1080p 가정') && storageRow.includes('영상의')])
      await context.close()
    }

    // ── 2. 저사양 조건: 코어 2개·메모리 2GB 로 보이게 한다 ──
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true })
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl.replace(/\/$/, '') })
      await context.addInitScript(() => {
        const override = () => {
          Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 2, configurable: true })
          Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 2, configurable: true })
        }
        override()
      })
      const page = await context.newPage()
      const cdp = await context.newCDPSession(page)
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 })
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      const spec = await readSpec(page)
      log(`저사양 조건(코어 2·메모리 2GB·CPU 6배 느리게): ${spec.verdict} / 제목: ${spec.heading}`)
      printRows(spec.rows)
      report.lowSpec = spec
      checks.push(['저사양: 부적합으로 판정한다', spec.verdict === '부적합'])
      checks.push(['저사양: "다른 컴퓨터에서 작업하세요" 화면이 나온다', spec.heading === '다른 컴퓨터에서 작업하세요'])

      const lacking = await page.locator('section.spec > .table-wrap .spec-table tbody tr').evaluateAll((nodes) => nodes.map((row) => row.querySelector('td')?.innerText.trim()))
      log(`부족한 항목: ${lacking.join(', ')}`)
      checks.push(['저사양: 부족한 항목(CPU·메모리)과 최소·권장 사양을 표로 보여 준다', lacking.includes('CPU') && lacking.includes('메모리')])
      checks.push(['저사양: 진행 전에는 영상 불러오기가 숨겨진다', (await page.getByText('1. 영상 불러오기').count()) === 0])

      const shownUrl = await page.locator('.app-url').innerText()
      checks.push(['QR 코드가 그려진다', (await page.locator('svg.qr path').getAttribute('d'))?.length > 200])
      checks.push(['안내 주소에는 앱 주소만 있다(영상 정보·질의 문자열 없음)', shownUrl === baseUrl])
      await page.getByRole('button', { name: '링크 복사' }).click()
      await page.getByText('주소를 복사했습니다.').waitFor({ timeout: 5000 })
      checks.push(['링크 복사가 된다', (await page.evaluate(() => navigator.clipboard.readText())) === baseUrl])

      const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '프로젝트 파일 내려받기' }).click()])
      const projectPath = path.join(reportDir, 'spec-project.json')
      await download.saveAs(projectPath)
      const project = JSON.parse(await readFile(projectPath, 'utf8'))
      checks.push(['프로젝트 파일을 내려받을 수 있다', project.format === 'mosaic-project' && Array.isArray(project.settings.regions)])
      await page.screenshot({ path: path.join(reportDir, 'spec-2-unfit.png'), fullPage: true })

      // 그래도 진행 → 저사양 모드
      await page.getByRole('button', { name: '그래도 진행 (저사양 모드)' }).click()
      await page.getByText('1. 영상 불러오기').waitFor({ timeout: 10000 })
      await page.setInputFiles('.dropzone input[type=file]', videoPath)
      await page.getByText('3. 얼굴 찾기와 저장').waitFor({ timeout: 60000 })
      const sensitivity = await page.locator('.settings select').first().inputValue()
      checks.push(['그래도 진행하면 저사양 모드(빠른 검출)로 바뀌고 놓칠 수 있다는 경고가 나온다', sensitivity === 'low' && (await page.getByText('돌린 얼굴을 놓칠 수 있으니').first().isVisible())])
      await page.screenshot({ path: path.join(reportDir, 'spec-3-lowspec-mode.png'), fullPage: true })

      // 내려받은 프로젝트 파일을 다시 불러올 수 있는지
      await page.setInputFiles('.file-button input[type=file]', projectPath)
      await page.getByText('프로젝트').filter({ hasText: '적용' }).first().waitFor({ timeout: 10000 })
      checks.push(['프로젝트 파일을 다시 불러올 수 있다', true])
      await context.close()
    }

    // ── 3. 휴대폰으로 열었을 때 ──
    {
      const context = await browser.newContext({ ...devices['Pixel 7'] })
      const page = await context.newPage()
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
      const spec = await readSpec(page)
      const device = spec.rows.find((row) => row[0] === '기기 종류')
      log(`휴대폰 조건: ${spec.verdict} / 기기 종류: ${device?.[1]}`)
      report.mobile = spec
      checks.push(['휴대폰: 부적합으로 판정하고 다른 컴퓨터 안내가 나온다', spec.verdict === '부적합' && spec.heading === '다른 컴퓨터에서 작업하세요' && device?.[4] === '부족'])
      await page.screenshot({ path: path.join(reportDir, 'spec-4-mobile.png'), fullPage: true })
      await context.close()
    }
  } finally {
    await browser?.close()
    if (server.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true })
      else server.kill('SIGTERM')
    }
  }
  for (const [name, ok] of checks) console.log(`${ok ? '  통과' : '  실패'}  ${name}`)
  await writeFile(path.join(reportDir, 'step3-spec.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), ...report, checks: checks.map(([name, ok]) => ({ name, ok: Boolean(ok) })) }, null, 2)}\n`, 'utf8')
  if (checks.length < 17 || checks.some(([, ok]) => !ok)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
