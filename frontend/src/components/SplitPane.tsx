import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'

import { isNumber, useLocalStorage } from '../hooks'

const MIN_RATIO = 0.2
const MAX_RATIO = 0.8
const clamp = (ratio: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))

/** Two panes side by side, separated by a divider that can be dragged or moved with the arrow keys. */
export function SplitPane({ left, right, storageKey }: { left: ReactNode; right: ReactNode; storageKey: string }) {
  const [ratio, setRatio] = useLocalStorage(storageKey, 0.5, isNumber)
  const [dragging, setDragging] = useState(false)
  const container = useRef<HTMLDivElement>(null)
  const leftRatio = clamp(ratio)

  const moveTo = (clientX: number) => {
    const bounds = container.current?.getBoundingClientRect()
    if (bounds && bounds.width > 0) setRatio(clamp((clientX - bounds.left) / bounds.width))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.02
    const next: Record<string, number> = {
      ArrowLeft: leftRatio - step,
      ArrowRight: leftRatio + step,
      Home: MIN_RATIO,
      End: MAX_RATIO,
    }
    if (event.key in next) {
      event.preventDefault()
      setRatio(clamp(next[event.key]))
    }
  }

  return (
    <div
      ref={container}
      className={`split${dragging ? ' is-dragging' : ''}`}
      style={{ '--split-left': `${leftRatio}fr`, '--split-right': `${1 - leftRatio}fr` } as CSSProperties}
    >
      <div className="split-pane">{left}</div>
      <div
        className="split-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the image and text panels"
        aria-valuemin={MIN_RATIO * 100}
        aria-valuemax={MAX_RATIO * 100}
        aria-valuenow={Math.round(leftRatio * 100)}
        tabIndex={0}
        title="Drag to resize. Double-click to reset."
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragging(true)
        }}
        onPointerMove={(event) => dragging && moveTo(event.clientX)}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onDoubleClick={() => setRatio(0.5)}
        onKeyDown={onKeyDown}
      >
        <span className="split-grip" />
      </div>
      <div className="split-pane">{right}</div>
    </div>
  )
}
