import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'

import type { Toast } from './components/Toasts'

/** Like useState, but remembered in localStorage between visits. */
export function useLocalStorage<T>(
  key: string,
  initial: T,
  isValid: (value: unknown) => value is T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      if (stored !== null) {
        const parsed: unknown = JSON.parse(stored)
        if (isValid(parsed)) return parsed
      }
    } catch {
      // Unavailable or corrupt storage: fall back to the default.
    }
    return initial
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Storage may be full or disabled; the value still works for this visit.
    }
  }, [key, value])

  return [value, setValue]
}

export const isString = (value: unknown): value is string => typeof value === 'string'
export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

/** Seconds since `since`, updated every second. */
export function useElapsedSeconds(since: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === undefined) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [since])
  return since === undefined ? 0 : Math.max(0, Math.floor((now - since) / 1000))
}

/** Short-lived notifications. */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(0)

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), [])

  const notify = useCallback(
    (message: string, kind: Toast['kind'] = 'error') => {
      nextId.current += 1
      const id = nextId.current
      setToasts((list) => [...list.slice(-3), { id, kind, message }])
      window.setTimeout(() => dismiss(id), kind === 'error' ? 8000 : 4000)
    },
    [dismiss],
  )

  return { toasts, notify, dismiss }
}

/** Accept files dropped anywhere in the window. Returns whether files are being dragged over it. */
export function useFileDrop(onFiles: (files: File[]) => void): boolean {
  const [active, setActive] = useState(false)
  const handler = useRef(onFiles)

  useEffect(() => {
    handler.current = onFiles
  })

  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setActive(true)
    }
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setActive(false)
    }
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setActive(false)
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length > 0) handler.current(files)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragover', onOver)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  return active
}
