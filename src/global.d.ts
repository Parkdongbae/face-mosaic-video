import type { BenchApi } from './harness/bench-api'

declare global {
  interface SaveFilePickerOptions {
    suggestedName?: string
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
  }

  interface Window {
    __mosaicBench?: BenchApi
    /** File System Access API. 크롬·엣지·웨일에만 있다. */
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
    /** 폴더를 골라 그 안에 여러 파일을 쓴다(분할 조각 저장용). */
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
  }
}

export {}
