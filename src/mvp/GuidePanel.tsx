import { useEffect, useState } from 'react'
import licensesText from '../../LICENSES.md?raw'

const SEEN_KEY = 'mosaic-guide-seen'

type OfflineState = 'unsupported' | 'dev' | 'installing' | 'ready'

function readSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

function writeSeen(seen: boolean): void {
  try {
    if (seen) window.localStorage.setItem(SEEN_KEY, '1')
    else window.localStorage.removeItem(SEEN_KEY)
  } catch {
    // 저장이 막힌 환경이면 다음에도 펼쳐진 채로 보일 뿐이다.
  }
}

/** 오프라인 사용 준비 상태(서비스 워커가 앱 파일을 모두 저장했는지) */
function useOfflineState(): OfflineState {
  const [state, setState] = useState<OfflineState>(() =>
    !('serviceWorker' in navigator) ? 'unsupported' : import.meta.env.PROD ? 'installing' : 'dev',
  )
  useEffect(() => {
    if (state !== 'installing') return
    let alive = true
    // ready 는 서비스 워커가 설치(= 모든 파일 저장)를 마치고 켜졌을 때 풀린다.
    void navigator.serviceWorker.ready.then(() => {
      if (alive) setState('ready')
    })
    return () => {
      alive = false
    }
  }, [state])
  return state
}

const OFFLINE_TEXT: Record<OfflineState, string> = {
  ready: '오프라인 준비 완료 — 인터넷이 끊겨도 이 주소로 앱을 열 수 있습니다.',
  installing: '오프라인용 파일을 이 컴퓨터에 저장하는 중입니다(처음 한 번, 약 70MB).',
  dev: '개발 서버에서는 오프라인 저장을 켜지 않습니다.',
  unsupported: '이 브라우저는 오프라인 저장을 지원하지 않습니다.',
}

/** 사용 안내 화면. 처음에는 펼쳐져 있고, 한 번 접으면 다음부터는 접힌 채로 나온다. */
export function GuidePanel() {
  const [open, setOpen] = useState(() => !readSeen())
  const offline = useOfflineState()
  const [showLicenses, setShowLicenses] = useState(false)

  return (
    <details
      className="panel guide"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open
        setOpen(next)
        writeSeen(!next)
      }}
    >
      <summary>사용 안내 {open ? '' : '(눌러서 펼치기)'}</summary>
      <ol className="guide-steps">
        <li>
          <strong>사양 점검</strong> 앱을 열면 약 10초 동안 이 컴퓨터로 처리할 수 있는지 확인합니다. ‘부적합’이 나오면 안내에 따라 다른 컴퓨터에서 여세요.
        </li>
        <li>
          <strong>영상 불러오기</strong> 파일을 끌어다 놓거나 눌러서 고릅니다. MP4·MOV·WebM 은 바로 열리고, AVI·MKV·WMV·MTS 등은 변환 기능이 설치된 경우 자동으로 변환한 뒤 열립니다.
        </li>
        <li>
          <strong>영역 그리기</strong> 얼굴을 가릴 곳을 사각형이나 다각형으로 그립니다. 그리지 않으면 화면 전체가 대상입니다. 교사 자리처럼 가리지 않을 곳은 ‘제외 영역’으로 그립니다.
        </li>
        <li>
          <strong>얼굴 찾기</strong> 영상을 열면 자동으로 영상 전체에서 얼굴을 찾습니다(누를 필요 없음). 영역은 나중에 바꿔도 다시 찾지 않아도 됩니다.
        </li>
        <li>
          <strong>검토</strong> 미리보기를 재생하거나 한 프레임씩 넘기며 확인합니다. ‘다음 모자이크’를 누르면 모자이크가 새로 생기는 곳으로 바로 건너뜁니다. 빠진 얼굴은 ‘얼굴 추가’로 한 번 표시하면 앞뒤가 자동으로 채워지고, 잘못 가려진 곳은 ‘가림 삭제’로 지웁니다.
        </li>
        <li>
          <strong>저장</strong> ‘모자이크 영상 저장’을 누르면 새 MP4 파일(원본이름_mosaic.mp4)로 저장합니다. 원본 파일은 바뀌지 않습니다.
        </li>
      </ol>
      <ul className="guide-notes">
        <li>
          <strong>영상은 밖으로 나가지 않습니다.</strong> 모든 처리는 이 브라우저 안에서만 이뤄지며, 영상·얼굴 정보를 서버로 보내지 않습니다.
        </li>
        <li>
          <strong>올리기 전에 꼭 직접 확인하세요.</strong> 자동 검출은 작은 얼굴, 옆얼굴, 누운 얼굴, 마스크 쓴 얼굴을 놓칠 수 있습니다. 결과 영상을 처음부터 끝까지 본 뒤 게시하세요.
        </li>
        <li>
          <strong>긴 영상</strong>은 ‘영상 나누기’로 조각내어 저장하면 중간에 멈춰도 끝난 조각이 남습니다. 처리 중에는 이 탭을 닫지 마세요.
        </li>
        <li>크롬·엣지·웨일 최신 버전의 데스크톱·노트북에서 쓰세요. 휴대폰·태블릿에서는 처리할 수 없습니다.</li>
        <li>
          {OFFLINE_TEXT[offline]} ·{' '}
          <button type="button" className="link" aria-expanded={showLicenses} onClick={() => setShowLicenses((current) => !current)}>
            오픈소스 라이선스 {showLicenses ? '접기' : '보기'}
          </button>
        </li>
      </ul>
      {showLicenses ? <pre className="licenses">{licensesText}</pre> : null}
    </details>
  )
}
