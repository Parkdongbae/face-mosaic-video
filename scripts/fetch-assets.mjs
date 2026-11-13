// 외부에서 받아 오는 자원(얼굴 검출 모델, WASM 런타임, 공개 라이선스 시험 사진)을
// public/ 아래로 내려받는다. 실행 시점에는 앱이 이 파일들을 같은 도메인에서만 읽는다.
// 사용: npm run assets
//
// 라이선스 때문에 기본으로는 받지 않는 것(README 하단 참고, 쓰는 사람이 직접 설치):
//   --ffmpeg  ffmpeg.wasm 실행 파일(@ffmpeg/core, GPL)만 public/wasm/ffmpeg 로 복사   → npm run assets:ffmpeg
//   --scrfd   SCRFD 모델(사용 조건 미확인, 개발용 비교 화면에서만 씀)만 내려받기      → npm run assets:scrfd
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const publicDir = path.join(root, 'public')
const photoDir = path.join(root, 'tests', 'fixtures', 'photos', 'raw')
const creditFile = path.join(root, 'tests', 'fixtures', 'photos', 'credits.json')

const USER_AGENT = 'MosaicFaceWebApp/0.1 (school project; local test fixtures)'

/** @type {{name: string, url: string, dir: string, note: string}[]} */
const modelAssets = [
  {
    name: 'blaze_face_short_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    dir: 'models',
    note: 'MediaPipe BlazeFace short-range, Apache-2.0',
  },
  {
    name: 'blaze_face_full_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite',
    dir: 'models',
    note: 'MediaPipe BlazeFace full-range, Apache-2.0',
  },
  {
    name: 'face_detection_yunet_2023mar.onnx',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
    dir: 'models',
    note: 'OpenCV Zoo YuNet 2023mar, MIT',
  },
]

/** 사용 조건을 확인하지 못해 기본으로는 받지 않는 모델(--scrfd). 개발용 비교 화면(?bench)에서만 쓴다. */
const scrfdAsset = {
  name: 'scrfd_10g_gnkps_fp32.onnx',
  url: 'https://huggingface.co/kunkunlin1221/face-detection_scrfd-10g-gnkps/resolve/main/scrfd_10g_gnkps_fp32.onnx',
  dir: 'models',
  note: 'SCRFD-10G (InsightFace 계열), 사용 조건 미확인',
}

/** Wikimedia Commons, CC0 사진. 시험 영상 합성 재료. */
const photoTitles = [
  'File:Face portrait (Unsplash).jpg',
  'File:Boy Face from Venezuela.jpg',
  'File:Girl with sad face.jpg',
  'File:A portrait of Khwairakpam Chaoba.jpg',
  'File:A student asking a question in a classroom 04.jpg',
  'File:Students reading in a classroom.jpg',
  'File:A teacher showing some students something on a phone.jpg',
  'File:A happy student.jpg',
  'File:Reopening-of-schools -nishapur.jpg',
]

const wasmCopies = [
  { from: 'node_modules/@mediapipe/tasks-vision/wasm', to: 'wasm/tasks-vision', all: true },
  {
    from: 'node_modules/onnxruntime-web/dist',
    to: 'wasm/ort',
    files: [
      'ort-wasm-simd-threaded.mjs',
      'ort-wasm-simd-threaded.wasm',
      'ort-wasm-simd-threaded.jsep.mjs',
      'ort-wasm-simd-threaded.jsep.wasm',
    ],
  },
]

/** 구형식 변환용 ffmpeg.wasm 실행 파일(GPL). 기본으로는 넣지 않는다(--ffmpeg). */
const ffmpegCopy = { from: 'node_modules/@ffmpeg/core/dist/esm', to: 'wasm/ffmpeg', files: ['ffmpeg-core.js', 'ffmpeg-core.wasm'] }

async function copyRuntime(copy) {
  const fromDir = path.join(root, copy.from)
  const toDir = path.join(publicDir, copy.to)
  await mkdir(toDir, { recursive: true })
  const files = copy.all ? await readdir(fromDir) : copy.files
  for (const file of files) {
    await copyFile(path.join(fromDir, file), path.join(toDir, file))
    const info = await stat(path.join(toDir, file))
    console.log(`[wasm ] ok   ${copy.to}/${file} ${info.size} bytes`)
  }
}

async function download(url, destination) {
  if (existsSync(destination)) {
    return { skipped: true, bytes: (await stat(destination)).size }
  }
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' })
  if (!response.ok) throw new Error(`다운로드 실패 ${response.status} ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, buffer)
  return { skipped: false, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }
}

function safeFileName(title) {
  const name = title.replace(/^File:/, '')
  return name.replace(/[\\/:*?"<>|]/g, '_')
}

async function fetchPhotoMetadata(titles) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: '1600',
    titles: titles.join('|'),
    origin: '*',
  })
  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { 'user-agent': USER_AGENT },
  })
  if (!response.ok) throw new Error(`Commons API 실패 ${response.status}`)
  const json = await response.json()
  const pages = Object.values(json.query?.pages ?? {})
  return pages.map((page) => {
    const info = page.imageinfo?.[0]
    const meta = info?.extmetadata ?? {}
    return {
      title: page.title,
      license: meta.LicenseShortName?.value ?? 'unknown',
      artist: (meta.Artist?.value ?? '').replace(/<[^>]+>/g, '').trim(),
      credit: (meta.Credit?.value ?? '').replace(/<[^>]+>/g, '').trim(),
      descriptionUrl: info?.descriptionurl ?? '',
      thumbUrl: info?.thumburl ?? info?.url ?? '',
      width: info?.width ?? 0,
      height: info?.height ?? 0,
    }
  })
}

async function main() {
  // 직접 설치 항목: 해당 항목만 처리하고 끝낸다.
  if (process.argv.includes('--ffmpeg')) {
    if (!existsSync(path.join(root, ffmpegCopy.from))) {
      throw new Error('@ffmpeg/core 가 설치되어 있지 않습니다. `npm run assets:ffmpeg` 으로 실행하세요.')
    }
    await copyRuntime(ffmpegCopy)
    console.log('\n완료: ffmpeg.wasm 실행 파일(GPL)을 넣었습니다. 이 파일을 포함해 배포하면 GPL 의무가 따릅니다.')
    return
  }
  if (process.argv.includes('--scrfd')) {
    const result = await download(scrfdAsset.url, path.join(publicDir, scrfdAsset.dir, scrfdAsset.name))
    console.log(`[model] ${result.skipped ? 'skip' : 'ok  '} ${scrfdAsset.name} ${result.bytes} bytes`)
    console.log('\n완료: SCRFD 모델을 받았습니다. 사용 조건을 직접 확인한 뒤 쓰세요(개발용 비교 화면 전용).')
    return
  }

  for (const asset of modelAssets) {
    const destination = path.join(publicDir, asset.dir, asset.name)
    const result = await download(asset.url, destination)
    console.log(`[model] ${result.skipped ? 'skip' : 'ok  '} ${asset.name} ${result.bytes} bytes`)
  }

  for (const copy of wasmCopies) await copyRuntime(copy)

  // 배포 빌드에서는 시험용 사진이 필요 없다(모델·WASM 만 준비).
  if (process.argv.includes('--no-photos')) {
    console.log(`\n완료: 모델 ${modelAssets.length}개 (시험 사진은 건너뜀)`)
    return
  }

  const photos = await fetchPhotoMetadata(photoTitles)
  if (photos.length === 0) throw new Error('Commons 사진 메타데이터를 받지 못했습니다')
  await mkdir(photoDir, { recursive: true })
  const credits = []
  for (const photo of photos) {
    if (!photo.thumbUrl) {
      console.warn(`[photo] skip (url 없음) ${photo.title}`)
      continue
    }
    const file = safeFileName(photo.title)
    const destination = path.join(photoDir, file)
    try {
      const result = await download(photo.thumbUrl, destination)
      credits.push({ ...photo, file, bytes: result.bytes })
      console.log(`[photo] ${result.skipped ? 'skip' : 'ok  '} ${file} ${result.bytes} bytes (${photo.license})`)
    } catch (error) {
      console.warn(`[photo] 실패(건너뜀) ${file}: ${error.message}`)
      credits.push({ ...photo, file, bytes: 0, downloadError: error.message })
    }
  }
  await writeFile(creditFile, `${JSON.stringify(credits, null, 2)}\n`, 'utf8')
  console.log(`\n완료: 모델 ${modelAssets.length}개, 사진 ${credits.length}장. 출처 기록 ${path.relative(root, creditFile)}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
