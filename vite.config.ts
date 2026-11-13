import { createHash } from 'node:crypto'
import { createReadStream, readFileSync } from 'node:fs'
import { copyFile, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// PRD 원칙: 영상·얼굴 정보를 외부로 보내지 않으므로 모든 리소스는 같은 도메인에서만 제공한다.
// ffmpeg.wasm 멀티스레드(4단계)와 SharedArrayBuffer를 위해 교차 출처 격리 헤더를 개발 서버에도 건다.
const crossOriginIsolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

const wasmTypes: Record<string, string> = {
  '.mjs': 'text/javascript',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
}

/**
 * ONNX Runtime·ffmpeg.wasm 이 public 의 로더(.mjs/.js)를 동적 import 하면 Vite 개발 서버가 변환 대상으로 보고 거부한다.
 * 개발 중에는 런타임 파일을 변환 없이 그대로 내려주고, 배포 시에는 public 정적 파일로 동작한다.
 */
function serveWasmRaw(name: string): Plugin {
  const root = fileURLToPath(new URL(`./public/wasm/${name}`, import.meta.url))
  return {
    name: `serve-${name}-wasm-raw`,
    configureServer(server) {
      server.middlewares.use(`/wasm/${name}`, (request, response, next) => {
        const requestPath = (request.url ?? '/').split('?')[0] ?? '/'
        const file = path.join(root, path.basename(requestPath))
        const contentType = wasmTypes[path.extname(file)]
        if (!contentType) {
          next()
          return
        }
        void (async () => {
          try {
            const info = await stat(file)
            // 이 미들웨어는 Vite의 server.headers 보다 먼저 응답하므로 격리 헤더를 직접 붙인다.
            // 빠지면 COEP 아래에서 ORT 스레드 워커 스크립트가 ERR_BLOCKED_BY_RESPONSE 로 막혀 추론이 멈춘다.
            for (const [name, value] of Object.entries(crossOriginIsolationHeaders)) response.setHeader(name, value)
            response.setHeader('Content-Type', contentType)
            response.setHeader('Content-Length', String(info.size))
            response.setHeader('Cache-Control', 'no-store')
            createReadStream(file).pipe(response)
          } catch {
            next()
          }
        })()
      })
    },
  }
}

/**
 * 배포본에서 빼는 파일. 개발용 모델 비교 화면(?bench)에서만 쓰는 것과, 실제로는 읽지 않는 중복 파일이다.
 * (dist 기준 경로. 폴더는 끝에 / 를 붙인다.)
 */
const PRUNE_FROM_BUILD = [
  'fixtures/',
  'wasm/tasks-vision/',
  'models/blaze_face_short_range.tflite',
  'models/blaze_face_full_range.tflite',
  'models/scrfd_10g_gnkps_fp32.onnx',
  // ONNX Runtime 은 /wasm/ort/ 의 jsep 판만 읽는다(src/detectors/onnx/ort-env.ts 의 wasmPaths).
  'wasm/ort/ort-wasm-simd-threaded.mjs',
  'wasm/ort/ort-wasm-simd-threaded.wasm',
]

async function listFiles(directory: string, base = ''): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...(await listFiles(path.join(directory, entry.name), relative)))
    else found.push(relative)
  }
  return found
}

/**
 * 배포본 마무리(PWA):
 * 1) 배포에 필요 없는 파일을 지운다.
 * 2) 라이선스 고지를 함께 넣는다(ffmpeg.wasm 은 GPL).
 * 3) 서비스 워커가 오프라인용으로 저장할 파일 목록(precache-manifest.js)을 만든다.
 */
function finishPwaBuild(): Plugin {
  const outDir = fileURLToPath(new URL('./dist', import.meta.url))
  return {
    name: 'finish-pwa-build',
    apply: 'build',
    async closeBundle() {
      for (const target of PRUNE_FROM_BUILD) await rm(path.join(outDir, target), { recursive: true, force: true })
      // Vite 가 onnxruntime-web 에서 끌어온 WASM 사본. 실행 때는 /wasm/ort/ 의 파일을 읽으므로 쓰이지 않는다.
      for (const file of await readdir(path.join(outDir, 'assets'))) {
        if (/^ort-wasm.*\.wasm$/.test(file)) await rm(path.join(outDir, 'assets', file), { force: true })
      }
      await copyFile(fileURLToPath(new URL('./LICENSES.md', import.meta.url)), path.join(outDir, 'LICENSES.md'))

      const skip = new Set(['sw.js', 'precache-manifest.js'])
      const files = (await listFiles(outDir)).filter((file) => !skip.has(file) && !file.endsWith('.map')).sort()
      const hash = createHash('sha256')
      for (const file of files) {
        hash.update(file)
        hash.update(await readFile(path.join(outDir, file)))
      }
      const manifest = { version: hash.digest('hex').slice(0, 16), files: files.map((file) => `/${file}`) }
      await writeFile(path.join(outDir, 'precache-manifest.js'), `self.__PRECACHE = ${JSON.stringify(manifest)}\n`, 'utf8')
      const bytes = (await Promise.all(files.map((file) => stat(path.join(outDir, file))))).reduce((sum, info) => sum + info.size, 0)
      console.log(`\n[pwa] 오프라인용 파일 ${files.length}개, ${(bytes / 1024 / 1024).toFixed(1)}MB, 버전 ${manifest.version}`)
    },
  }
}

/** 미리보기 서버(vite preview)는 배포 설정(vercel.json)과 똑같은 헤더를 쓴다. 검증한 것과 배포되는 것이 같도록. */
function deployHeaders(): Record<string, string> {
  const config = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>
  }
  const all = config.headers.find((rule) => rule.source === '/(.*)')
  return Object.fromEntries((all?.headers ?? []).map((header) => [header.key, header.value]))
}

export default defineConfig({
  plugins: [react(), serveWasmRaw('ort'), serveWasmRaw('ffmpeg'), finishPwaBuild()],
  server: {
    port: 5173,
    strictPort: true,
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: deployHeaders(),
  },
  // 처리 중에 의존성을 새로 발견해 페이지가 새로 고쳐지지 않도록 시작할 때 미리 묶는다.
  optimizeDeps: {
    include: ['mediabunny', 'onnxruntime-web', '@mediapipe/tasks-vision', 'react', 'react-dom/client', 'qrcode-generator'],
    // ffmpeg.wasm 은 자기 워커 파일을 상대 경로로 띄우므로 미리 묶으면 워커를 찾지 못한다.
    exclude: ['@ffmpeg/ffmpeg'],
  },
  // 처리 워커가 동적 import(ONNX Runtime)를 쓰므로 ES 모듈 형식으로 묶는다.
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
})
