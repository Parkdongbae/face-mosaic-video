import { useEffect, useState, type ReactNode } from 'react'
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

/** 사용 순서. 단계마다 제목, 한 줄 요약, 자세한 설명을 둔다. */
const STEPS: Array<{ title: string; summary: string; details: string[] }> = [
  {
    title: '사양 점검',
    summary: '앱을 열면 약 10초 동안 이 컴퓨터로 처리할 수 있는지 확인합니다.',
    details: [
      '‘적합’이면 바로 다음 단계로 넘어갑니다.',
      '‘주의’면 처리는 되지만 오래 걸릴 수 있습니다. ‘계속 진행’을 누르면 이어집니다.',
      '‘부적합’이면 다른 컴퓨터에서 여는 것이 좋습니다. 화면의 QR 코드나 주소로 다른 컴퓨터에서 열 수 있습니다. 그래도 진행하면 얼굴을 드문드문 확인해 빠르게 찾는 저사양 모드로 바뀝니다.',
    ],
  },
  {
    title: '영상 불러오기',
    summary: '파일을 끌어다 놓거나 눌러서 고릅니다. 불러오면 얼굴 찾기가 자동으로 시작됩니다.',
    details: [
      'MP4·MOV·WebM 은 바로 열립니다. AVI·MKV·WMV·MTS 등은 변환 기능이 설치된 경우에만 자동으로 변환한 뒤 열립니다.',
      '전에 저장해 둔 프로젝트 파일(.json)이 있으면 ‘프로젝트 불러오기’로 영역과 설정을 되살릴 수 있습니다.',
      '원본 파일은 읽기만 하고 바꾸지 않습니다.',
    ],
  },
  {
    title: '영역 그리기 (선택)',
    summary: '얼굴을 가릴 범위를 정합니다. 그리지 않으면 화면 전체의 얼굴을 가립니다.',
    details: [
      '‘사각형 영역’은 화면에서 끌어서, ‘다각형 영역’은 꼭짓점을 차례로 눌러서 그립니다.',
      '‘제외 영역으로 그리기’를 켜고 그리면, 그 안의 얼굴은 가리지 않습니다(예: 교사 자리).',
      '영역 목록에서 영역마다 적용할 시간(시작·끝 초)을 정할 수 있습니다. ‘지금부터’·‘지금까지’를 누르면 현재 재생 위치가 들어갑니다.',
      '‘영역 옮기기’로 그려 둔 영역을 끌어서 옮길 수 있습니다.',
      '영역은 얼굴을 찾는 중에도, 찾은 뒤에도 바꿀 수 있습니다. 바꿔도 얼굴을 다시 찾지 않습니다.',
    ],
  },
  {
    title: '얼굴 찾기',
    summary: '영상을 열면 누르지 않아도 영상 전체에서 얼굴을 찾습니다. 진행률과 남은 시간이 표시됩니다.',
    details: [
      '‘찾는 정도’를 바꾸면 자동으로 다시 찾습니다. ‘꼼꼼하게’는 고개를 숙이거나 돌린 얼굴, 아주 작은 얼굴까지 더 찾지만 느립니다. 학생이 많은 교실 영상에는 ‘꼼꼼하게’를 권합니다.',
      '얼굴이 잠깐 안 잡혀도(고개를 숙이거나 돌릴 때) 같은 자리에서 3초 안에 다시 잡히면 그 사이도 계속 가립니다.',
      '‘얼굴이 아닌 것 거르기’는 옷깃·무늬처럼 얼굴이 아닌데 잡힌 것을 뺍니다. 바꾸면 미리보기에 바로 반영됩니다. ‘강하게’는 옆얼굴을 놓칠 수 있습니다.',
      '‘얼굴 주변 여유’를 키우면 모자이크가 얼굴보다 더 넓게 들어갑니다.',
      '취소한 뒤 다시 찾으려면 ‘얼굴 찾기’ 버튼을 누릅니다.',
    ],
  },
  {
    title: '검토와 수정',
    summary: '미리보기에서 모자이크가 빠진 얼굴과 잘못 들어간 모자이크를 찾아 고칩니다.',
    details: [
      '영상 바로 밑의 재생바를 끌거나 ‘재생’을 눌러 확인합니다. ‘◀ 1프레임’·‘1프레임 ▶’은 한 장씩 넘기고, 누르고 있으면 빠르게 넘어갑니다.',
      '‘다음 모자이크’·‘이전 모자이크’는 모자이크가 새로 생기는 지점으로 바로 건너뜁니다. 이어지는 구간은 넘어가므로 잘못 들어간 모자이크를 빨리 찾을 수 있습니다.',
      '빠진 얼굴: ‘얼굴 추가’를 누르고 얼굴 위에 상자를 그리면, 앞뒤 프레임을 따라가며 자동으로 채웁니다. 따라갈 시간(기본 5초)은 도구 옆에서 바꿀 수 있습니다.',
      '잘못 들어간 모자이크: ‘가림 삭제’를 누르고 그 상자를 누르면, 이어지는 구간까지 한 번에 지워집니다. ‘삭제 되돌리기’로 되살릴 수 있습니다.',
      '미리보기 방식은 ‘모자이크 결과’, ‘가릴 위치(상자)’, ‘원본 그대로’ 중에서 고를 수 있습니다.',
    ],
  },
  {
    title: '저장',
    summary: '‘모자이크 영상 저장’을 누르면 새 MP4 파일(원본이름_mosaic.mp4)로 저장합니다.',
    details: [
      '저장할 위치를 고르면 영상을 처음부터 다시 읽으며 모자이크를 넣어 저장합니다. 소리는 그대로 유지됩니다.',
      '긴 영상은 ‘영상 나누기’에서 개수나 용량을 정하고 ‘나누기 미리보기’를 누른 뒤 저장하면 조각별로 저장됩니다. 중간에 멈춰도 끝난 조각은 남습니다.',
      '‘프로젝트 저장’을 누르면 영역·설정·직접 추가한 얼굴을 파일로 남겨 나중에 이어서 작업할 수 있습니다.',
      '저장이 끝나면 결과 영상을 처음부터 끝까지 직접 확인하세요.',
    ],
  },
]

/** 자주 묻는 질문 */
const FAQ: Array<{ question: string; answer: ReactNode }> = [
  {
    question: '‘사각형 영역’과 ‘얼굴 추가’는 서로 다른 기능인가요?',
    answer: (
      <>
        <p>
          네, 다릅니다. <strong>사각형 영역</strong>은 “어디에서 얼굴을 가릴지” 범위를 정하는 것이고, <strong>얼굴 추가</strong>는 “이 얼굴을 가려라” 하고 모자이크를 직접 넣는 것입니다.
        </p>
        <table>
          <thead>
            <tr>
              <th></th>
              <th>사각형 영역</th>
              <th>얼굴 추가</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>하는 일</th>
              <td>자동으로 찾은 얼굴 중 이 범위 안에 있는 것만 가리도록 제한</td>
              <td>자동으로 못 찾은 얼굴에 모자이크를 직접 넣음</td>
            </tr>
            <tr>
              <th>모자이크</th>
              <td>영역 자체에는 생기지 않고, 그 안에서 찾은 얼굴에만 생김</td>
              <td>그린 상자 자리에 바로 생김</td>
            </tr>
            <tr>
              <th>적용 시간</th>
              <td>영상 전체(또는 정한 구간) 동안 화면의 같은 자리</td>
              <td>표시한 프레임과 그 앞뒤 정한 시간(기본 5초). 얼굴을 따라 움직임</td>
            </tr>
            <tr>
              <th>쓸 수 있는 때</th>
              <td>언제든</td>
              <td>얼굴 찾기가 끝난 뒤</td>
            </tr>
          </tbody>
        </table>
        <p>예: 교실 왼쪽 학생들만 가리려면 왼쪽에 사각형 영역을 그립니다. 고개를 숙여 모자이크가 빠진 학생이 있으면 그 장면에서 얼굴 추가로 상자를 그립니다. 얼굴 추가로 넣은 모자이크는 영역 밖에 있어도 항상 가려집니다.</p>
      </>
    ),
  },
  {
    question: '‘영역 옮기기’는 어떤 기능인가요?',
    answer: (
      <>
        <p>이미 그려 둔 영역(사각형·다각형)을 마우스로 끌어서 다른 위치로 옮기는 도구입니다. ‘영역 옮기기’를 누른 뒤 옮길 영역 안쪽을 잡고 끌면 됩니다.</p>
        <p>위치만 옮겨지고 모양과 크기는 그대로입니다. 크기를 바꾸려면 영역을 지우고 다시 그려야 합니다. 옮겨도 얼굴을 다시 찾지 않고 미리보기에 바로 반영됩니다.</p>
        <p>영역은 화면에 고정된 자리이며 얼굴을 따라가지 않습니다. 영상 중간에 자리가 바뀌면 영역을 두 개 그리고 각각 적용 시간(시작·끝 초)을 정하세요.</p>
      </>
    ),
  },
  {
    question: '얼굴이 아닌 사물에 모자이크가 들어갑니다.',
    answer: (
      <>
        <p>‘얼굴이 아닌 것 거르기’를 ‘강하게’로 바꿔 보세요. 미리보기에 바로 반영됩니다. 다만 옆얼굴이나 가려진 얼굴을 놓칠 수 있으니 빠진 얼굴이 없는지 꼭 확인하세요.</p>
        <p>몇 군데만 잘못 들어갔다면 ‘다음 모자이크’로 건너뛰며 찾아서 ‘가림 삭제’로 지우는 편이 안전합니다.</p>
      </>
    ),
  },
  {
    question: '얼굴이 지나간 자리나 빈 곳에 모자이크가 잠깐 남아 있습니다.',
    answer: (
      <>
        <p>
          얼굴이 잠깐 안 잡혔다가 같은 자리에서 3초 안에 다시 잡히면, 그 사이에도 얼굴이 거기 있었던 것으로 보고 계속 가립니다. 고개를 숙이거나 돌린 순간에 얼굴이 드러나지 않게 하려는 것입니다.
        </p>
        <p>그 사이 사람이 자리를 옮겼다면 빈 곳이 잠깐 가려질 수 있습니다. 얼굴이 드러나는 것보다 안전한 쪽을 택한 동작입니다.</p>
      </>
    ),
  },
  {
    question: '가림 삭제를 했는데 조금 뒤에 모자이크가 다시 나옵니다.',
    answer: (
      <p>
        가림 삭제는 같은 자리에서 2초 이내로 이어지는 구간까지 한 번에 지웁니다. 2초 넘게 사라졌다 다시 나오거나 그 사이 크게 움직였으면 이어지지 않으므로, ‘다음 모자이크’로 그 지점에 가서 한 번 더 지우면 됩니다.
      </p>
    ),
  },
  {
    question: '얼굴 추가를 했는데 모자이크가 금방 끝납니다.',
    answer: (
      <p>
        얼굴 추가는 표시한 얼굴을 앞뒤로 따라가다가 얼굴을 놓치거나 장면이 바뀌면 멈춥니다. 정한 시간(기본 5초)이 지나도 멈춥니다. 더 길게 가리려면 ‘따라갈 시간’을 늘리거나, 모자이크가 끝난 지점에서 한 번 더 추가하세요.
      </p>
    ),
  },
  {
    question: '영상이 서버로 올라가나요?',
    answer: (
      <p>
        아니요. 영상을 읽고, 얼굴을 찾고, 저장하는 일이 모두 이 브라우저 안에서만 이뤄집니다. 영상·얼굴 정보는 인터넷으로 보내지 않으며, 한 번 열어 둔 뒤에는 인터넷을 끊고도 쓸 수 있습니다.
      </p>
    ),
  },
  {
    question: 'AVI·MKV 같은 파일이 열리지 않습니다.',
    answer: (
      <p>
        이 형식은 변환 기능(ffmpeg.wasm)이 있어야 열립니다. 이 기능은 라이선스(GPL) 때문에 기본으로 넣지 않았습니다. 다른 프로그램으로 MP4 로 바꿔서 불러오거나, 직접 설치해서 쓰는 경우 저장소의 README 하단 안내에 따라 설치하세요.
      </p>
    ),
  },
  {
    question: '처리가 너무 오래 걸립니다.',
    answer: (
      <p>
        처리 속도는 컴퓨터 성능에 좌우됩니다. ‘찾는 정도’를 ‘빠르게’로 낮추면 빨라지지만 고개를 숙이거나 돌린 얼굴을 놓칠 수 있습니다. 긴 영상은 ‘영상 나누기’로 조각내어 저장하면 중간에 멈춰도 끝난 조각이 남습니다. 처리 중에는 이 탭을 닫지 마세요.
      </p>
    ),
  },
  {
    question: '작업을 나중에 이어서 할 수 있나요?',
    answer: (
      <p>
        ‘프로젝트 저장’으로 영역·설정·직접 추가한 얼굴을 파일(.json)로 남길 수 있습니다. 나중에 같은 영상을 열고 ‘프로젝트 불러오기’를 하면 됩니다. 얼굴 찾기는 다시 실행되며, 가림 삭제한 내용은 저장되지 않습니다.
      </p>
    ),
  },
]

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
        // 안쪽의 자주 묻는 질문을 펼치고 접는 것은 여기서 다루지 않는다.
        if (event.target !== event.currentTarget) return
        const next = event.currentTarget.open
        setOpen(next)
        writeSeen(!next)
      }}
    >
      <summary>사용 안내 {open ? '' : '(눌러서 펼치기)'}</summary>

      <h3>사용 순서</h3>
      <ol className="guide-steps">
        {STEPS.map((step) => (
          <li key={step.title}>
            <strong>{step.title}</strong> {step.summary}
            <div className="guide-detail">
              {step.details.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </li>
        ))}
      </ol>

      <h3>꼭 알아 둘 점</h3>
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

      <h3>자주 묻는 질문</h3>
      <div className="faq">
        {FAQ.map((item) => (
          <details key={item.question}>
            <summary>{item.question}</summary>
            <div className="faq-answer">{item.answer}</div>
          </details>
        ))}
      </div>
    </details>
  )
}
