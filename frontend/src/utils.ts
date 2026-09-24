import type { DocumentInfo } from './api'

export function formatDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes} min ${Math.round(seconds % 60)} s`
}

export function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/** The file name without its extension. */
export function fileStem(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(0, dot) : filename
}

export function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** The text the model reads: every page's text, with the same page markers the backend adds. */
export function documentText(document: DocumentInfo): string {
  return document.pages.map((page) => `=== Page ${page.number} ===\n${page.ocr?.text.trim() ?? ''}`).join('\n\n')
}

/** A file name without the characters Windows does not allow in one. */
export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'download'
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = safeFilename(filename)
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function downloadText(filename: string, text: string, type = 'text/plain'): void {
  downloadBlob(filename, new Blob([text], { type: `${type};charset=utf-8` }))
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  // The Clipboard API needs HTTPS or localhost; fall back to the legacy way.
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Copying is not supported in this browser.')
}

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.'
}
