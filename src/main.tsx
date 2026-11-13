import { createRoot } from 'react-dom/client'
import MosaicApp from './mvp/MosaicApp'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('#root 요소를 찾지 못했습니다')
}
const root = createRoot(container)

// 기본 화면은 모자이크 앱. `?e2e` 는 자동 검증용 빈 화면이다.
// `?bench`(1단계 검출 모델 비교 화면)는 개발 서버에서만 열린다. 배포본에는 비교용 모델·시험 자료가 들어가지 않는다.
const params = new URLSearchParams(window.location.search)

async function start(): Promise<void> {
  if (import.meta.env.DEV) {
    const { installBenchApi } = await import('./harness/bench-api')
    installBenchApi()
    if (params.has('bench')) {
      const { default: BenchApp } = await import('./App')
      root.render(<BenchApp />)
      return
    }
  }
  if (!params.has('e2e')) root.render(<MosaicApp />)
}
void start()

// 오프라인에서도 열리도록 앱 파일을 이 컴퓨터에 저장해 둔다(PWA). 배포본에서만 켠다.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined)
  })
}
