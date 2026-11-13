// 화면 흐름 검증(glm.md 7장 E2E): 파일 불러오기 → 영역 그리기 → 얼굴 찾기 → 저장.
// 저장 대화상자는 자동화할 수 없어 브라우저 내부 저장소(OPFS) 파일로 바꿔 끼운다. 그 밖은 실제 화면을 그대로 누른다.
// 사용: npm run e2e:ui
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const reportDir = path.join(root, 'reports')
const baseUrl = 'http://127.0.0.1:5173/'
const videoPath = path.join(root, 'tests', 'fixtures', 'videos', 'mvp-10s-720p.mp4')

function log(message) {
  console.log(`[ui] ${message}`)
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
  const checks = []
  try {
    await waitForServer()
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
    const problems = []
    page.on('pageerror', (error) => problems.push(error.message))
    page.on('console', (message) => {
      const text = message.text()
      if (message.type() === 'error' && !text.startsWith('INFO:') && !text.includes('404')) problems.push(text)
    })
    await page.addInitScript(() => {
      window.showSaveFilePicker = async (options) => {
        window.__savedName = options?.suggestedName
        const directory = await navigator.storage.getDirectory()
        return directory.getFileHandle(options?.suggestedName ?? 'out.mp4', { create: true })
      }
      // 폴더 선택도 내부 저장소의 폴더로 바꿔 끼운다(분할 조각 저장용).
      window.showDirectoryPicker = async () => {
        const directory = await navigator.storage.getDirectory()
        return directory.getDirectoryHandle('pieces', { create: true })
      }
    })

    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.getByText('영상은 이 컴퓨터에서만 처리됩니다').waitFor()
    // 사양 점검이 끝나길 기다린다. 주의·부적합이면 알고 진행하는 버튼을 눌러야 다음 단계가 열린다.
    await page.getByText('이 컴퓨터에서 처리할 수 있는지 확인하는 중').waitFor({ state: 'detached', timeout: 180000 })
    for (const name of ['계속 진행', '그래도 진행 (저사양 모드)']) {
      const button = page.getByRole('button', { name })
      if (await button.count()) await button.click()
    }
    await page.getByText('1. 영상 불러오기').waitFor({ timeout: 10000 })
    await page.setInputFiles('.dropzone input[type=file]', videoPath)
    await page.getByText('2. 가릴 영역 그리기').waitFor({ timeout: 30000 })
    checks.push(['파일 정보가 표시된다', (await page.locator('.facts').innerText()).includes('1280 × 720')])
    // 영상을 열면 누르지 않아도 얼굴 찾기가 시작된다.
    await page.getByText('얼굴을 찾는 중').waitFor({ timeout: 30000 })
    checks.push(['영상을 열면 얼굴 찾기가 자동으로 시작되고 진행률과 취소 버튼이 보인다', await page.getByRole('button', { name: '취소' }).isVisible()])
    await page.screenshot({ path: path.join(reportDir, 'ui-1-analyzing.png') })

    // 화면 왼쪽 절반에 영역을 그린다.
    const overlay = page.locator('.stage-overlay')
    await page.waitForFunction(() => document.querySelector('.stage video')?.readyState >= 2, null, { timeout: 30000 })
    // 미리보기 전체가 화면 안에 들어오게 한 뒤 마우스로 조작한다(화면 밖 좌표로는 마우스 입력이 전달되지 않는다).
    await overlay.evaluate((node) => node.scrollIntoView({ block: 'center' }))
    const box = await overlay.boundingBox()
    await page.mouse.move(box.x + box.width * 0.02, box.y + box.height * 0.05)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.95, { steps: 8 })
    await page.mouse.up()
    checks.push(['그린 영역이 목록에 생긴다', await page.getByText('영역 1').isVisible()])

    await page.locator('.result').first().waitFor({ timeout: 300000 })
    const summary = await page.locator('.result').first().innerText()
    log(summary)
    checks.push(['얼굴 찾기 결과가 표시된다', /얼굴 \d+개를 찾았습니다/.test(summary)])
    checks.push(['영역 밖 얼굴은 제외했다고 알린다', summary.includes('영역 밖 얼굴은 가리지 않습니다')])

    // 미리보기 위치를 옮겨 모자이크가 그려진 화면을 남긴다.
    await page.locator('.transport input[type=range]').fill('5')
    await page.waitForTimeout(800)
    await page.screenshot({ path: path.join(reportDir, 'ui-2-preview.png') })

    // ── 검토·수정 도구 ──
    await overlay.evaluate((node) => node.scrollIntoView({ block: 'center' }))
    const stage = await overlay.boundingBox()
    const at = (rx, ry) => [stage.x + stage.width * rx, stage.y + stage.height * ry]
    const frameLabel = async () => Number(/(\d+)\/\d+프레임/.exec(await page.locator('.transport .muted').innerText())?.[1])

    // 프레임 이동
    const frameBefore = await frameLabel()
    await page.getByRole('button', { name: '한 프레임 앞으로' }).click()
    await page.waitForTimeout(300)
    const frameAfter = await frameLabel()
    await page.getByRole('button', { name: '한 프레임 뒤로' }).click()
    await page.waitForTimeout(300)
    checks.push([`프레임 단위로 앞뒤 이동이 된다 (${frameBefore} → ${frameAfter} → ${await frameLabel()})`, frameAfter === frameBefore + 1 && (await frameLabel()) === frameBefore])

    // 모자이크 시작 지점으로 건너뛰기: 처음으로 돌아가 '다음 모자이크'를 누르면 프레임이 뒤로 건너뛰고, '이전'을 누르면 돌아온다.
    const frameNow = async () => Number((await page.locator('.transport').innerText()).match(/(\d+)\/\d+프레임/)?.[1] ?? -1)
    await page.locator('.transport input[type=range]').fill('0')
    await page.waitForTimeout(400)
    const jumpFrom = await frameNow()
    await page.getByRole('button', { name: '다음 모자이크 시작 지점' }).click()
    await page.waitForTimeout(400)
    const jumpFirst = await frameNow()
    await page.getByRole('button', { name: '다음 모자이크 시작 지점' }).click()
    await page.waitForTimeout(400)
    const jumpSecond = await frameNow()
    await page.getByRole('button', { name: '이전 모자이크 시작 지점' }).click()
    await page.waitForTimeout(400)
    const jumpBack = await frameNow()
    checks.push([
      `모자이크 시작 지점으로 건너뛴다 (${jumpFrom} → ${jumpFirst} → ${jumpSecond} → ${jumpBack})`,
      jumpFirst > jumpFrom + 1 && jumpSecond > jumpFirst + 1 && jumpBack === jumpFirst,
    ])
    await page.locator('.transport input[type=range]').fill('5')
    await page.waitForTimeout(600)

    // 얼굴 추가: 영역 밖(오른쪽)에 있어 가려지지 않은 사람의 얼굴을 한 프레임에서 표시한다.
    await page.getByRole('button', { name: '얼굴 추가' }).click()
    await page.mouse.move(...at(0.63, 0.06))
    await page.mouse.down()
    await page.mouse.move(...at(0.75, 0.32), { steps: 6 })
    await page.mouse.up()
    await page.getByText('얼굴을 추가했습니다').waitFor({ timeout: 120000 })
    const addNotice = await page.getByText('얼굴을 추가했습니다').innerText()
    log(addNotice)
    const filled = Number(/포함해 (\d+)프레임/.exec(addNotice)?.[1])
    checks.push([`얼굴 추가: 한 프레임에서 표시하면 앞뒤가 자동으로 채워진다 (${filled}프레임)`, filled >= 10])
    checks.push(['얼굴 추가: 추가한 개수가 표시된다', await page.getByText('직접 추가한 얼굴 1개').isVisible()])
    await page.locator('.actions select').last().selectOption('boxes')
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(reportDir, 'ui-2b-face-added.png') })
    await page.locator('.actions select').last().selectOption('mosaic')

    // 가림 삭제: 방금 추가한 얼굴 자리를 눌러 지우고, 다시 추가 상태로 되돌리지는 않는다(직접 추가한 것은 바로 삭제).
    await page.getByRole('button', { name: '가림 삭제' }).click()
    await page.mouse.click(...at(0.69, 0.19))
    await page.getByText('직접 추가한 얼굴을 지웠습니다.').waitFor({ timeout: 10000 })
    checks.push(['가림 삭제: 눌러서 지우면 목록에서 빠진다', (await page.getByText('직접 추가한 얼굴 1개').count()) === 0])
    // 자동으로 잡힌 가림(왼쪽 영역 안)도 지웠다가 되돌린다.
    await page.mouse.click(...at(0.42, 0.3))
    const removedChip = page.getByText(/지운 가림 \d+개/)
    const removedOk = await removedChip.waitFor({ timeout: 10000 }).then(() => true, () => false)
    if (removedOk) await page.getByRole('button', { name: '삭제 되돌리기' }).click()
    checks.push(['가림 삭제: 자동으로 잡힌 가림을 지우고 되돌릴 수 있다', removedOk && (await removedChip.count()) === 0])

    // 다각형 + 제외 영역 + 구간
    await page.getByRole('button', { name: '다각형 영역' }).click()
    await page.getByLabel('제외 영역으로 그리기').check()
    for (const [rx, ry] of [[0.6, 0.55], [0.9, 0.55], [0.9, 0.9], [0.6, 0.9]]) await page.mouse.click(...at(rx, ry))
    await page.getByRole('button', { name: /다각형 완성/ }).click()
    const row = page.locator('.region-row').nth(1)
    await row.waitFor({ timeout: 10000 })
    const rowText = await row.innerText()
    checks.push(['다각형 영역을 그릴 수 있고 제외 영역으로 들어간다', rowText.includes('다각형 4점') && (await row.getByLabel('제외').isChecked())])
    await row.getByRole('button', { name: '지금부터' }).click()
    await row.getByLabel('끝(초)').fill('8')
    checks.push(['영역별로 적용 구간(시작·끝)을 정할 수 있다', (await row.getByLabel('시작(초)').inputValue()) === '5' && (await row.getByLabel('끝(초)').inputValue()) === '8'])
    checks.push(['영역을 바꿔도 얼굴을 다시 찾지 않아도 된다(결과가 그대로 있다)', await page.locator('.result').first().isVisible()])

    // 영역 옮기기: 다각형을 왼쪽으로 끈다.
    const beforeMove = await page.evaluate(() => null)
    await page.getByRole('button', { name: '영역 옮기기' }).click()
    await page.mouse.move(...at(0.75, 0.7))
    await page.mouse.down()
    await page.mouse.move(...at(0.65, 0.6), { steps: 6 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    await page.screenshot({ path: path.join(reportDir, 'ui-2c-regions.png') })
    checks.push(['영역 옮기기 도구가 오류 없이 동작한다', beforeMove === null && problems.length === 0])

    // 뒤 단계 확인을 위해 방금 만든 제외 영역은 지우고 사각형 도구로 돌아간다.
    await row.getByRole('button', { name: '영역 2 삭제' }).click()
    await page.getByRole('button', { name: '사각형 영역' }).click()
    await page.getByLabel('제외 영역으로 그리기').uncheck()

    await page.getByRole('button', { name: '모자이크 영상 저장' }).click()
    await page.getByText('저장을 마쳤습니다').waitFor({ timeout: 300000 })
    const done = await page.locator('.result').last().innerText()
    log(done)
    const savedName = await page.evaluate(() => window.__savedName)
    checks.push(['기본 파일명이 원본이름_mosaic.mp4 다', savedName === 'mvp-10s-720p_mosaic.mp4'])
    const savedSize = await page.evaluate(async (name) => {
      const directory = await navigator.storage.getDirectory()
      return (await (await directory.getFileHandle(name)).getFile()).size
    }, savedName)
    checks.push(['결과 파일이 실제로 써졌다', savedSize > 100000])
    await page.screenshot({ path: path.join(reportDir, 'ui-3-saved.png'), fullPage: true })

    // ── 영상 분할: 2개로 나누기 → 미리보기 표 → 분할만 저장 → 조각별 모자이크 저장 ──
    await page.locator('.split select').selectOption('count')
    await page.locator('.split input[type=number]').fill('2')
    await page.getByRole('button', { name: '나누기 미리보기' }).click()
    await page.locator('.split .spec-table tbody tr').first().waitFor({ timeout: 30000 })
    checks.push(['나누기 미리보기 표에 조각 2개가 나온다', (await page.locator('.split .spec-table tbody tr').count()) === 2])
    await page.screenshot({ path: path.join(reportDir, 'ui-4-split-preview.png'), fullPage: true })

    const listPieces = () =>
      page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        const directory = await root.getDirectoryHandle('pieces', { create: true })
        const files = []
        for await (const [name, handle] of directory.entries()) files.push({ name, size: (await handle.getFile()).size })
        return files.sort((a, b) => a.name.localeCompare(b.name))
      })

    await page.getByRole('button', { name: '분할만 저장 (모자이크 없이)' }).click()
    await page.getByText('나눠 저장했습니다(모자이크 없음)').waitFor({ timeout: 60000 })
    const rawPieces = await listPieces()
    log(`분할만 저장: ${rawPieces.map((item) => `${item.name}(${(item.size / 1024).toFixed(0)}KB)`).join(', ')}`)
    checks.push([
      '분할만 저장: 원본이름_part01.mp4, _part02.mp4 가 써진다',
      rawPieces.length === 2 && rawPieces[0].name === 'mvp-10s-720p_part01.mp4' && rawPieces[1].name === 'mvp-10s-720p_part02.mp4' && rawPieces.every((item) => item.size > 100000),
    ])

    await page.getByRole('button', { name: '조각 2개로 모자이크 영상 저장' }).click()
    await page.getByText('조각 2개 저장을 마쳤습니다').waitFor({ timeout: 300000 })
    const allPieces = await listPieces()
    const mosaicPieces = allPieces.filter((item) => item.name.includes('_mosaic'))
    log(`조각별 저장: ${mosaicPieces.map((item) => `${item.name}(${(item.size / 1024).toFixed(0)}KB)`).join(', ')}`)
    checks.push([
      '조각별 모자이크 저장: 원본이름_part01_mosaic.mp4, _part02_mosaic.mp4 가 써진다',
      mosaicPieces.length === 2 && mosaicPieces[0].name === 'mvp-10s-720p_part01_mosaic.mp4' && mosaicPieces[1].name === 'mvp-10s-720p_part02_mosaic.mp4' && mosaicPieces.every((item) => item.size > 100000),
    ])
    checks.push(['조각 상태가 모두 완료로 바뀐다', (await page.locator('.split .status.good').count()) === 2])
    await page.screenshot({ path: path.join(reportDir, 'ui-5-split-saved.png'), fullPage: true })
    // 다음 확인을 위해 분할을 끈다.
    await page.locator('.split select').selectOption('none')

    // 취소: 다시 찾기를 시작했다가 바로 취소한다.
    await page.getByRole('button', { name: '얼굴 다시 찾기' }).click()
    await page.getByText('얼굴을 찾는 중').waitFor({ timeout: 30000 })
    await page.waitForTimeout(1500)
    await page.getByRole('button', { name: '취소' }).click()
    await page.getByText('얼굴 찾기를 취소했습니다.').waitFor({ timeout: 30000 })
    checks.push(['처리 중 취소가 된다', true])

    // ── 형식 변환: AVI 를 올리면 자동으로 변환한 뒤 열린다 ──
    await page.setInputFiles('.dropzone input[type=file]', path.join(root, 'tests', 'fixtures', 'videos', 'fmt-avi.avi'))
    await page.getByText('바로 열 수 없는 형식이라 변환하는 중').waitFor({ timeout: 30000 })
    await page.getByText('처리할 수 있는 형식으로 변환했습니다').waitFor({ timeout: 120000 })
    const facts = await page.locator('.facts').innerText()
    checks.push(['AVI 를 올리면 변환 진행률이 보이고 변환 뒤 영상 정보가 표시된다', facts.includes('fmt-avi.avi') && facts.includes('1280 × 720')])
    checks.push(['변환된 영상의 미리보기가 재생 가능한 상태가 된다', await page.waitForFunction(() => document.querySelector('.stage video')?.readyState >= 2, null, { timeout: 30000 }).then(() => true, () => false)])
    await page.screenshot({ path: path.join(reportDir, 'ui-6-converted.png'), fullPage: true })
    checks.push(['화면 오류가 없다', problems.length === 0])
    if (problems.length > 0) log(`오류: ${problems.join(' | ')}`)
  } finally {
    await browser?.close()
    if (server.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { windowsHide: true })
      else server.kill('SIGTERM')
    }
  }
  for (const [name, ok] of checks) console.log(`${ok ? '  통과' : '  실패'}  ${name}`)
  if (checks.length < 24 || checks.some(([, ok]) => !ok)) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
