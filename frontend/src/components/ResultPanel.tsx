import { Brain, Check, CircleAlert, Copy, Download, LoaderCircle, ScanText, Square, TriangleAlert, Type, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import type { DocumentInfo, Page } from '../api'
import { isBoolean, useElapsedSeconds, useLocalStorage } from '../hooks'
import { pageStatus, type OcrJob } from '../ocrQueue'
import { copyText, downloadText, errorMessage, fileStem, formatDuration, formatElapsed } from '../utils'
import { StatusBadge } from './StatusBadge'

interface ResultPanelProps {
  document: DocumentInfo
  page: Page
  job: OcrJob | undefined
  model: string
  onExtract: () => void
  onStop: () => void
  onDismiss: () => void
  onError: (message: string) => void
}

/** The text the model read from the page, streamed in as it is written. */
export function ResultPanel({ document, page, job, model, onExtract, onStop, onDismiss, onError }: ResultPanelProps) {
  const [monospace, setMonospace] = useLocalStorage('papereval.monospace', false, isBoolean)
  const [copied, setCopied] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  const status = pageStatus(page, job)
  const saved = job?.status === 'done' ? (job.result ?? page.ocr) : page.ocr
  const streaming = status === 'running' || status === 'stopped'
  const text = streaming ? job!.text : (saved?.text ?? null)
  const active = status === 'queued' || status === 'running'

  // Follow the text as it streams in, unless the reader has scrolled up.
  useLayoutEffect(() => {
    const element = body.current
    if (element && status === 'running' && stickToBottom.current) element.scrollTop = element.scrollHeight
  }, [text, status])

  useLayoutEffect(() => {
    stickToBottom.current = true
    body.current?.scrollTo(0, 0)
  }, [document.id, page.number])

  const copy = async () => {
    if (text === null) return
    try {
      await copyText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      onError(errorMessage(error))
    }
  }

  return (
    <div className="result">
      <div className="panel-toolbar">
        <span className="panel-title">Extracted text</span>
        <StatusBadge status={status} />
        <div className="toolbar-group toolbar-end">
          <button
            type="button"
            className={`icon-btn${monospace ? ' is-active' : ''}`}
            onClick={() => setMonospace((value) => !value)}
            title="Monospace font"
            aria-label="Monospace font"
            aria-pressed={monospace}
          >
            <Type size={16} />
          </button>
          <button type="button" className="icon-btn" onClick={copy} disabled={!text} title="Copy text" aria-label="Copy text">
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => text && downloadText(`${fileStem(document.filename)}-page-${page.number}.txt`, text)}
            disabled={!text}
            title="Download as .txt"
            aria-label="Download as .txt"
          >
            <Download size={16} />
          </button>
          {active && (
            <button type="button" className="btn" onClick={onStop}>
              <Square size={14} aria-hidden />
              {status === 'queued' ? 'Cancel' : 'Stop'}
            </button>
          )}
          {/* A page without text gets a larger button in the panel itself. */}
          {!active && status !== 'idle' && (
            <button type="button" className="btn" onClick={onExtract} disabled={!model}>
              <ScanText size={14} aria-hidden />
              Re-run
            </button>
          )}
        </div>
      </div>

      <div
        ref={body}
        className="result-body"
        onScroll={(event) => {
          const element = event.currentTarget
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48
        }}
      >
        {status === 'error' && job?.error && (
          <Notice kind="error" onDismiss={saved ? onDismiss : undefined}>
            <strong>Extraction failed.</strong> {job.error}
          </Notice>
        )}
        {status === 'stopped' && (
          <Notice kind="warning" onDismiss={onDismiss}>
            Stopped. Showing the text received so far{saved ? '; the saved text was not changed' : ''}.
          </Notice>
        )}
        {status === 'error' && saved && <p className="result-caption">Previously saved text:</p>}
        {saved?.truncated && !streaming && (
          <Notice kind="warning">The model reached its output limit, so the text may be incomplete.</Notice>
        )}

        {status === 'queued' && <Waiting>Waiting for the pages ahead of this one…</Waiting>}
        {status === 'running' && !job!.text && <Running job={job!} />}

        {text !== null && (text || !streaming) && (
          <pre className={`result-text${monospace ? ' is-monospace' : ''}`}>
            {text || <span className="muted">The model found no text on this page.</span>}
            {status === 'running' && <span className="caret" aria-hidden />}
          </pre>
        )}

        {status === 'idle' && (
          <div className="result-empty">
            <ScanText size={36} strokeWidth={1.5} aria-hidden />
            <p>No text has been extracted from this page yet.</p>
            <button type="button" className="btn btn-primary btn-large" onClick={onExtract} disabled={!model}>
              <ScanText size={16} aria-hidden />
              Extract text
            </button>
            <p className="hint">{model ? `Uses ${model}` : 'Choose a vision model at the top first.'}</p>
          </div>
        )}
      </div>

      {saved && !streaming && status !== 'error' && (
        <footer className="result-footer">
          <span title="Model">{saved.model}</span>
          <span>{formatDuration(saved.duration_ms)}</span>
          {saved.output_tokens !== null && <span>{saved.output_tokens.toLocaleString()} tokens</span>}
          <span title={new Date(saved.created_at).toLocaleString()}>{new Date(saved.created_at).toLocaleString()}</span>
        </footer>
      )}
    </div>
  )
}

function Running({ job }: { job: OcrJob }) {
  const seconds = useElapsedSeconds(job.startedAt)
  return (
    <Waiting icon={job.thinking ? <Brain size={22} className="pulse" aria-hidden /> : undefined}>
      {job.thinking ? `${job.model} is thinking…` : `Sending the page to ${job.model}…`}
      <span className="elapsed">{formatElapsed(seconds)}</span>
    </Waiting>
  )
}

function Waiting({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="result-waiting" role="status">
      {icon ?? <LoaderCircle size={22} className="spin" aria-hidden />}
      <p>{children}</p>
    </div>
  )
}

function Notice({
  kind,
  children,
  onDismiss,
}: {
  kind: 'error' | 'warning'
  children: ReactNode
  onDismiss?: () => void
}) {
  const Icon = kind === 'error' ? CircleAlert : TriangleAlert
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={16} className="notice-icon" aria-hidden />
      <div className="notice-body">{children}</div>
      {onDismiss && (
        <button type="button" className="icon-btn" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  )
}
