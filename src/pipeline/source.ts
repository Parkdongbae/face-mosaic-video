import { ALL_FORMATS, BlobSource, Input, MP4, QTFF, WEBM } from 'mediabunny'
import { clearIntermediates, convertToMp4, type ConvertHooks, type ConvertResult } from './convert'

/** fast: 브라우저가 바로 해독(WebCodecs) / convert: ffmpeg.wasm 으로 H.264 MP4 로 바꾼 뒤 처리 */
export type SourceRoute = 'fast' | 'convert'

/**
 * 변환 경로로 한 번에 처리할 수 있는 최대 용량. ffmpeg.wasm 은 결과를 메모리에 만들기 때문에
 * 약 2GB 가 한계다(glm.md 3-5). 여유를 두고 1.5GB 로 잡았다(초안).
 */
export const CONVERT_MAX_BYTES = 1.5 * 1024 ** 3

/** 파일 내용을 보고 처리 경로를 고른다(확장자가 아니라 실제 형식·코덱 기준). */
export async function classifySource(file: Blob): Promise<SourceRoute> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  try {
    if (!(await input.canRead())) return 'convert'
    const format = await input.getFormat()
    // PRD 의 빠른 경로: MP4·M4V·MOV·WebM. MKV·TS 등은 읽을 수 있어도 소리 코덱 때문에 변환 경로로 보낸다.
    if (format !== MP4 && format !== QTFF && format !== WEBM) return 'convert'
    const video = await input.getPrimaryVideoTrack()
    if (!video) return 'convert'
    return (await video.canDecode()) ? 'fast' : 'convert'
  } catch {
    return 'convert'
  } finally {
    input.dispose()
  }
}

export interface PreparedSource {
  route: SourceRoute
  /** 실제로 분석·저장에 쓰는 파일. 빠른 경로면 원본 그대로, 변환 경로면 중간 MP4. */
  workFile: File
  conversion: ConvertResult | null
}

/** 원본을 처리할 수 있는 형태로 준비한다. 필요할 때만 ffmpeg.wasm 을 읽어 변환한다. 원본은 바꾸지 않는다. */
export async function prepareSource(file: File, hooks: ConvertHooks = {}): Promise<PreparedSource> {
  await clearIntermediates()
  const route = await classifySource(file)
  if (route === 'fast') return { route, workFile: file, conversion: null }
  if (file.size > CONVERT_MAX_BYTES) {
    throw new Error(
      `이 형식은 먼저 변환해야 하는데, 한 번에 변환할 수 있는 크기(약 ${(CONVERT_MAX_BYTES / 1024 ** 3).toFixed(1)}GB)를 넘습니다. 다른 프로그램으로 MP4 로 바꾸거나 영상을 나눈 뒤 불러와 주세요.`,
    )
  }
  const conversion = await convertToMp4(file, null, hooks)
  return { route, workFile: conversion.file, conversion }
}
