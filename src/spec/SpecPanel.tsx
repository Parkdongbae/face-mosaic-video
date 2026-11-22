import { useState } from 'react'
import type { SpecStage } from './collect'
import { formatSpan, type ItemStatus, type SpecItem, type SpecJudgement } from './judge'
import { QrCode } from './QrCode'

const STATUS_LABEL: Record<ItemStatus, string> = { good: '적합', warn: '주의', fail: '부족', unknown: '확인 불가' }

function ItemTable({ items }: { items: SpecItem[] }) {
  return (
    <div className="table-wrap">
      <table className="spec-table">
        <thead>
          <tr>
            <th>항목</th>
            <th>이 컴퓨터</th>
            <th>최소</th>
            <th>권장</th>
            <th>판정</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <td>{item.label}</td>
              <td>{item.value}</td>
              <td>{item.min}</td>
              <td>{item.recommended}</td>
              <td>
                <span className={`status ${item.status}`}>{STATUS_LABEL[item.status]}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export interface SpecPanelProps {
  /** 점검 중이면 진행 상태, 끝났으면 null */
  checking: { stage: SpecStage; fraction: number } | null
  judgement: SpecJudgement | null
  /** 점검 자체가 실패했을 때의 메시지 */
  failure: string | null
  /** 사용자가 주의·부적합을 알고도 진행하기로 했는지 */
  proceeding: boolean
  lowSpecMode: boolean
  /** 앱 주소(영상 정보 없음) */
  appUrl: string
  onProceed: () => void
  onRecheck: () => void
  onDownloadProject: () => void
}

export function SpecPanel(props: SpecPanelProps) {
  const { checking, judgement, failure, proceeding, lowSpecMode, appUrl } = props
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(appUrl)
      setCopied('done')
    } catch {
      setCopied('failed')
    }
  }

  if (checking) {
    return (
      <section className="panel" aria-live="polite">
        <h2>사양 점검</h2>
        <p className="progress-label">이 컴퓨터에서 처리할 수 있는지 확인하는 중입니다(약 10초) · {checking.stage}</p>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(checking.fraction * 100)}>
          <div style={{ width: `${(checking.fraction * 100).toFixed(0)}%` }} />
        </div>
      </section>
    )
  }

  if (!judgement) {
    return (
      <section className="panel">
        <h2>사양 점검</h2>
        <p className="alert">사양 점검을 끝내지 못했습니다{failure ? `: ${failure}` : '.'}</p>
        <div className="actions">
          <button type="button" onClick={props.onRecheck}>다시 점검</button>
          {!proceeding ? (
            <button type="button" className="ghost" onClick={props.onProceed}>점검 없이 진행</button>
          ) : null}
        </div>
      </section>
    )
  }

  const { verdict, items, estimate } = judgement
  const lacking = items.filter((item) => item.status === 'fail')
  const estimateText = estimate
    ? `${formatSpan(estimate.videoDurationSec)} 영상${estimate.forLoadedVideo ? '' : '(1080p 기준)'}에 약 ${formatSpan(estimate.processSec)}`
    : null

  if (verdict === 'unfit' && !proceeding) {
    return (
      <section className="panel spec unfit">
        <h2>다른 컴퓨터에서 작업하세요</h2>
        <p className="verdict unfit">
          <strong>부적합</strong> 이 컴퓨터는 영상 처리에 필요한 사양에 못 미칩니다. 아래 항목이 부족합니다.
        </p>
        <ItemTable items={lacking} />
        <div className="handoff">
          <div>
            <h3>다른 컴퓨터에서 이 앱 열기</h3>
            <p className="muted">
              주소를 복사하거나 QR 코드를 찍어 다른 컴퓨터에서 같은 앱을 여세요. 주소에는 영상 정보가 들어 있지 않습니다. 영상 파일은 직접 옮겨야 합니다.
            </p>
            <p className="app-url">{appUrl}</p>
            <div className="actions">
              <button type="button" onClick={() => void copyLink()}>링크 복사</button>
              <button type="button" className="ghost" onClick={props.onDownloadProject}>프로젝트 파일 내려받기</button>
            </div>
            {copied === 'done' ? <p className="muted">주소를 복사했습니다.</p> : null}
            {copied === 'failed' ? <p className="muted">복사하지 못했습니다. 위 주소를 직접 적어 가세요.</p> : null}
            <p className="muted">프로젝트 파일에는 지금까지 정한 영역과 설정이 담깁니다. 다른 컴퓨터에서 불러오면 이어서 작업할 수 있습니다.</p>
          </div>
          <QrCode text={appUrl} />
        </div>
        <div className="override">
          <p className="muted">
            그래도 이 컴퓨터에서 하려면 저사양 모드로 진행할 수 있습니다. 얼굴을 드문드문 확인해 빠르게 찾기 때문에 <strong>고개를 숙이거나 돌린 얼굴을 놓칠 수 있고</strong>, 처리 중 멈추거나 매우 오래 걸릴 수 있습니다.
          </p>
          <div className="actions">
            <button type="button" className="ghost" onClick={props.onProceed}>그래도 진행 (저사양 모드)</button>
            <button type="button" className="ghost" onClick={props.onRecheck}>다시 점검</button>
          </div>
        </div>
        <details>
          <summary>전체 점검 결과 보기</summary>
          <ItemTable items={items} />
        </details>
      </section>
    )
  }

  return (
    <section className={`panel spec ${verdict}`}>
      <h2>사양 점검</h2>
      {verdict === 'fit' ? (
        <p className="verdict fit">
          <strong>적합</strong> 이 컴퓨터에서 바로 작업할 수 있습니다.{estimateText ? ` 예상 처리 시간: ${estimateText}.` : ''}
        </p>
      ) : verdict === 'caution' ? (
        <p className="verdict caution">
          <strong>주의</strong> 처리할 수는 있지만 권장 사양에 못 미쳐 시간이 걸립니다.{estimateText ? ` 예상 처리 시간: ${estimateText}.` : ''}
        </p>
      ) : (
        <p className="verdict unfit">
          <strong>부적합 · 저사양 모드로 진행 중</strong> {lowSpecMode ? '얼굴을 드문드문 확인합니다. 고개를 숙이거나 돌린 얼굴을 놓칠 수 있으니 저장 전에 꼭 확인하세요.' : '사양이 부족합니다. 처리 중 멈출 수 있습니다.'}
        </p>
      )}
      {verdict === 'caution' && !proceeding ? (
        <div className="actions">
          <button type="button" onClick={props.onProceed}>계속 진행</button>
          <button type="button" className="ghost" onClick={props.onRecheck}>다시 점검</button>
        </div>
      ) : null}
      <details>
        <summary>점검 결과 자세히 보기</summary>
        <ItemTable items={items} />
        <div className="actions">
          <button type="button" className="ghost" onClick={props.onRecheck}>다시 점검</button>
        </div>
      </details>
    </section>
  )
}
