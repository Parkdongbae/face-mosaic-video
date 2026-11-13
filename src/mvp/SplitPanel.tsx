import { SPLIT_LIMITS, type SplitPiece } from '../core/split-plan'

export type SplitChoice = 'none' | 'count' | 'size'
export type PieceStatus = 'waiting' | 'working' | 'done'

const STATUS_LABEL: Record<PieceStatus, string> = { waiting: '대기', working: '처리 중', done: '완료' }

function clock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}

function megabytes(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)}GB` : `${(bytes / 1024 ** 2).toFixed(1)}MB`
}

export interface SplitPanelProps {
  choice: SplitChoice
  count: number
  maxMb: number
  pieces: SplitPiece[] | null
  statuses: Record<number, PieceStatus>
  disabled: boolean
  /** 큰 영상이거나 사양이 낮아 분할을 권할 때의 안내 문구 */
  recommendation: string | null
  error: string | null
  onChoice: (choice: SplitChoice) => void
  onCount: (count: number) => void
  onMaxMb: (maxMb: number) => void
  onPreview: () => void
  onSplitOnly: () => void
  onResetStatuses: () => void
}

/** 영상 분할(F-16): 방식 고르기 → 나누기 전 미리보기 표 → 분할만 저장 */
export function SplitPanel(props: SplitPanelProps) {
  const { choice, count, maxMb, pieces, statuses, disabled } = props
  const anyDone = pieces?.some((piece) => statuses[piece.index] === 'done') ?? false
  return (
    <div className="split">
      <h3>영상 나누기</h3>
      {props.recommendation ? <p className="verdict caution">{props.recommendation}</p> : null}
      <div className="settings">
        <label>
          나누는 방식
          <select value={choice} disabled={disabled} onChange={(event) => props.onChoice(event.target.value as SplitChoice)}>
            <option value="none">나누지 않음</option>
            <option value="count">파일 개수로 나누기</option>
            <option value="size">파일당 최대 용량으로 나누기</option>
          </select>
        </label>
        {choice === 'count' ? (
          <label>
            파일 개수 ({SPLIT_LIMITS.minCount}~{SPLIT_LIMITS.maxCount})
            <input
              type="number"
              min={SPLIT_LIMITS.minCount}
              max={SPLIT_LIMITS.maxCount}
              step={1}
              value={count}
              disabled={disabled}
              onChange={(event) => props.onCount(Number(event.target.value))}
            />
          </label>
        ) : null}
        {choice === 'size' ? (
          <label>
            파일당 최대 용량 (MB)
            <input
              type="number"
              min={10}
              step={10}
              value={maxMb}
              disabled={disabled}
              onChange={(event) => props.onMaxMb(Number(event.target.value))}
            />
          </label>
        ) : null}
      </div>
      {choice !== 'none' ? (
        <div className="actions">
          <button type="button" className="ghost" onClick={props.onPreview} disabled={disabled}>
            나누기 미리보기
          </button>
          <span className="muted">재압축 없이 키프레임 위치에서 자르기 때문에 조각 길이·용량은 조금씩 다를 수 있습니다.</span>
        </div>
      ) : null}
      {props.error ? <p className="alert">{props.error}</p> : null}
      {choice !== 'none' && pieces ? (
        <>
          <div className="table-wrap">
            <table className="spec-table">
              <thead>
                <tr>
                  <th>조각</th>
                  <th>시작</th>
                  <th>끝</th>
                  <th>길이</th>
                  <th>예상 용량(원본 기준)</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {pieces.map((piece) => {
                  const status = statuses[piece.index] ?? 'waiting'
                  return (
                    <tr key={piece.index}>
                      <td>{String(piece.index).padStart(2, '0')}</td>
                      <td>{clock(piece.startSec)}</td>
                      <td>{clock(piece.endSec)}</td>
                      <td>{clock(piece.endSec - piece.startSec)}</td>
                      <td>{megabytes(piece.estimatedBytes)}</td>
                      <td>
                        <span className={`status ${status === 'done' ? 'good' : status === 'working' ? 'warn' : 'unknown'}`}>{STATUS_LABEL[status]}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button type="button" className="ghost" onClick={props.onSplitOnly} disabled={disabled}>
              분할만 저장 (모자이크 없이)
            </button>
            {anyDone ? (
              <button type="button" className="ghost" onClick={props.onResetStatuses} disabled={disabled}>
                완료 표시 지우기
              </button>
            ) : null}
            <span className="muted">
              ‘모자이크 영상 저장’을 누르면 조각을 하나씩 차례로 처리해 저장합니다. 완료된 조각은 건너뜁니다. 모자이크 결과의 용량은 화질 설정에 따라 예상과 다를 수 있습니다.
            </span>
          </div>
        </>
      ) : null}
    </div>
  )
}
