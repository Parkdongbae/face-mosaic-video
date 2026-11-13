import qrcode from 'qrcode-generator'
import { useMemo } from 'react'

/**
 * QR 코드. 생성 라이브러리는 앱에 함께 묶여 있어 외부로 요청하지 않는다.
 * text 에는 앱 주소만 넣는다(영상 정보·파일명 금지, glm.md 5장).
 */
export function QrCode({ text, size = 168 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const code = qrcode(0, 'M')
    code.addData(text)
    code.make()
    const count = code.getModuleCount()
    let d = ''
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (code.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`
      }
    }
    return { d, count }
  }, [text])

  const quiet = 4
  const total = path.count + quiet * 2
  return (
    <svg
      className="qr"
      role="img"
      aria-label="이 앱의 주소가 담긴 QR 코드"
      width={size}
      height={size}
      viewBox={`${-quiet} ${-quiet} ${total} ${total}`}
      shapeRendering="crispEdges"
    >
      <rect x={-quiet} y={-quiet} width={total} height={total} fill="#ffffff" />
      <path d={path.d} fill="#10201c" />
    </svg>
  )
}
