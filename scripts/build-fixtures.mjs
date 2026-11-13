// 공개 라이선스(CC0) 사진을 합성해 1단계 검출 시험용 클립과 프레임을 만든다.
// 실제 학생 얼굴 영상은 쓰지 않는다. 사용: npm run fixtures
import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import ffmpegPath from 'ffmpeg-static'

const run = promisify(execFile)
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const photoDir = path.join(root, 'tests', 'fixtures', 'photos', 'raw')
const outRoot = path.join(root, 'public', 'fixtures')
const workDir = path.join(root, 'tests', 'fixtures', 'clips')

const WIDTH = 1280
const HEIGHT = 720
const FPS = 30
const FRAME_FPS = 4
const SEGMENT_SECONDS = 1.5
const TILE_SECONDS = 3
const TILE = { width: 640, height: 360 }

const PORTRAITS = [
  'Face portrait (Unsplash).jpg',
  'Boy Face from Venezuela.jpg',
  'Girl with sad face.jpg',
  'A portrait of Khwairakpam Chaoba.jpg',
]
const CLASSROOM = [
  'A student asking a question in a classroom 04.jpg',
  'Students reading in a classroom.jpg',
  'A teacher showing some students something on a phone.jpg',
  'A happy student.jpg',
]
const DISTANT = [
  'Reopening-of-schools -nishapur.jpg',
  'Students reading in a classroom.jpg',
  'A teacher showing some students something on a phone.jpg',
  'A student asking a question in a classroom 04.jpg',
  'A happy student.jpg',
]

function zoomFilter() {
  return [
    'scale=1920:1080:force_original_aspect_ratio=increase',
    'crop=1920:1080',
    `zoompan=z='min(zoom+0.0012,1.15)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    'format=yuv420p',
  ].join(',')
}

async function ffmpeg(args) {
  const { stderr } = await run(ffmpegPath, ['-nostdin', '-y', ...args], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  return stderr
}

async function makeSegment(photo, destination) {
  await ffmpeg([
    '-loop', '1',
    '-t', String(SEGMENT_SECONDS),
    '-i', photo,
    '-vf', zoomFilter(),
    '-r', String(FPS),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    destination,
  ])
}

function tileFilter(inputCount) {
  const parts = []
  for (let index = 0; index < inputCount; index += 1) {
    parts.push(
      `[${index}:v]scale=${TILE.width}:${TILE.height}:force_original_aspect_ratio=increase,crop=${TILE.width}:${TILE.height},setsar=1[v${index}]`,
    )
  }
  const layout = '0_0|w0_0|0_h0|w0_h0'
  parts.push(`[v0][v1][v2][v3]xstack=inputs=4:layout=${layout},format=yuv420p[vout]`)
  return parts.join(';')
}

async function makeTileSegment(photos, destination) {
  const args = []
  for (const photo of photos) args.push('-loop', '1', '-t', String(TILE_SECONDS), '-i', photo)
  await ffmpeg([
    ...args,
    '-filter_complex', tileFilter(photos.length),
    '-map', '[vout]',
    '-r', String(FPS),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    destination,
  ])
}

async function concatSegments(segments, destination, workName) {
  const listFile = path.join(workDir, `${workName}.txt`)
  const lines = segments.map((file) => `file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
  await writeFile(listFile, `${lines.join('\n')}\n`, 'utf8')
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', destination])
}

async function extractFrames(video, frameDir) {
  await rm(frameDir, { recursive: true, force: true })
  await mkdir(frameDir, { recursive: true })
  await ffmpeg(['-i', video, '-vf', `fps=${FRAME_FPS}`, '-q:v', '3', path.join(frameDir, 'frame-%03d.jpg')])
  const files = (await readdir(frameDir)).filter((file) => file.endsWith('.jpg')).sort()
  return files
}

async function main() {
  if (!existsSync(photoDir)) throw new Error(`사진 폴더가 없습니다: ${photoDir}. 먼저 npm run assets 를 실행하세요.`)
  await mkdir(workDir, { recursive: true })
  await mkdir(outRoot, { recursive: true })

  const photos = new Set(await readdir(photoDir))
  for (const name of [...PORTRAITS, ...CLASSROOM, ...DISTANT]) {
    if (!photos.has(name)) throw new Error(`시험 사진이 없습니다: ${name}`)
  }

  const sourcePath = (name) => path.join(photoDir, name)
  const clips = []

  const portraitSegments = []
  for (const [index, name] of PORTRAITS.entries()) {
    const segment = path.join(workDir, `portrait-${index}.mp4`)
    await makeSegment(sourcePath(name), segment)
    portraitSegments.push(segment)
  }
  await concatSegments(portraitSegments, path.join(workDir, 'closeup.mp4'), 'closeup')

  const wideSegments = []
  for (const [index, name] of CLASSROOM.entries()) {
    const segment = path.join(workDir, `wide-${index}.mp4`)
    await makeSegment(sourcePath(name), segment)
    wideSegments.push(segment)
  }
  await concatSegments(wideSegments, path.join(workDir, 'classroom-wide.mp4'), 'classroom-wide')

  const tileSegments = []
  for (const [index, group] of [DISTANT.slice(0, 4), DISTANT.slice(1, 5)].entries()) {
    const segment = path.join(workDir, `tiles-${index}.mp4`)
    await makeTileSegment(group.map(sourcePath), segment)
    tileSegments.push(segment)
  }
  await concatSegments(tileSegments, path.join(workDir, 'classroom-tiles.mp4'), 'classroom-tiles')

  const definitions = [
    {
      id: 'closeup',
      label: '가까운 얼굴',
      description: '인물 사진 4장, 얼굴이 화면 절반 크기',
      video: path.join(workDir, 'closeup.mp4'),
      sources: PORTRAITS,
    },
    {
      id: 'classroom-wide',
      label: '교실 전체',
      description: '교실 사진 4장, 얼굴이 화면의 1/6 크기',
      video: path.join(workDir, 'classroom-wide.mp4'),
      sources: CLASSROOM,
    },
    {
      id: 'classroom-tiles',
      label: '멀리 있는 얼굴',
      description: '2x2 분할, 얼굴 높이 48px 이하',
      video: path.join(workDir, 'classroom-tiles.mp4'),
      sources: DISTANT,
    },
  ]

  for (const definition of definitions) {
    const frameDir = path.join(outRoot, definition.id)
    const files = await extractFrames(definition.video, frameDir)
    if (files.length === 0) throw new Error(`${definition.id}: 프레임이 생성되지 않았습니다`)
    clips.push({
      id: definition.id,
      label: definition.label,
      description: definition.description,
      video: `/fixtures/clips/${definition.id}.mp4`,
      width: WIDTH,
      height: HEIGHT,
      fps: FPS,
      frames: files.map((file) => `/fixtures/${definition.id}/${file}`),
      sources: definition.sources,
    })
    console.log(`[clip] ${definition.id}: 프레임 ${files.length}장`)
  }

  const clipDir = path.join(outRoot, 'clips')
  await mkdir(clipDir, { recursive: true })
  for (const definition of definitions) {
    const target = path.join(clipDir, `${definition.id}.mp4`)
    await ffmpeg(['-i', definition.video, '-c', 'copy', '-movflags', '+faststart', target])
  }

  const manifest = { generatedAt: new Date().toISOString(), clips }
  await writeFile(path.join(outRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`완료: 클립 ${clips.length}개, 프레임 ${clips.reduce((sum, clip) => sum + clip.frames.length, 0)}장`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
