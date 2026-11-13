import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MOSAIC_DEFAULTS, SENSITIVITY_PRESETS, SPLIT_DEFAULTS, type OutputQuality, type Sensitivity } from '../config/mosaic-defaults'
import { displayToSource, rectFromPoints, type Point, type Rect } from '../core/geometry'
import { FALSE_POSITIVE_LABELS, keepFaces, type FalsePositiveFilter } from '../core/false-positive'
import { countOutside, linkedTrackIds, maskStartFrames, nextManualId, NO_EDITS, planMasks, type Edits } from '../core/mask-plan'
import { polygonRegion, rectRegion, regionActive, regionBounds, regionContains, translateRegion, type Region } from '../core/regions'
import { pieceFileName, planSplit, type KeyFrameIndex, type SplitPiece } from '../core/split-plan'
import { nearestIndex } from '../core/tracker'
import { MosaicClient } from '../pipeline/client'
import { buildProject, parseProject, regionsFit, type ProjectFile } from '../project/project-file'
import { checkH264Encode, collectSpec, type SpecStage } from '../spec/collect'
import { judgeSpec, type SpecMeasurements } from '../spec/judge'
import { SpecPanel } from '../spec/SpecPanel'
import { GuidePanel } from './GuidePanel'
import { HoldButton } from './HoldButton'
import { SplitPanel, type PieceStatus, type SplitChoice } from './SplitPanel'
import { probeVideo } from '../pipeline/probe'
import { classifySource, prepareSource } from '../pipeline/source'
import {
  JobCanceledError,
  type AnalysisResult,
  type JobSettings,
  type RenderStats,
  type VideoInfo,
} from '../pipeline/types'
import './mvp.css'

const QUALITY_LABELS: Record<OutputQuality, string> = {
  medium: '보통 (용량 작게)',
  high: '좋음',
  'very-high': '아주 좋음 (용량 크게)',
}

const ACCEPT = 'video/*,.mp4,.m4v,.mov,.webm,.avi,.mkv,.wmv,.flv,.mts,.m2ts,.ts,.mpg,.mpeg,.3gp,.ogv'
/** 영역으로 인정하는 최소 크기(영상 폭·높이 대비). 실수로 찍힌 점을 걸러 낸다. */
const MIN_REGION_RATIO = 0.02

/** 미리보기 화면 위에서 마우스로 하는 일 */
type Tool = 'rect' | 'polygon' | 'move' | 'add-face' | 'remove'

const TOOLS: Array<{ id: Tool; label: string; help: string; needsAnalysis: boolean }> = [
  { id: 'rect', label: '사각형 영역', help: '화면 위에서 끌어서 사각형 영역을 그립니다.', needsAnalysis: false },
  { id: 'polygon', label: '다각형 영역', help: '꼭짓점을 차례로 눌러 찍고, 첫 점을 다시 누르거나 ‘다각형 완성’을 누르면 영역이 됩니다.', needsAnalysis: false },
  { id: 'move', label: '영역 옮기기', help: '영역 안을 잡고 끌어서 옮깁니다.', needsAnalysis: false },
  { id: 'add-face', label: '얼굴 추가', help: '놓친 얼굴 위에 끌어서 상자를 그리면, 앞뒤 프레임을 따라가며 자동으로 채웁니다. 따라갈 시간은 옆에서 바꿀 수 있습니다.', needsAnalysis: true },
  { id: 'remove', label: '가림 삭제', help: '잘못 가려진 곳(노란 상자)을 누르면 그 가림을 지웁니다.', needsAnalysis: true },
]

type Busy = {
  phase: 'analyze' | 'render' | 'convert' | 'split'
  /** 화면에 보여 줄 작업 이름 */
  label: string
  progress: { fraction: number; fps: number | null } | null
  startedAt: number
} | null

function downloadBuffer(buffer: ArrayBuffer, name: string): void {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

function outputName(name: string): string {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name}_mosaic.mp4`
}

const FINDING_LABEL = '얼굴을 찾는 중'
/** 얼굴 추가 때 따라갈 시간으로 정할 수 있는 범위(초) */
const MANUAL_SPAN_MIN_SEC = 1
const MANUAL_SPAN_MAX_SEC = 60

export default function MosaicApp() {
  const [file, setFile] = useState<File | null>(null)
  const [info, setInfo] = useState<VideoInfo | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [regions, setRegions] = useState<Region[]>([])
  const [tool, setTool] = useState<Tool>('rect')
  /** 새로 그리는 영역을 제외 영역(가리지 않을 곳)으로 만들지 */
  const [drawExclude, setDrawExclude] = useState(false)
  const [polygonDraft, setPolygonDraft] = useState<Point[]>([])
  /** 검토 단계에서 사용자가 고친 내용(수동 추가·삭제) */
  const [edits, setEdits] = useState<Edits>(NO_EDITS)
  // 얼굴 추가 때 표시한 프레임에서 앞뒤로 따라갈 최대 시간(초)
  const [manualSpanSec, setManualSpanSec] = useState<number>(MOSAIC_DEFAULTS.manualTrackSpanSec)
  // 가림 삭제 한 번에 지운 추적 수(되돌리기를 한 번 누르면 그 묶음이 통째로 돌아온다)
  const [removeSizes, setRemoveSizes] = useState<number[]>([])
  const [sensitivity, setSensitivity] = useState<Sensitivity>(MOSAIC_DEFAULTS.sensitivity)
  const [quality, setQuality] = useState<OutputQuality>(MOSAIC_DEFAULTS.quality)
  const [falsePositiveFilter, setFalsePositiveFilter] = useState<FalsePositiveFilter>('normal')
  const [marginPercent, setMarginPercent] = useState(Math.round(MOSAIC_DEFAULTS.marginRatio * 100))
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saved, setSaved] = useState<{ stats: RenderStats; name: string } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [previewMode, setPreviewMode] = useState<'mosaic' | 'boxes' | 'off'>('mosaic')
  /** 실제로 분석·저장에 쓰는 파일. 빠른 경로면 원본, 변환 경로면 변환된 중간 MP4 */
  const [workFile, setWorkFile] = useState<File | null>(null)
  const [convertedNote, setConvertedNote] = useState<string | null>(null)

  // 영상 분할(F-16)
  const [splitChoice, setSplitChoice] = useState<SplitChoice>('none')
  const [splitCount, setSplitCount] = useState<number>(SPLIT_DEFAULTS.count)
  const [splitMaxMb, setSplitMaxMb] = useState<number>(SPLIT_DEFAULTS.maxMb)
  const [pieces, setPieces] = useState<SplitPiece[] | null>(null)
  const [pieceStatus, setPieceStatus] = useState<Record<number, PieceStatus>>({})
  const [splitError, setSplitError] = useState<string | null>(null)
  const keyIndexRef = useRef<{ file: File; index: KeyFrameIndex } | null>(null)
  /** 프로젝트 파일에서 읽은 "이미 저장을 마친 구간" */
  const doneRangesRef = useRef<Array<{ startSec: number; endSec: number }>>([])
  const abortRef = useRef<AbortController | null>(null)
  const stopRef = useRef(false)

  // 사양 점검(F-01)
  const [measurements, setMeasurements] = useState<SpecMeasurements | null>(null)
  const [specChecking, setSpecChecking] = useState<{ stage: SpecStage; fraction: number } | null>({ stage: '기기 정보 확인', fraction: 0 })
  const [specFailure, setSpecFailure] = useState<string | null>(null)
  /** 사용자가 알고도 진행하기로 한 판정 단계 */
  const [accepted, setAccepted] = useState<'none' | 'caution' | 'unfit'>('none')
  const [lowSpecMode, setLowSpecMode] = useState(false)
  const [videoEncode, setVideoEncode] = useState<{ width: number; height: number; support: SpecMeasurements['h264Encode'] } | null>(null)
  const [pendingProject, setPendingProject] = useState<ProjectFile | null>(null)

  const clientRef = useRef<MosaicClient | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const scratchRef = useRef<HTMLCanvasElement | null>(null)
  const draftRef = useRef<{ start: Point; current: Point } | null>(null)
  const moveRef = useRef<{ id: string; last: Point } | null>(null)

  const settings: JobSettings = useMemo(
    () => ({
      regions,
      sensitivity,
      quality,
      marginRatio: marginPercent / 100,
      blocksAcross: MOSAIC_DEFAULTS.blocksAcross,
      maxGapFrames: MOSAIC_DEFAULTS.maxGapFrames,
      padFrames: MOSAIC_DEFAULTS.padFrames,
      falsePositiveFilter,
    }),
    [regions, sensitivity, quality, marginPercent, falsePositiveFilter],
  )

  // 미리보기와 저장이 같은 계산을 쓴다: 영역 규칙(포함·제외·구간) + 수동 추가·삭제
  const plan = useMemo(() => (analysis ? planMasks(analysis, settings, edits) : null), [analysis, settings, edits])
  const maskedFrames = useMemo(() => plan?.reduce((count, boxes) => count + (boxes.length > 0 ? 1 : 0), 0) ?? 0, [plan])
  // 찾은 것 가운데 얼굴로 보고 남긴 수와, 얼굴이 아닌 것으로 보고 뺀 수
  const faceCount = useMemo(
    () => (analysis ? keepFaces(analysis.tracks, analysis.width, analysis.height, falsePositiveFilter).length : 0),
    [analysis, falsePositiveFilter],
  )
  const rejectedCount = analysis ? analysis.tracks.length - faceCount : 0
  const outsideCount = useMemo(() => (analysis ? countOutside(analysis, regions) : 0), [analysis, regions])

  /** 이 시각에 화면에 보이는 프레임의 번호(분석 결과 기준). 분석 전이면 -1. */
  const frameAt = useCallback(
    (timeSec: number): number => {
      if (!analysis) return -1
      const target = timeSec * 1e6
      let index = nearestIndex(analysis.timestampsUs, target)
      // 영상 요소는 "이 시각 이전의 마지막 프레임"을 보여 주므로, 가장 가까운 것이 미래 프레임이면 하나 앞을 쓴다.
      if (index > 0 && (analysis.timestampsUs[index] ?? 0) > target + 2000) index -= 1
      return index
    },
    [analysis],
  )

  const runSpecCheck = useCallback(async () => {
    setSpecFailure(null)
    setMeasurements(null)
    setSpecChecking({ stage: '기기 정보 확인', fraction: 0 })
    try {
      setMeasurements(await collectSpec((stage, fraction) => setSpecChecking({ stage, fraction })))
    } catch (cause) {
      setSpecFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSpecChecking(null)
    }
  }, [])

  useEffect(() => {
    void runSpecCheck()
  }, [runSpecCheck])

  // 영상을 불러오면 그 영상 해상도로 H.264 저장이 되는지 다시 확인한다.
  useEffect(() => {
    if (!info) {
      setVideoEncode(null)
      return
    }
    let stale = false
    void checkH264Encode(info.width, info.height).then((support) => {
      if (!stale) setVideoEncode({ width: info.width, height: info.height, support })
    })
    return () => {
      stale = true
    }
  }, [info])

  const judgement = useMemo(() => {
    if (!measurements) return null
    const adjusted = videoEncode
      ? { ...measurements, h264Encode: videoEncode.support, encodeCheckedAt: { width: videoEncode.width, height: videoEncode.height } }
      : measurements
    return judgeSpec(
      adjusted,
      info ? { durationSec: info.durationSec, fps: info.fps, width: info.width, height: info.height, sizeBytes: info.sizeBytes } : null,
    )
  }, [measurements, videoEncode, info])

  const proceeding =
    judgement === null
      ? accepted !== 'none'
      : judgement.verdict === 'fit' ||
        (judgement.verdict === 'caution' && accepted !== 'none') ||
        (judgement.verdict === 'unfit' && accepted === 'unfit')
  const canWork = specChecking === null && proceeding

  const acceptSpec = useCallback(() => {
    if (judgement?.verdict === 'caution') {
      setAccepted((current) => (current === 'unfit' ? current : 'caution'))
      return
    }
    // 부적합(또는 점검 실패)인데도 진행: 큰 얼굴 위주의 빠른 검출로 낮춘다.
    setAccepted('unfit')
    setLowSpecMode(true)
    setSensitivity('low')
    setAnalysis(null)
  }, [judgement])

  const downloadProject = useCallback(() => {
    const project = buildProject({
      video: info
        ? { name: info.name, sizeBytes: info.sizeBytes, durationSec: info.durationSec, width: info.width, height: info.height }
        : null,
      regions,
      sensitivity,
      quality,
      marginRatio: marginPercent / 100,
      manualTracks: edits.manualTracks,
      split:
        splitChoice === 'none'
          ? null
          : {
              choice: splitChoice,
              count: splitCount,
              maxMb: splitMaxMb,
              done: (pieces ?? [])
                .filter((piece) => pieceStatus[piece.index] === 'done')
                .map((piece) => ({ startSec: piece.startSec, endSec: piece.endSec })),
            },
    })
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(project, null, 2)}\n`], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    const base = info ? info.name.replace(/\.[^.]+$/, '') : '얼굴모자이크'
    link.download = `${base}_프로젝트.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }, [info, regions, sensitivity, quality, marginPercent, edits, splitChoice, splitCount, splitMaxMb, pieces, pieceStatus])

  const applyProject = useCallback((project: ProjectFile, video: { width: number; height: number } | null) => {
    setSplitChoice(project.split?.choice ?? 'none')
    if (project.split) {
      setSplitCount(project.split.count)
      setSplitMaxMb(project.split.maxMb)
    }
    doneRangesRef.current = project.split?.done ?? []
    setPieces(null)
    setPieceStatus({})
    setSensitivity(project.settings.sensitivity)
    setQuality(project.settings.quality)
    setMarginPercent(Math.round(project.settings.marginRatio * 100))
    setAnalysis(null)
    setSaved(null)
    if (!video) {
      setPendingProject(project)
      setNotice(
        project.settings.regions.length > 0
          ? '프로젝트 설정을 불러왔습니다. 영역은 영상을 불러오면 적용합니다.'
          : '프로젝트 설정을 불러왔습니다.',
      )
      return
    }
    setPendingProject(null)
    if (regionsFit(project, video.width, video.height)) {
      setRegions(project.settings.regions)
      setEdits({ manualTracks: project.manualTracks ?? [], removedTrackIds: [] })
      setRemoveSizes([])
      setNotice('프로젝트의 영역과 설정을 적용했습니다.')
    } else {
      setNotice('프로젝트 설정은 적용했지만, 영상 해상도가 달라 영역은 적용하지 않았습니다. 영역을 다시 그려 주세요.')
    }
  }, [])

  const importProject = useCallback(
    async (chosen: File) => {
      setError(null)
      try {
        applyProject(parseProject(await chosen.text()), info)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [applyProject, info],
  )

  // 영상보다 프로젝트 파일을 먼저 불러온 경우, 영상이 열리면 영역을 적용한다.
  useEffect(() => {
    if (info && pendingProject) applyProject(pendingProject, info)
  }, [info, pendingProject, applyProject])

  useEffect(() => {
    const client = new MosaicClient()
    clientRef.current = client
    return () => {
      client.dispose()
      clientRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!videoUrl) return
    return () => URL.revokeObjectURL(videoUrl)
  }, [videoUrl])

  // 처리 중에 탭을 닫으려 하면 경고한다(F-13).
  useEffect(() => {
    if (!busy) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [busy])

  const openFile = useCallback(async (next: File) => {
    setError(null)
    setNotice(null)
    setSaved(null)
    setAnalysis(null)
    setRegions([])
    setInfo(null)
    setFile(null)
    setVideoUrl(null)
    setCurrentTime(0)
    setPlaying(false)
    setWorkFile(null)
    setConvertedNote(null)
    setEdits(NO_EDITS)
    setRemoveSizes([])
    setPolygonDraft([])
    setPieces(null)
    setPieceStatus({})
    setSplitError(null)
    keyIndexRef.current = null
    const controller = new AbortController()
    abortRef.current = controller
    try {
      // 실제 형식·코덱을 보고 경로를 고른다. 바로 열 수 없는 형식은 ffmpeg.wasm 으로 변환한다(F-03).
      if ((await classifySource(next)) === 'convert') {
        setBusy({ phase: 'convert', label: '바로 열 수 없는 형식이라 변환하는 중', progress: null, startedAt: performance.now() })
      }
      const prepared = await prepareSource(next, {
        signal: controller.signal,
        onProgress: (value) => setBusy((current) => (current ? { ...current, progress: { fraction: value, fps: null } } : current)),
      })
      const probed = await probeVideo(prepared.workFile)
      if (!probed.canDecodeVideo) {
        throw new Error(`이 브라우저에서 해독할 수 없는 영상입니다(코덱: ${probed.videoCodec ?? '알 수 없음'}).`)
      }
      // 화면에는 원본 파일의 이름·용량을 보여 준다.
      setInfo({ ...probed, name: next.name, sizeBytes: next.size })
      setFile(next)
      setWorkFile(prepared.workFile)
      setVideoUrl(URL.createObjectURL(prepared.workFile))
      if (prepared.conversion) {
        const source = `${prepared.conversion.streams.videoCodec ?? '?'}${prepared.conversion.streams.audioCodec ? ` + ${prepared.conversion.streams.audioCodec}` : ''}`
        setConvertedNote(
          prepared.conversion.videoTranscoded
            ? `원본(${source})을 처리할 수 있는 형식으로 변환했습니다.`
            : `원본(${source})의 영상은 그대로 두고 ${prepared.conversion.audioAction === 'transcoded' ? '소리만 변환했습니다.' : '담는 형식만 바꿨습니다.'}`,
        )
      }
    } catch (cause) {
      if (cause instanceof JobCanceledError) setNotice('형식 변환을 취소했습니다.')
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      abortRef.current = null
      setBusy(null)
    }
  }, [])

  const cancelJob = useCallback(() => {
    stopRef.current = true
    abortRef.current?.abort()
    clientRef.current?.cancel()
  }, [])

  const trackProgress = useCallback(
    (progress: { fraction: number; fps: number }) =>
      setBusy((current) => (current ? { ...current, progress: { fraction: progress.fraction, fps: progress.fps } } : current)),
    [],
  )

  // 영역·감도가 바뀌면 이전 검출 결과는 맞지 않으므로 버린다.
  const invalidate = useCallback(() => {
    setAnalysis(null)
    setSaved(null)
    setNotice(null)
    setEdits((current) => ({ ...current, removedTrackIds: [] }))
    setRemoveSizes([])
  }, [])

  // 영역은 가림 계획을 만들 때 적용하므로, 영역을 바꿔도 얼굴을 다시 찾을 필요가 없다. 저장 완료 표시만 지운다.
  const touchRegions = useCallback(() => {
    setSaved(null)
    setNotice(null)
  }, [])

  const updateRegion = useCallback(
    (id: string, change: Partial<Region>) => {
      setRegions((current) => current.map((region) => (region.id === id ? { ...region, ...change } : region)))
      touchRegions()
    },
    [touchRegions],
  )

  const runAnalysis = useCallback(async () => {
    const client = clientRef.current
    if (!client || !workFile) return
    setError(null)
    setNotice(null)
    setSaved(null)
    setAnalysis(null)
    setEdits((current) => ({ ...current, removedTrackIds: [] }))
    setRemoveSizes([])
    videoRef.current?.pause()
    setBusy({ phase: 'analyze', label: FINDING_LABEL, progress: null, startedAt: performance.now() })
    try {
      const result = await client.analyze(workFile, settings, trackProgress)
      setAnalysis(result)
    } catch (cause) {
      if (cause instanceof JobCanceledError) setNotice('얼굴 찾기를 취소했습니다.')
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [workFile, settings, trackProgress])

  // 영상을 열면(그리고 찾는 정도를 바꾸면) 누르지 않아도 얼굴을 찾기 시작한다.
  // 같은 영상·같은 설정으로는 한 번만 자동 실행하므로, 취소하거나 실패한 뒤에 저절로 다시 시작하지 않는다.
  const autoAnalyzedRef = useRef<{ file: File; sensitivity: Sensitivity } | null>(null)
  useEffect(() => {
    if (!canWork || !workFile || busy !== null || analysis) return
    const last = autoAnalyzedRef.current
    if (last && last.file === workFile && last.sensitivity === sensitivity) return
    autoAnalyzedRef.current = { file: workFile, sensitivity }
    void runAnalysis()
  }, [canWork, workFile, busy, analysis, sensitivity, runAnalysis])

  // ── 영상 분할 ──
  const resetSplit = useCallback(() => {
    setPieces(null)
    setPieceStatus({})
    setSplitError(null)
  }, [])

  const previewSplit = useCallback(async () => {
    const client = clientRef.current
    if (!client || !workFile || splitChoice === 'none') return
    setSplitError(null)
    setError(null)
    try {
      let cached = keyIndexRef.current
      if (!cached || cached.file !== workFile) {
        cached = { file: workFile, index: await client.keyFrames(workFile) }
        keyIndexRef.current = cached
      }
      const planned = planSplit(
        cached.index,
        splitChoice === 'count' ? { kind: 'count', count: splitCount } : { kind: 'size', maxBytes: splitMaxMb * 1024 * 1024 },
      )
      // 프로젝트 파일에 완료로 적힌 구간은 완료 상태로 표시해 건너뛴다.
      const statuses: Record<number, PieceStatus> = {}
      for (const piece of planned) {
        const done = doneRangesRef.current.some(
          (range) => Math.abs(range.startSec - piece.startSec) < 0.01 && Math.abs(range.endSec - piece.endSec) < 0.01,
        )
        if (done) statuses[piece.index] = 'done'
      }
      setPieces(planned)
      setPieceStatus(statuses)
    } catch (cause) {
      setPieces(null)
      setSplitError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [workFile, splitChoice, splitCount, splitMaxMb])

  /** 조각을 저장할 폴더를 고른다. 폴더 선택을 지원하지 않는 브라우저면 null(내려받기로 대체). 취소하면 'canceled'. */
  const pickDirectory = useCallback(async (): Promise<FileSystemDirectoryHandle | null | 'canceled'> => {
    if (!window.showDirectoryPicker) return null
    try {
      return await window.showDirectoryPicker({ mode: 'readwrite' })
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return 'canceled'
      throw cause
    }
  }, [])

  const runSplitOnly = useCallback(async () => {
    const client = clientRef.current
    if (!client || !file || !workFile || !pieces) return
    setError(null)
    setNotice(null)
    try {
      const directory = await pickDirectory()
      if (directory === 'canceled') return
      const names = pieces.map((piece) => pieceFileName(file.name, piece.index, false))
      const handles: Array<FileSystemFileHandle | null> = []
      for (const name of names) handles.push(directory ? await directory.getFileHandle(name, { create: true }) : null)
      videoRef.current?.pause()
      setBusy({ phase: 'split', label: '영상을 나누는 중(재압축 없음)', progress: null, startedAt: performance.now() })
      const result = await client.split(workFile, pieces, handles, trackProgress)
      result.buffers.forEach((buffer, position) => {
        if (buffer) downloadBuffer(buffer, names[position] ?? `part${position + 1}.mp4`)
      })
      setNotice(`조각 ${result.pieces.length}개로 나눠 저장했습니다(모자이크 없음): ${names[0]} … ${names[names.length - 1]}`)
    } catch (cause) {
      if (cause instanceof JobCanceledError) setNotice('나누기를 취소했습니다.')
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [file, workFile, pieces, pickDirectory, trackProgress])

  /** 조각을 하나씩 차례로 모자이크 처리해 저장한다. 한 조각이 끝난 뒤에야 다음 조각을 시작한다. */
  const runSavePieces = useCallback(async () => {
    const client = clientRef.current
    if (!client || !file || !workFile || !analysis || !pieces) return
    setError(null)
    setNotice(null)
    setSaved(null)
    const waiting = pieces.filter((piece) => pieceStatus[piece.index] !== 'done')
    if (waiting.length === 0) {
      setNotice('모든 조각이 이미 완료 상태입니다. 다시 저장하려면 ‘완료 표시 지우기’를 누르세요.')
      return
    }
    let current: SplitPiece | null = null
    try {
      const directory = await pickDirectory()
      if (directory === 'canceled') return
      videoRef.current?.pause()
      stopRef.current = false
      let count = 0
      for (const piece of waiting) {
        if (stopRef.current) throw new JobCanceledError()
        current = piece
        const name = pieceFileName(file.name, piece.index, true)
        const handle = directory ? await directory.getFileHandle(name, { create: true }) : null
        setPieceStatus((statuses) => ({ ...statuses, [piece.index]: 'working' }))
        setBusy({ phase: 'render', label: `조각 ${piece.index}/${pieces.length} 모자이크 영상을 저장하는 중`, progress: null, startedAt: performance.now() })
        const isLast = piece.index === pieces.length
        const result = await client.render(
          workFile,
          analysis,
          settings,
          handle,
          trackProgress,
          { startSec: piece.startSec, endSec: isLast ? null : piece.endSec },
          edits,
        )
        if (result.buffer) downloadBuffer(result.buffer, name)
        setPieceStatus((statuses) => ({ ...statuses, [piece.index]: 'done' }))
        count += 1
        current = null
      }
      setNotice(`조각 ${count}개 저장을 마쳤습니다. 올리기 전에 결과 영상을 처음부터 끝까지 꼭 확인하세요.`)
    } catch (cause) {
      const interrupted = current
      if (interrupted) setPieceStatus((statuses) => ({ ...statuses, [interrupted.index]: 'waiting' }))
      if (cause instanceof JobCanceledError) setNotice('저장을 취소했습니다. 쓰다 만 조각은 버렸고, 완료된 조각은 그대로 있습니다.')
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [file, workFile, analysis, pieces, pieceStatus, settings, edits, pickDirectory, trackProgress])

  const runSave = useCallback(async () => {
    const client = clientRef.current
    if (!client || !file || !workFile || !analysis) return
    if (splitChoice !== 'none' && pieces) {
      await runSavePieces()
      return
    }
    setError(null)
    setNotice(null)
    setSaved(null)
    const name = outputName(file.name)

    let handle: FileSystemFileHandle | null = null
    if (window.showSaveFilePicker) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'MP4 영상', accept: { 'video/mp4': ['.mp4'] } }],
        })
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError(cause instanceof Error ? cause.message : String(cause))
        return
      }
      // 원본을 덮어쓰지 않도록 원본과 같은 이름은 받지 않는다.
      if (handle.name === file.name) {
        setError('원본과 같은 이름으로는 저장할 수 없습니다. 다른 이름을 골라 주세요.')
        return
      }
    }

    videoRef.current?.pause()
    setBusy({ phase: 'render', label: '모자이크 영상을 저장하는 중', progress: null, startedAt: performance.now() })
    try {
      const result = await client.render(workFile, analysis, settings, handle, trackProgress, null, edits)
      if (result.buffer) downloadBuffer(result.buffer, name)
      setSaved({ stats: result.stats, name: handle?.name ?? name })
    } catch (cause) {
      if (cause instanceof JobCanceledError) setNotice('저장을 취소했습니다. 쓰다 만 결과 파일은 버렸습니다.')
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }, [file, workFile, analysis, settings, edits, splitChoice, pieces, runSavePieces, trackProgress])

  const splitRecommendation = useMemo(() => {
    if (!info || splitChoice !== 'none') return null
    if (info.sizeBytes >= SPLIT_DEFAULTS.recommendBytes || info.durationSec >= SPLIT_DEFAULTS.recommendDurationSec) {
      return '영상이 큽니다. 여러 조각으로 나눠 저장하면 중간에 멈춰도 끝난 조각은 남고, 파일을 다루기 쉽습니다.'
    }
    if (judgement && judgement.verdict !== 'fit' && info.durationSec >= SPLIT_DEFAULTS.recommendDurationWhenSlowSec) {
      return '이 컴퓨터에서는 처리에 시간이 걸립니다. 영상을 나눠 저장하면 중간에 멈춰도 끝난 조각은 남습니다.'
    }
    return null
  }, [info, splitChoice, judgement])

  // ── 검토·수정(F-10·F-11) ──
  /** 놓친 얼굴을 직접 표시하면 앞뒤 프레임을 따라가며 자동으로 채운다. */
  const addFace = useCallback(
    async (box: Rect) => {
      const client = clientRef.current
      const video = videoRef.current
      if (!client || !workFile || !analysis || !video) return
      const frame = frameAt(video.currentTime)
      const timeUs = analysis.timestampsUs[frame]
      if (timeUs === undefined) return
      setError(null)
      setNotice(null)
      setSaved(null)
      video.pause()
      setBusy({ phase: 'analyze', label: '추가한 얼굴을 앞뒤 프레임에서 따라가는 중', progress: null, startedAt: performance.now() })
      try {
        const points = await client.trackFace(workFile, timeUs, box, manualSpanSec, trackProgress)
        setEdits((current) => ({ ...current, manualTracks: [...current.manualTracks, { id: nextManualId(current), points }] }))
        const first = points[0]?.timeUs ?? timeUs
        const last = points[points.length - 1]?.timeUs ?? timeUs
        setNotice(
          `얼굴을 추가했습니다. 표시한 프레임을 포함해 ${points.length}프레임(${(first / 1e6).toFixed(2)}초~${(last / 1e6).toFixed(2)}초)을 자동으로 채웠습니다. 더 이어서 가려야 하면 그 지점에서 한 번 더 추가하세요.`,
        )
      } catch (cause) {
        if (cause instanceof JobCanceledError) setNotice('얼굴 추가를 취소했습니다.')
        else setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(null)
      }
    },
    [workFile, analysis, frameAt, trackProgress, manualSpanSec],
  )

  /** 지금 프레임에서 이 점을 덮고 있는 가림을 지운다. */
  const removeMaskAt = useCallback(
    (point: Point) => {
      const video = videoRef.current
      if (!plan || !video) return
      const boxes = (plan[frameAt(video.currentTime)] ?? []).filter(
        (box) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height,
      )
      // 겹쳐 있으면 가장 작은(가장 구체적인) 것을 지운다.
      const target = boxes.sort((a, b) => a.width * a.height - b.width * b.height)[0]
      if (!target) {
        setNotice('이 위치에는 가림이 없습니다.')
        return
      }
      setSaved(null)
      // 같은 얼굴이 여러 추적으로 끊겨 있어도 한 번에 지운다(이미 지운 것은 뺀다).
      const group =
        target.trackId < 0 || !analysis
          ? [target.trackId]
          : linkedTrackIds(analysis.tracks, target.trackId, analysis.timestampsUs).filter((id) => !edits.removedTrackIds.includes(id))
      setEdits((current) =>
        target.trackId < 0
          ? { ...current, manualTracks: current.manualTracks.filter((track) => track.id !== target.trackId) }
          : { ...current, removedTrackIds: [...current.removedTrackIds, ...group] },
      )
      if (target.trackId >= 0) setRemoveSizes((current) => [...current, group.length])
      setNotice(target.trackId < 0 ? '직접 추가한 얼굴을 지웠습니다.' : '이 얼굴의 가림을 이어지는 구간까지 지웠습니다. ‘삭제 되돌리기’로 되살릴 수 있습니다.')
    },
    [plan, frameAt, analysis, edits.removedTrackIds],
  )

  // 모자이크가 새로 생기는 프레임들. 이어지는 구간은 건너뛰고 시작 지점만 찾아간다.
  const maskStarts = useMemo(() => (plan ? maskStartFrames(plan) : []), [plan])
  const jumpToMaskStart = useCallback(
    (direction: 1 | -1) => {
      const video = videoRef.current
      if (!video || !info || !analysis) return
      video.pause()
      const here = frameAt(video.currentTime)
      const target =
        direction === 1 ? maskStarts.find((frame) => frame > here) : [...maskStarts].reverse().find((frame) => frame < here)
      if (target === undefined) {
        setNotice(direction === 1 ? '이 뒤로는 새로 생기는 모자이크가 없습니다.' : '이 앞으로는 새로 생기는 모자이크가 없습니다.')
        return
      }
      setNotice(null)
      // 프레임 시각보다 아주 조금 뒤로 맞춰야 그 프레임이 화면에 나온다.
      const time = Math.max(0, Math.min(info.durationSec, (analysis.timestampsUs[target] ?? 0) / 1e6 + 0.001))
      video.currentTime = time
      setCurrentTime(time)
    },
    [info, analysis, frameAt, maskStarts],
  )

  const finishPolygon = useCallback(() => {
    if (polygonDraft.length < 3) return
    setRegions((current) => [...current, polygonRegion(polygonDraft, drawExclude)])
    setPolygonDraft([])
    touchRegions()
  }, [polygonDraft, drawExclude, touchRegions])

  /** 한 프레임 앞·뒤로 옮긴다. */
  const stepFrame = useCallback(
    (direction: 1 | -1) => {
      const video = videoRef.current
      if (!video || !info) return
      video.pause()
      let target = video.currentTime + direction / Math.max(1, info.fps)
      if (analysis) {
        const next = analysis.timestampsUs[frameAt(video.currentTime) + direction]
        // 프레임 시각보다 아주 조금 뒤로 맞춰야 그 프레임이 화면에 나온다.
        if (next !== undefined) target = next / 1e6 + 0.001
      }
      target = Math.max(0, Math.min(info.durationSec, target))
      video.currentTime = target
      setCurrentTime(target)
    },
    [info, analysis, frameAt],
  )

  // 미리보기 위에 영역, 모자이크 예상 결과, 그리는 중인 도형을 그린다.
  useEffect(() => {
    const video = videoRef.current
    const overlay = overlayRef.current
    if (!video || !overlay || !info) return
    let handle = 0
    const scale = Math.min(1, 1280 / info.width)
    overlay.width = Math.round(info.width * scale)
    overlay.height = Math.round(info.height * scale)
    scratchRef.current ??= document.createElement('canvas')
    const scratch = scratchRef.current

    const draw = () => {
      handle = requestAnimationFrame(draw)
      const context = overlay.getContext('2d')
      const small = scratch.getContext('2d')
      if (!context || !small) return
      context.clearRect(0, 0, overlay.width, overlay.height)
      context.setLineDash([])

      const masks = analysis && plan && video.readyState >= 2 ? (plan[frameAt(video.currentTime)] ?? []) : []
      if (previewMode === 'mosaic') {
        for (const box of masks) {
          const cols = Math.max(1, Math.min(settings.blocksAcross, Math.round(box.width)))
          const rows = Math.max(1, Math.min(Math.round((cols * box.height) / box.width), Math.round(box.height)))
          scratch.width = cols
          scratch.height = rows
          small.imageSmoothingEnabled = true
          small.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, cols, rows)
          context.imageSmoothingEnabled = false
          context.drawImage(scratch, 0, 0, cols, rows, box.x * scale, box.y * scale, box.width * scale, box.height * scale)
        }
      }
      // 상자 보기이거나 가림을 지우는 중이면 가림 위치를 테두리로 보여 준다(직접 추가한 것은 분홍).
      if (previewMode === 'boxes' || tool === 'remove') {
        context.lineWidth = 2
        for (const box of masks) {
          context.strokeStyle = box.trackId < 0 ? '#e879f9' : '#facc15'
          context.strokeRect(box.x * scale, box.y * scale, box.width * scale, box.height * scale)
        }
      }

      context.lineWidth = 2
      context.font = 'bold 15px sans-serif'
      regions.forEach((region, index) => {
        const active = regionActive(region, video.currentTime)
        const color = region.exclude ? '#f87171' : '#2dd4bf'
        context.beginPath()
        if (region.shape.kind === 'rect') {
          const rect = region.shape.rect
          context.rect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale)
        } else {
          region.shape.points.forEach((point, position) => {
            if (position === 0) context.moveTo(point.x * scale, point.y * scale)
            else context.lineTo(point.x * scale, point.y * scale)
          })
          context.closePath()
        }
        // 지금 시각에 적용되지 않는 영역(구간 밖)은 점선으로만 보여 준다.
        context.setLineDash(active ? [] : [4, 6])
        if (active) {
          context.fillStyle = region.exclude ? 'rgba(179, 38, 30, 0.16)' : 'rgba(15, 118, 110, 0.12)'
          context.fill()
        }
        context.strokeStyle = color
        context.stroke()
        context.setLineDash([])
        const bounds = regionBounds(region)
        const label = `${index + 1}${region.exclude ? ' 제외' : ''}`
        const labelWidth = context.measureText(label).width + 14
        context.fillStyle = region.exclude ? '#b3261e' : '#0f766e'
        context.fillRect(bounds.x * scale, bounds.y * scale, labelWidth, 22)
        context.fillStyle = '#ffffff'
        context.fillText(label, bounds.x * scale + 7, bounds.y * scale + 16)
      })

      // 그리는 중인 도형
      const draft = draftRef.current
      if (draft) {
        const rect = rectFromPoints(draft.start, draft.current)
        context.setLineDash([8, 6])
        context.strokeStyle = tool === 'add-face' ? '#e879f9' : drawExclude ? '#f87171' : '#2dd4bf'
        context.strokeRect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale)
        context.setLineDash([])
      }
      if (polygonDraft.length > 0) {
        context.strokeStyle = drawExclude ? '#f87171' : '#2dd4bf'
        context.setLineDash([8, 6])
        context.beginPath()
        polygonDraft.forEach((point, position) => {
          if (position === 0) context.moveTo(point.x * scale, point.y * scale)
          else context.lineTo(point.x * scale, point.y * scale)
        })
        context.stroke()
        context.setLineDash([])
        context.fillStyle = '#ffffff'
        polygonDraft.forEach((point, position) => {
          context.beginPath()
          context.arc(point.x * scale, point.y * scale, position === 0 ? 7 : 4, 0, Math.PI * 2)
          context.fill()
          context.stroke()
        })
      }
    }
    handle = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(handle)
  }, [info, analysis, plan, regions, previewMode, tool, drawExclude, polygonDraft, frameAt, settings.blocksAcross])

  const pointerToSource = (event: React.PointerEvent<HTMLCanvasElement>): Point | null => {
    if (!info) return null
    const bounds = event.currentTarget.getBoundingClientRect()
    return displayToSource(
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      bounds.width,
      bounds.height,
      info.width,
      info.height,
    )
  }

  // 영역은 가림을 계산할 때 적용하므로, 얼굴을 찾는 동안에도 영역은 그리고 고칠 수 있다. 그 밖의 처리 중에는 잠근다.
  const regionLocked = busy !== null && busy.label !== FINDING_LABEL

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (regionLocked || !info) return
    const point = pointerToSource(event)
    if (!point) return
    if (tool === 'polygon') {
      const first = polygonDraft[0]
      // 꼭짓점이 3개 이상일 때 첫 점 근처를 다시 누르면 다각형을 닫는다.
      if (first && polygonDraft.length >= 3 && Math.hypot(first.x - point.x, first.y - point.y) < info.width * 0.02) finishPolygon()
      else setPolygonDraft((current) => [...current, point])
      return
    }
    if (tool === 'remove') {
      removeMaskAt(point)
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'move') {
      // 겹쳐 있으면 나중에 그린(위에 있는) 영역을 잡는다.
      const hit = [...regions].reverse().find((region) => regionContains(region, point))
      if (hit) moveRef.current = { id: hit.id, last: point }
      return
    }
    draftRef.current = { start: point, current: point }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointerToSource(event)
    if (!point || !info) return
    const moving = moveRef.current
    if (moving) {
      const dx = point.x - moving.last.x
      const dy = point.y - moving.last.y
      moving.last = point
      setRegions((current) => current.map((region) => (region.id === moving.id ? translateRegion(region, dx, dy, info.width, info.height) : region)))
      return
    }
    if (draftRef.current) draftRef.current.current = point
  }
  const onPointerUp = () => {
    if (moveRef.current) {
      moveRef.current = null
      touchRegions()
      return
    }
    const draft = draftRef.current
    draftRef.current = null
    if (!draft || !info) return
    const rect = rectFromPoints(draft.start, draft.current)
    if (tool === 'add-face') {
      // 얼굴 상자는 작을 수 있으므로 아주 작은 것(실수로 찍힌 점)만 걸러 낸다.
      if (rect.width >= 6 && rect.height >= 6) void addFace(rect)
      return
    }
    if (rect.width < info.width * MIN_REGION_RATIO || rect.height < info.height * MIN_REGION_RATIO) return
    setRegions((current) => [...current, rectRegion(rect, drawExclude)])
    touchRegions()
  }

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }

  const fraction = busy?.progress?.fraction ?? 0
  const elapsedSec = busy ? (performance.now() - busy.startedAt) / 1000 : 0
  const remainingSec = busy && fraction > 0.03 ? (elapsedSec * (1 - fraction)) / fraction : null
  const progressBlock = busy ? (
    <div>
      <p className="progress-label">
        {busy.label} · {(fraction * 100).toFixed(0)}%
        {busy.progress?.fps != null && busy.phase !== 'split' ? ` · 초당 ${busy.progress.fps.toFixed(1)}장` : ''}
        {remainingSec !== null ? ` · 남은 시간 약 ${formatDuration(remainingSec)}` : ' · 남은 시간 계산 중'}
      </p>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <div style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
      </div>
      <p className="muted">처리 중에는 이 탭을 닫지 마세요.</p>
    </div>
  ) : null

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">영상 얼굴 모자이크</p>
          <h1>얼굴을 자동으로 찾아 가립니다</h1>
          <p className="lede">영상을 불러오고 가릴 영역을 그리면, 그 안의 얼굴을 찾아 모자이크한 새 MP4 파일로 저장합니다.</p>
        </div>
        <span className="badge">영상은 이 컴퓨터에서만 처리됩니다</span>
      </header>

      <GuidePanel />

      <SpecPanel
        checking={specChecking}
        judgement={judgement}
        failure={specFailure}
        proceeding={proceeding}
        lowSpecMode={lowSpecMode}
        appUrl={`${window.location.origin}${window.location.pathname}`}
        onProceed={acceptSpec}
        onRecheck={() => {
          setAccepted('none')
          void runSpecCheck()
        }}
        onDownloadProject={downloadProject}
      />

      {canWork || info ? (
      <section className="panel">
        <h2>1. 영상 불러오기</h2>
        <label
          className={`dropzone${dragOver ? ' over' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragOver(false)
            const dropped = event.dataTransfer.files[0]
            if (dropped && !busy) void openFile(dropped)
          }}
        >
          <input
            type="file"
            accept={ACCEPT}
            disabled={busy !== null}
            onChange={(event) => {
              const chosen = event.target.files?.[0]
              event.target.value = ''
              if (chosen) void openFile(chosen)
            }}
          />
          <strong>여기에 영상 파일을 끌어다 놓거나 눌러서 고르세요</strong>
          <span className="muted">
            MP4 · MOV · WebM 은 바로 열고, AVI · MKV · WMV · MTS 등은 자동으로 변환한 뒤 엽니다. 원본 파일은 바뀌지 않습니다.
          </span>
        </label>
        {busy?.phase === 'convert' ? (
          <>
            {progressBlock}
            <div className="actions">
              <button type="button" className="ghost" onClick={cancelJob}>취소</button>
            </div>
          </>
        ) : null}
        {convertedNote ? <p className="muted">{convertedNote}</p> : null}
        {info ? (
          <dl className="facts">
            <div><dt>파일</dt><dd>{info.name}</dd></div>
            <div><dt>길이</dt><dd>{formatDuration(info.durationSec)}</dd></div>
            <div><dt>해상도</dt><dd>{info.width} × {info.height}{info.rotation ? ` (회전 ${info.rotation}°)` : ''}</dd></div>
            <div><dt>초당 프레임</dt><dd>{info.fps.toFixed(2)}</dd></div>
            <div><dt>코덱</dt><dd>{info.videoCodec ?? '알 수 없음'}{info.hasAudio ? ` + ${info.audioCodec ?? '소리'}` : ' (소리 없음)'}</dd></div>
            <div><dt>용량</dt><dd>{formatBytes(info.sizeBytes)}</dd></div>
          </dl>
        ) : null}
        <div className="actions">
          <label className="file-button">
            <input
              type="file"
              accept="application/json,.json"
              disabled={busy !== null}
              onChange={(event) => {
                const chosen = event.target.files?.[0]
                event.target.value = ''
                if (chosen) void importProject(chosen)
              }}
            />
            프로젝트 파일 불러오기
          </label>
          <button type="button" className="ghost" onClick={downloadProject} disabled={busy !== null}>
            프로젝트 파일 저장
          </button>
          <span className="muted">영역과 설정을 파일로 저장해 다른 컴퓨터에서 이어서 작업할 수 있습니다.</span>
        </div>
        {!info && notice ? <p className="muted">{notice}</p> : null}
      </section>
      ) : null}

      {canWork && info && videoUrl ? (
        <section className="panel">
          <h2>2. 가릴 영역 그리기</h2>
          <p className="muted">
            얼굴의 중심이 영역 안에 있으면 가립니다. 영역을 그리지 않으면 화면 전체가 대상입니다. 얼굴을 찾은 뒤에는 여기서 재생하며 빠진 얼굴을 추가하거나 잘못 가려진 곳을 지울 수 있습니다.
          </p>
          <div className="tools" role="toolbar" aria-label="미리보기 도구">
            {TOOLS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`tool${tool === item.id ? ' on' : ''}`}
                aria-pressed={tool === item.id}
                disabled={regionLocked || (item.needsAnalysis && !analysis)}
                title={item.needsAnalysis && !analysis ? '먼저 ‘얼굴 찾기’를 해야 쓸 수 있습니다' : item.help}
                onClick={() => {
                  setTool(item.id)
                  setPolygonDraft([])
                  draftRef.current = null
                }}
              >
                {item.label}
              </button>
            ))}
            {tool === 'rect' || tool === 'polygon' ? (
              <label className="inline-check">
                <input type="checkbox" checked={drawExclude} onChange={(event) => setDrawExclude(event.target.checked)} />
                제외 영역으로 그리기 (이 안의 얼굴은 가리지 않음)
              </label>
            ) : null}
            {tool === 'add-face' ? (
              <label className="inline-check">
                앞뒤로 따라갈 시간
                <input
                  type="number"
                  className="span-input"
                  aria-label="얼굴 추가 때 앞뒤로 따라갈 시간(초)"
                  min={MANUAL_SPAN_MIN_SEC}
                  max={MANUAL_SPAN_MAX_SEC}
                  step={1}
                  value={manualSpanSec}
                  disabled={regionLocked}
                  onChange={(event) => {
                    const value = Math.round(Number(event.target.value))
                    if (Number.isFinite(value)) setManualSpanSec(Math.max(MANUAL_SPAN_MIN_SEC, Math.min(MANUAL_SPAN_MAX_SEC, value)))
                  }}
                />
                초 (표시한 곳에서 앞으로·뒤로 각각)
              </label>
            ) : null}
            {tool === 'polygon' && polygonDraft.length > 0 ? (
              <>
                <button type="button" className="ghost" disabled={polygonDraft.length < 3} onClick={finishPolygon}>
                  다각형 완성 ({polygonDraft.length}점)
                </button>
                <button type="button" className="ghost" onClick={() => setPolygonDraft([])}>
                  그리기 취소
                </button>
              </>
            ) : null}
          </div>
          <p className="muted tool-help">{TOOLS.find((item) => item.id === tool)?.help}</p>
          <div className="stage">
            <video
              ref={videoRef}
              src={videoUrl}
              playsInline
              preload="auto"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
            />
            <canvas
              ref={overlayRef}
              className={`stage-overlay tool-${tool}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                draftRef.current = null
                moveRef.current = null
              }}
            />
          </div>
          <div className="transport">
            <button type="button" className="ghost" onClick={togglePlay} disabled={regionLocked}>
              {playing ? '일시정지' : '재생'}
            </button>
            <HoldButton className="ghost" aria-label="한 프레임 뒤로" title="누르고 있으면 빠르게 넘어갑니다" onStep={() => stepFrame(-1)} disabled={regionLocked}>
              ◀ 1프레임
            </HoldButton>
            <HoldButton className="ghost" aria-label="한 프레임 앞으로" title="누르고 있으면 빠르게 넘어갑니다" onStep={() => stepFrame(1)} disabled={regionLocked}>
              1프레임 ▶
            </HoldButton>
            {analysis ? (
              <>
                <button
                  type="button"
                  className="ghost"
                  aria-label="이전 모자이크 시작 지점"
                  title="모자이크가 새로 생기는 바로 앞 지점으로 이동(이어지는 구간은 건너뜀)"
                  onClick={() => jumpToMaskStart(-1)}
                  disabled={regionLocked || maskStarts.length === 0}
                >
                  ⏮ 이전 모자이크
                </button>
                <button
                  type="button"
                  className="ghost"
                  aria-label="다음 모자이크 시작 지점"
                  title="모자이크가 새로 생기는 다음 지점으로 이동(이어지는 구간은 건너뜀)"
                  onClick={() => jumpToMaskStart(1)}
                  disabled={regionLocked || maskStarts.length === 0}
                >
                  다음 모자이크 ⏭
                </button>
              </>
            ) : null}
            <input
              type="range"
              aria-label="재생 위치"
              min={0}
              max={info.durationSec}
              step={0.01}
              value={currentTime}
              onChange={(event) => {
                const time = Number(event.target.value)
                setCurrentTime(time)
                if (videoRef.current) videoRef.current.currentTime = time
              }}
            />
            <span className="muted">
              {formatDuration(currentTime)} / {formatDuration(info.durationSec)}
              {analysis ? ` · ${frameAt(currentTime) + 1}/${analysis.frameCount}프레임` : ''}
              {analysis && maskStarts.length > 0
                ? ` · 모자이크 시작 ${maskStarts.filter((frame) => frame <= frameAt(currentTime)).length}/${maskStarts.length}`
                : ''}
            </span>
          </div>

          {regions.length === 0 ? <span className="chip">영역: 화면 전체</span> : null}
          {regions.length > 0 ? (
            <ul className="region-list">
              {regions.map((region, index) => (
                <li className="region-row" key={region.id}>
                  <strong>영역 {index + 1}</strong>
                  <span className="muted">{region.shape.kind === 'rect' ? '사각형' : `다각형 ${region.shape.points.length}점`}</span>
                  <label className="inline-check">
                    <input
                      type="checkbox"
                      checked={region.exclude}
                      disabled={regionLocked}
                      onChange={(event) => updateRegion(region.id, { exclude: event.target.checked })}
                    />
                    제외
                  </label>
                  <label className="range-field">
                    시작(초)
                    <input
                      type="number"
                      min={0}
                      max={info.durationSec}
                      step={0.1}
                      placeholder="처음"
                      value={region.startSec ?? ''}
                      disabled={regionLocked}
                      onChange={(event) => updateRegion(region.id, { startSec: event.target.value === '' ? null : Number(event.target.value) })}
                    />
                  </label>
                  <label className="range-field">
                    끝(초)
                    <input
                      type="number"
                      min={0}
                      max={info.durationSec}
                      step={0.1}
                      placeholder="끝"
                      value={region.endSec ?? ''}
                      disabled={regionLocked}
                      onChange={(event) => updateRegion(region.id, { endSec: event.target.value === '' ? null : Number(event.target.value) })}
                    />
                  </label>
                  <button type="button" className="ghost small" disabled={regionLocked} onClick={() => updateRegion(region.id, { startSec: Number(currentTime.toFixed(2)) })}>
                    지금부터
                  </button>
                  <button type="button" className="ghost small" disabled={regionLocked} onClick={() => updateRegion(region.id, { endSec: Number(currentTime.toFixed(2)) })}>
                    지금까지
                  </button>
                  <button
                    type="button"
                    className="ghost small"
                    aria-label={`영역 ${index + 1} 삭제`}
                    disabled={regionLocked}
                    onClick={() => {
                      setRegions((current) => current.filter((item) => item.id !== region.id))
                      touchRegions()
                    }}
                  >
                    삭제
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="actions">
            {regions.length > 0 ? (
              <button
                type="button"
                className="ghost"
                disabled={regionLocked}
                onClick={() => {
                  setRegions([])
                  touchRegions()
                }}
              >
                영역 모두 지우기
              </button>
            ) : null}
            {edits.manualTracks.length > 0 ? (
              <>
                <span className="chip">직접 추가한 얼굴 {edits.manualTracks.length}개</span>
                <button
                  type="button"
                  className="ghost"
                  disabled={regionLocked}
                  onClick={() => {
                    setEdits((current) => ({ ...current, manualTracks: current.manualTracks.slice(0, -1) }))
                    setSaved(null)
                  }}
                >
                  마지막 추가 취소
                </button>
              </>
            ) : null}
            {edits.removedTrackIds.length > 0 ? (
              <>
                <span className="chip">지운 가림 {removeSizes.length || edits.removedTrackIds.length}개</span>
                <button
                  type="button"
                  className="ghost"
                  disabled={regionLocked}
                  onClick={() => {
                    const size = removeSizes[removeSizes.length - 1] ?? 1
                    setEdits((current) => ({ ...current, removedTrackIds: current.removedTrackIds.slice(0, -size) }))
                    setRemoveSizes((current) => current.slice(0, -1))
                    setSaved(null)
                  }}
                >
                  삭제 되돌리기
                </button>
              </>
            ) : null}
          </div>
          {busy && busy.label.startsWith('추가한 얼굴') ? progressBlock : null}
        </section>
      ) : null}

      {canWork && info ? (
        <section className="panel">
          <h2>3. 얼굴 찾기와 저장</h2>
          {lowSpecMode ? (
            <p className="verdict caution">
              <strong>저사양 모드</strong> 찾는 정도를 "빠르게"로 낮췄습니다. 작은 얼굴을 놓칠 수 있으니 저장 전에 미리보기로 꼭 확인하세요.
            </p>
          ) : null}
          <div className="settings">
            <label>
              찾는 정도
              <select
                value={sensitivity}
                disabled={busy !== null}
                onChange={(event) => {
                  setSensitivity(event.target.value as Sensitivity)
                  invalidate()
                }}
              >
                {(Object.keys(SENSITIVITY_PRESETS) as Sensitivity[]).map((key) => (
                  <option key={key} value={key}>{SENSITIVITY_PRESETS[key].label}</option>
                ))}
              </select>
            </label>
            <label>
              얼굴 주변 여유 {marginPercent}%
              <input
                type="range"
                min={10}
                max={60}
                step={5}
                value={marginPercent}
                disabled={busy !== null}
                onChange={(event) => setMarginPercent(Number(event.target.value))}
              />
            </label>
            <label>
              얼굴이 아닌 것 거르기
              <select
                value={falsePositiveFilter}
                disabled={busy !== null}
                onChange={(event) => {
                  setFalsePositiveFilter(event.target.value as FalsePositiveFilter)
                  setSaved(null)
                }}
              >
                {(Object.keys(FALSE_POSITIVE_LABELS) as FalsePositiveFilter[]).map((key) => (
                  <option key={key} value={key}>{FALSE_POSITIVE_LABELS[key]}</option>
                ))}
              </select>
            </label>
            <label>
              저장 화질
              <select value={quality} disabled={busy !== null} onChange={(event) => setQuality(event.target.value as OutputQuality)}>
                {(Object.keys(QUALITY_LABELS) as OutputQuality[]).map((key) => (
                  <option key={key} value={key}>{QUALITY_LABELS[key]}</option>
                ))}
              </select>
            </label>
          </div>

          <SplitPanel
            choice={splitChoice}
            count={splitCount}
            maxMb={splitMaxMb}
            pieces={pieces}
            statuses={pieceStatus}
            disabled={busy !== null}
            recommendation={splitRecommendation}
            error={splitError}
            onChoice={(choice) => {
              setSplitChoice(choice)
              resetSplit()
            }}
            onCount={(value) => {
              setSplitCount(value)
              resetSplit()
            }}
            onMaxMb={(value) => {
              setSplitMaxMb(value)
              resetSplit()
            }}
            onPreview={() => void previewSplit()}
            onSplitOnly={() => void runSplitOnly()}
            onResetStatuses={() => {
              doneRangesRef.current = []
              setPieceStatus({})
            }}
          />

          <div className="actions">
            <button type="button" onClick={() => void runAnalysis()} disabled={busy !== null}>
              {analysis ? '얼굴 다시 찾기' : '얼굴 찾기'}
            </button>
            <button type="button" onClick={() => void runSave()} disabled={busy !== null || !analysis || (splitChoice !== 'none' && !pieces)}>
              {splitChoice !== 'none' && pieces ? `조각 ${pieces.length}개로 모자이크 영상 저장` : '모자이크 영상 저장'}
            </button>
            {busy ? (
              <button type="button" className="ghost" onClick={cancelJob}>
                취소
              </button>
            ) : null}
            {analysis ? (
              <label className="inline-check">
                미리보기
                <select value={previewMode} onChange={(event) => setPreviewMode(event.target.value as 'mosaic' | 'boxes' | 'off')}>
                  <option value="mosaic">모자이크 결과</option>
                  <option value="boxes">가릴 위치(상자)</option>
                  <option value="off">원본 그대로</option>
                </select>
              </label>
            ) : null}
          </div>

          <p className="muted">영상을 열면 얼굴을 자동으로 찾습니다. 찾는 정도를 바꾸면 다시 찾습니다.</p>
          {splitChoice !== 'none' && !pieces ? <p className="muted">나눠서 저장하려면 먼저 ‘나누기 미리보기’를 눌러 조각을 확인하세요.</p> : null}
          {progressBlock}

          {analysis && !busy ? (
            <p className="result">
              얼굴 {faceCount}개를 찾았습니다(같은 얼굴은 하나로 셈).
              {rejectedCount > 0 ? ` 얼굴이 아닌 것으로 보이는 ${rejectedCount}개는 뺐습니다.` : ''} 전체 {analysis.frameCount}프레임 중 {maskedFrames}프레임에 모자이크가 들어갑니다.
              {outsideCount > 0 ? ' 영역 밖 얼굴은 가리지 않습니다.' : ''} 위 미리보기에서 재생하며 빠진 얼굴은 ‘얼굴 추가’로, 잘못 가려진 곳은 ‘가림 삭제’로 고친 뒤 저장하세요.
            </p>
          ) : null}
          {analysis && !busy && faceCount === 0 ? (
            <p className="alert">얼굴을 하나도 찾지 못했습니다. 영역을 넓히거나 ‘찾는 정도’를 높여 다시 찾아보세요.</p>
          ) : null}
          {saved ? (
            <p className="result">
              <strong>{saved.name}</strong> 저장을 마쳤습니다({saved.stats.frames}프레임, {formatDuration(saved.stats.elapsedMs / 1000)} 걸림
              {saved.stats.bytes > 0 ? `, ${formatBytes(saved.stats.bytes)}` : ''}).
              {saved.stats.audioTracksIn > 0 && saved.stats.audioTracksOut === 0 ? ' 소리는 옮기지 못했습니다.' : ''} 올리기 전에 결과 영상을 처음부터 끝까지 꼭 확인하세요.
            </p>
          ) : null}
          {notice ? <p className="muted">{notice}</p> : null}
          {error ? <p className="alert">{error}</p> : null}
          {!window.showSaveFilePicker ? (
            <p className="muted">이 브라우저는 큰 파일을 디스크에 바로 쓰는 기능이 없어 결과를 메모리에 모았다가 내려받습니다. 긴 영상은 크롬·엣지·웨일에서 작업하세요.</p>
          ) : null}
        </section>
      ) : null}

      {error && !info ? <p className="alert">{error}</p> : null}
      <p className="foot">영상과 얼굴 정보는 서버로 보내지 않습니다. 모든 처리는 이 브라우저 안에서만 이뤄집니다.</p>
    </main>
  )
}
