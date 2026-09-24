import { LoaderCircle, Maximize, MoveHorizontal, ZoomIn, ZoomOut } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

type Zoom = { mode: 'fit-width' } | { mode: 'fit-page' } | { mode: 'manual'; scale: number }

const PADDING = 20
const MIN_SCALE = 0.05
const MAX_SCALE = 8
const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8]

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

interface Anchor {
  /** Point of the image, in image pixels, that should stay under the focus point. */
  imageX: number
  imageY: number
  /** Focus point, relative to the viewport. */
  focusX: number
  focusY: number
}

/** Shows a page image with fit-to-width/page, zoom and drag-to-pan. */
export function ImageViewer({ src, width, height, alt }: { src: string; width: number; height: number; alt: string }) {
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [zoom, setZoom] = useState<Zoom>({ mode: 'fit-width' })
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const [panning, setPanning] = useState(false)
  const anchor = useRef<Anchor | null>(null)
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const fitWidth = Math.min(4, Math.max(MIN_SCALE, (size.width - PADDING * 2) / width))
  const fitPage = Math.min(fitWidth, Math.max(MIN_SCALE, (size.height - PADDING * 2) / height))
  const scale = zoom.mode === 'fit-width' ? fitWidth : zoom.mode === 'fit-page' ? fitPage : zoom.scale
  const displayWidth = Math.round(width * scale)
  const displayHeight = Math.round(height * scale)
  const imageLeft = (displayed: number, available: number) => Math.max(PADDING, (available - displayed) / 2)

  // The latest scale, for event handlers and the wheel listener (which is attached only once).
  const scaleRef = useRef(scale)

  const zoomTo = (nextScale: number, focus?: { clientX: number; clientY: number }) => {
    const element = viewport.current
    if (!element) return
    const bounds = element.getBoundingClientRect()
    const focusX = focus ? focus.clientX - bounds.left : element.clientWidth / 2
    const focusY = focus ? focus.clientY - bounds.top : element.clientHeight / 2
    const current = scaleRef.current
    anchor.current = {
      imageX: (element.scrollLeft + focusX - imageLeft(width * current, element.clientWidth)) / current,
      imageY: (element.scrollTop + focusY - imageLeft(height * current, element.clientHeight)) / current,
      focusX,
      focusY,
    }
    setZoom({ mode: 'manual', scale: clampScale(nextScale) })
  }
  const zoomToRef = useRef(zoomTo)
  useLayoutEffect(() => {
    scaleRef.current = scale
    zoomToRef.current = zoomTo
  })

  // After zooming, scroll so that the anchored point stays where it was.
  useLayoutEffect(() => {
    const element = viewport.current
    const point = anchor.current
    if (!element || !point) return
    anchor.current = null
    element.scrollLeft = imageLeft(displayWidth, element.clientWidth) + point.imageX * scale - point.focusX
    element.scrollTop = imageLeft(displayHeight, element.clientHeight) + point.imageY * scale - point.focusY
  })

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms around the pointer.
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      zoomToRef.current(scaleRef.current * Math.exp(-event.deltaY * 0.002), event)
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])

  // Start each new page at the top.
  useLayoutEffect(() => {
    viewport.current?.scrollTo(0, 0)
  }, [src])

  const stepZoom = (direction: 1 | -1) => {
    const next =
      direction > 0 ? STEPS.find((step) => step > scale * 1.01) : [...STEPS].reverse().find((step) => step < scale * 0.99)
    zoomTo(next ?? (direction > 0 ? MAX_SCALE : MIN_SCALE))
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === '+' || event.key === '=') stepZoom(1)
    else if (event.key === '-') stepZoom(-1)
    else if (event.key === '0') setZoom({ mode: 'fit-width' })
    else return
    event.preventDefault()
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const element = viewport.current
    if (event.button !== 0 || !element) return
    if (element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight) return
    pan.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }
    element.setPointerCapture(event.pointerId)
    setPanning(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const element = viewport.current
    if (!pan.current || !element) return
    element.scrollLeft = pan.current.left - (event.clientX - pan.current.x)
    element.scrollTop = pan.current.top - (event.clientY - pan.current.y)
  }
  const endPan = () => {
    pan.current = null
    setPanning(false)
  }

  const overflowing = displayWidth + PADDING * 2 > size.width || displayHeight + PADDING * 2 > size.height
  const loaded = loadedSrc === src
  const failed = failedSrc === src

  return (
    <div className="viewer">
      <div className="panel-toolbar">
        <span className="panel-title">Page image</span>
        <div className="toolbar-group" role="group" aria-label="Zoom">
          <button type="button" className="icon-btn" onClick={() => stepZoom(-1)} title="Zoom out (-)" aria-label="Zoom out">
            <ZoomOut size={16} />
          </button>
          <button
            type="button"
            className="zoom-level"
            onClick={() => zoomTo(1)}
            title="Actual size"
            aria-label={`Zoom ${Math.round(scale * 100)}%, show actual size`}
          >
            {Math.round(scale * 100)}%
          </button>
          <button type="button" className="icon-btn" onClick={() => stepZoom(1)} title="Zoom in (+)" aria-label="Zoom in">
            <ZoomIn size={16} />
          </button>
          <button
            type="button"
            className={`icon-btn${zoom.mode === 'fit-width' ? ' is-active' : ''}`}
            onClick={() => setZoom({ mode: 'fit-width' })}
            title="Fit width (0)"
            aria-label="Fit width"
            aria-pressed={zoom.mode === 'fit-width'}
          >
            <MoveHorizontal size={16} />
          </button>
          <button
            type="button"
            className={`icon-btn${zoom.mode === 'fit-page' ? ' is-active' : ''}`}
            onClick={() => setZoom({ mode: 'fit-page' })}
            title="Fit page"
            aria-label="Fit page"
            aria-pressed={zoom.mode === 'fit-page'}
          >
            <Maximize size={16} />
          </button>
        </div>
      </div>
      <div
        ref={viewport}
        className={`viewer-viewport${overflowing ? ' can-pan' : ''}${panning ? ' is-panning' : ''}`}
        tabIndex={0}
        aria-label="Page image. Use + and - to zoom."
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
      >
        <div
          className="viewer-canvas"
          style={{ width: displayWidth + PADDING * 2, height: displayHeight + PADDING * 2 }}
        >
          <img
            key={src}
            className={`viewer-image${loaded ? ' is-loaded' : ''}`}
            src={src}
            alt={alt}
            width={displayWidth}
            height={displayHeight}
            draggable={false}
            onLoad={() => setLoadedSrc(src)}
            onError={() => setFailedSrc(src)}
          />
        </div>
        {!loaded && !failed && (
          <div className="viewer-status">
            <LoaderCircle size={22} className="spin" aria-hidden />
          </div>
        )}
        {failed && <div className="viewer-status">The image could not be loaded.</div>}
      </div>
    </div>
  )
}
