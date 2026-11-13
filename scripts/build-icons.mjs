// 앱 아이콘(PWA)을 만든다. 직접 그린 도형을 브라우저로 그려 PNG 로 저장한다(외부 그림을 쓰지 않는다).
// 사용: node scripts/build-icons.mjs  → public/icons/*.png
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(root, 'public', 'icons')

/** 얼굴 자리가 모자이크 칸으로 바뀐 모양. inset 은 가장자리 여백 비율(마스크용 아이콘은 여백을 넉넉히 둔다). */
function iconSvg(size, { maskable }) {
  const colors = ['#ccfbf1', '#5eead4', '#99f6e4', '#2dd4bf', '#f0fdfa', '#14b8a6', '#a7f3d0', '#5eead4', '#ccfbf1']
  const inset = maskable ? 0.2 : 0.14
  const grid = 4
  const area = size * (1 - inset * 2)
  const cell = area / grid
  const origin = size * inset
  let cells = ''
  for (let row = 0; row < grid; row += 1) {
    for (let col = 0; col < grid; col += 1) {
      // 모서리 칸을 비워 둥근 얼굴 윤곽처럼 보이게 한다.
      const corner = (row === 0 || row === grid - 1) && (col === 0 || col === grid - 1)
      if (corner) continue
      const color = colors[(row * 5 + col * 3) % colors.length]
      cells += `<rect x="${origin + col * cell + cell * 0.06}" y="${origin + row * cell + cell * 0.06}" width="${cell * 0.88}" height="${cell * 0.88}" rx="${cell * 0.14}" fill="${color}"/>`
    }
  }
  const radius = maskable ? 0 : size * 0.22
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0f766e"/><stop offset="1" stop-color="#123f3b"/></linearGradient></defs>
  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#g)"/>${cells}</svg>`
}

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
]

await mkdir(outDir, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const target of targets) {
    const page = await browser.newPage({ viewport: { width: target.size, height: target.size }, deviceScaleFactor: 1 })
    await page.setContent(`<html><body style="margin:0;background:transparent">${iconSvg(target.size, target)}</body></html>`)
    await page.screenshot({ path: path.join(outDir, target.file), omitBackground: true })
    await page.close()
    console.log(`[icon] ${target.file}`)
  }
} finally {
  await browser.close()
}
