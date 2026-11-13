import { useCallback, useEffect, useRef, type ReactNode } from 'react'

/** 누르고 있을 때 반복을 시작하기까지의 시간(ms)과 반복 간격(ms) */
const HOLD_DELAY_MS = 350
const HOLD_INTERVAL_MS = 70

interface HoldButtonProps {
  /** 한 번 누를 때, 그리고 누르고 있는 동안 반복해서 부를 동작 */
  onStep: () => void
  disabled?: boolean
  className?: string
  title?: string
  'aria-label'?: string
  children: ReactNode
}

/**
 * 한 번 누르면 한 번, 누르고 있으면 빠르게 반복해서 동작하는 버튼.
 * 마우스·터치는 누르는 순간 동작하고, 키보드(Enter·Space)는 click 으로 한 번 동작한다.
 */
export function HoldButton({ onStep, disabled, className, title, 'aria-label': ariaLabel, children }: HoldButtonProps) {
  const stepRef = useRef(onStep)
  stepRef.current = onStep
  const timers = useRef<{ delay: number | null; repeat: number | null }>({ delay: null, repeat: null })

  const stop = useCallback(() => {
    if (timers.current.delay !== null) window.clearTimeout(timers.current.delay)
    if (timers.current.repeat !== null) window.clearInterval(timers.current.repeat)
    timers.current = { delay: null, repeat: null }
  }, [])

  // 누르고 있는 중에 버튼이 꺼지거나 사라지면 반복을 멈춘다.
  useEffect(() => {
    if (disabled) stop()
  }, [disabled, stop])
  useEffect(() => stop, [stop])

  return (
    <button
      type="button"
      className={className}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        stop()
        stepRef.current()
        timers.current.delay = window.setTimeout(() => {
          timers.current.repeat = window.setInterval(() => stepRef.current(), HOLD_INTERVAL_MS)
        }, HOLD_DELAY_MS)
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onBlur={stop}
      onClick={(event) => {
        // 마우스·터치로 누른 것은 onPointerDown 에서 이미 처리했다. 키보드로 누른 것만 여기서 처리한다.
        if (event.detail === 0) stepRef.current()
      }}
    >
      {children}
    </button>
  )
}
