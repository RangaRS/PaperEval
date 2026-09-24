import { Brain, CircleAlert, CircleCheck, Clock, FileSearch, FileText, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

import { api, type DocumentInfo, type Exam, type ModelInfo, type Page } from '../api'
import { useElapsedSeconds } from '../hooks'
import { pageKey, type OcrJob } from '../ocrQueue'
import { errorMessage, formatElapsed, pluralize } from '../utils'
import { Dialog } from './Dialog'
import { ModelSelect } from './ModelSelect'
import { UploadButton } from './Sidebar'

interface KeyFromDocumentDialogProps {
  open: boolean
  onClose: () => void
  documents: DocumentInfo[]
  /** The page reading jobs, to show how each page is getting on. */
  jobs: ReadonlyMap<string, OcrJob>
  model: string
  onModelChange: (model: string) => void
  models: ModelInfo[]
  addedModels: string[]
  /** The vision model that reads the pages. */
  ocrModel: string
  acceptedExtensions: string[]
  uploading: boolean
  onUpload: (files: File[]) => void
  /** Extract the text of the document's pages one by one: those without text, or with `all`, every page. */
  prepare: (documentId: string, signal: AbortSignal, options?: { all?: boolean }) => Promise<void>
  onCreated: (exam: Exam) => void
}

type StepState = 'waiting' | 'running' | 'done' | 'failed'

/** One attempt at reading an answer key: first every page's text, then the model's reading of it. */
interface Run {
  documentId: string
  /** The pages whose text this run extracts. */
  extracting: number[]
  extract: StepState
  extractError?: string
  read: StepState
  readStartedAt?: number
  /** Characters of text sent to the model. */
  sent?: number
  /** Characters of the model's answer received so far. */
  received: number
  /** 2 when the model is asked a second time, without a fixed format. */
  attempt: number
  readError?: string
  /** The model's answer, when it could not be used. */
  reply?: string
}

const characters = (count: number) => `${count.toLocaleString()} character${count === 1 ? '' : 's'}`

/** Read an answer key from an uploaded document: extract every page's text, then have a model find the questions. */
export function KeyFromDocumentDialog(props: KeyFromDocumentDialogProps) {
  const [busy, setBusy] = useState(false)
  const close = () => {
    if (!busy) props.onClose()
  }
  return (
    <Dialog open={props.open} title="Read an answer key from a document" onClose={close} locked={busy} wide>
      {props.open && <KeyReader {...props} onBusyChange={setBusy} />}
    </Dialog>
  )
}

function KeyReader({
  onClose,
  documents,
  jobs,
  model,
  onModelChange,
  models,
  addedModels,
  ocrModel,
  acceptedExtensions,
  uploading,
  onUpload,
  prepare,
  onCreated,
  onBusyChange,
}: KeyFromDocumentDialogProps & { onBusyChange: (busy: boolean) => void }) {
  const [choice, setChoice] = useState<string | null>(null)
  const [extractAll, setExtractAll] = useState(false)
  const [run, setRun] = useState<Run | null>(null)
  const [busy, setBusy] = useState(false)
  const controller = useRef<AbortController | null>(null)

  // Until a document is chosen, offer the newest one, such as one just uploaded.
  const document =
    documents.find((candidate) => candidate.id === (run?.documentId ?? choice)) ?? (run ? undefined : documents[0])
  const withText = document ? document.pages.filter((page) => page.ocr).length : 0

  const working = (value: boolean) => {
    setBusy(value)
    onBusyChange(value)
  }
  const update = (changes: Partial<Run>) => setRun((current) => current && { ...current, ...changes })

  const start = async (again: boolean) => {
    if (!document || !model) return
    const abort = new AbortController()
    controller.current = abort
    const extracting = document.pages.filter((page) => again || !page.ocr).map((page) => page.number)
    setRun({
      documentId: document.id,
      extracting,
      extract: extracting.length > 0 ? 'running' : 'done',
      read: 'waiting',
      received: 0,
      attempt: 1,
    })
    working(true)
    try {
      // 1. The text of every page, one page at a time.
      if (extracting.length > 0) {
        try {
          await prepare(document.id, abort.signal, { all: again })
        } catch (error) {
          if (abort.signal.aborted) throw error
          update({ extract: 'failed', extractError: errorMessage(error) })
          return
        }
        update({ extract: 'done' })
      }
      // 2. The text of all pages to the model, which returns the questions.
      update({ read: 'running', readStartedAt: Date.now() })
      for await (const event of api.examFromDocument({ document_id: document.id, model }, abort.signal)) {
        if (event.type === 'start') update({ sent: event.characters })
        else if (event.type === 'progress') update({ received: event.characters, attempt: event.attempt })
        else if (event.type === 'error') {
          update({ read: 'failed', readError: event.message, reply: event.reply })
          return
        } else if (event.type === 'done') {
          update({ read: 'done' })
          working(false)
          onCreated(event.exam)
          onClose()
          return
        }
      }
      update({ read: 'failed', readError: 'The connection closed before the model finished.' })
    } catch (error) {
      if (abort.signal.aborted) setRun(null)
      else update({ read: 'failed', readError: errorMessage(error) })
    } finally {
      working(false)
    }
  }

  if (run && document) {
    return (
      <div className="key-run">
        <p className="key-run-document">
          <FileText size={16} aria-hidden />
          <strong>{document.filename}</strong>
          <span className="muted">{pluralize(document.pages.length, 'page')}</span>
        </p>
        <ol className="key-steps">
          <li className={`key-step is-${run.extract}`}>
            <StepTitle state={run.extract} number={1} title="Extract the text of every page, one by one">
              {run.extracting.length > 0 ? `with ${ocrModel}` : 'already extracted'}
            </StepTitle>
            <ul className="page-steps">
              {document.pages.map((page) => (
                <PageStep
                  key={page.number}
                  page={page}
                  job={jobs.get(pageKey(document.id, page.number))}
                  extracting={run.extracting.includes(page.number)}
                />
              ))}
            </ul>
            {run.extractError && <p className="key-error">{run.extractError}</p>}
            {run.extract === 'done' && (
              <details className="key-details">
                <summary>Show the text that is sent to the model</summary>
                <pre>{documentText(document)}</pre>
              </details>
            )}
          </li>
          <li className={`key-step is-${run.read}`}>
            <StepTitle state={run.read} number={2} title="Find the questions, answers and marks">
              with {model}
            </StepTitle>
            {run.read === 'running' && <ReadProgress run={run} />}
            {run.read === 'failed' && (
              <>
                <p className="key-error">{run.readError}</p>
                {run.reply !== undefined && (
                  <details className="key-details" open>
                    <summary>What the model answered</summary>
                    <pre>{run.reply || '(nothing)'}</pre>
                  </details>
                )}
                <p className="hint">
                  Check that the extracted text above has the questions in it. Try again, or choose another model.
                </p>
              </>
            )}
          </li>
        </ol>
        <footer className="dialog-footer">
          {busy ? (
            <button type="button" className="btn" onClick={() => controller.current?.abort()}>
              Cancel
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setRun(null)}>
                Back
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void start(false)}>
                Try again
              </button>
            </>
          )}
        </footer>
      </div>
    )
  }

  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        void start(extractAll)
      }}
    >
      <p className="hint">
        Upload the answer key (the questions with their answers and marking scheme) as a PDF or images. The text of
        every page is extracted first, one page at a time. Then all of it goes to the model, which lists each question
        with its answer, marking key and marks. You can check and edit the result.
      </p>
      <div className="field">
        <span className="field-label">Document</span>
        {documents.length > 0 ? (
          <select className="select" value={document?.id ?? ''} onChange={(event) => setChoice(event.target.value)}>
            {documents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.filename} ({pluralize(candidate.pages.length, 'page')})
              </option>
            ))}
          </select>
        ) : (
          <p className="field-value muted">No documents yet.</p>
        )}
        <div className="field-row">
          <UploadButton accept={acceptedExtensions} busy={uploading} onFiles={onUpload} label="Upload the answer key" />
        </div>
      </div>
      {document && (
        <div className="field">
          <span className="field-label">Text</span>
          <p className="field-value">
            {withText === document.pages.length
              ? `All ${pluralize(document.pages.length, 'page')} already have their text extracted.`
              : withText === 0
                ? `The text of the ${pluralize(document.pages.length, 'page')} will be extracted with ${ocrModel || 'the vision model chosen at the top'}.`
                : `${withText} of ${pluralize(document.pages.length, 'page')} have text; the rest will be extracted with ${ocrModel || 'the vision model chosen at the top'}.`}
          </p>
          {withText > 0 && (
            <label className="checkbox">
              <input type="checkbox" checked={extractAll} onChange={(event) => setExtractAll(event.target.checked)} />
              Extract the text of every page again
            </label>
          )}
        </div>
      )}
      <label className="field">
        <span className="field-label">Model that finds the questions</span>
        <ModelSelect value={model} onChange={onModelChange} models={models} added={addedModels} />
      </label>
      <footer className="dialog-footer">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!document || !model || uploading || ((extractAll || withText < document.pages.length) && !ocrModel)}
        >
          <FileSearch size={15} aria-hidden />
          Read answer key
        </button>
      </footer>
    </form>
  )
}

function StepTitle({
  state,
  number,
  title,
  children,
}: {
  state: StepState
  number: number
  title: string
  children: ReactNode
}) {
  return (
    <p className="key-step-title">
      <StateIcon state={state} size={17} />
      <strong>
        {number}. {title}
      </strong>
      <span className="muted">{children}</span>
    </p>
  )
}

function StateIcon({ state, size = 15 }: { state: StepState; size?: number }) {
  if (state === 'done') return <CircleCheck size={size} className="state-done" aria-label="Done" />
  if (state === 'running') return <LoaderCircle size={size} className="spin state-running" aria-label="Working" />
  if (state === 'failed') return <CircleAlert size={size} className="state-failed" aria-label="Failed" />
  return <Clock size={size} className="state-waiting" aria-label="Waiting" />
}

/** A page of the document: waiting for its turn, being read, or read. */
function PageStep({ page, job, extracting }: { page: Page; job: OcrJob | undefined; extracting: boolean }) {
  const running = extracting && job?.status === 'running'
  const seconds = useElapsedSeconds(running ? job.startedAt : undefined)
  let state: StepState
  let detail: ReactNode
  if (extracting && job?.status === 'running') {
    state = 'running'
    detail = job.thinking ? (
      <>
        <Brain size={13} className="pulse" aria-hidden /> thinking… {formatElapsed(seconds)}
      </>
    ) : (
      `reading… ${characters(job.text.length)} so far · ${formatElapsed(seconds)}`
    )
  } else if (extracting && (job?.status === 'error' || job?.status === 'stopped')) {
    state = 'failed'
    detail = job.status === 'error' ? `failed: ${job.error}` : 'stopped'
  } else if (extracting && job?.status !== 'done') {
    state = 'waiting'
    detail = 'waiting for its turn'
  } else if (page.ocr) {
    state = 'done'
    detail = extracting ? characters(page.ocr.text.length) : `${characters(page.ocr.text.length)} · extracted earlier`
  } else {
    state = 'waiting'
    detail = 'no text yet'
  }
  const empty = state === 'done' && page.ocr?.text.trim() === ''
  return (
    <li className={`page-step is-${state}`}>
      <StateIcon state={state} />
      <span className="page-step-name">Page {page.number}</span>
      <span className="page-step-detail">{detail}</span>
      {empty && (
        <span className="page-step-warning">
          <TriangleAlert size={13} aria-hidden /> no text was found on this page
        </span>
      )}
    </li>
  )
}

function ReadProgress({ run }: { run: Run }) {
  const seconds = useElapsedSeconds(run.readStartedAt)
  return (
    <div className="key-read-progress" role="status">
      <p>{run.sent === undefined ? 'Sending the text…' : `Sent the text of every page: ${characters(run.sent)}.`}</p>
      <p>
        {run.received > 0
          ? `The model has written ${characters(run.received)} of its answer.`
          : 'Waiting for the model to answer…'}{' '}
        <span className="elapsed-inline">{formatElapsed(seconds)}</span>
      </p>
      {run.attempt > 1 && (
        <p className="key-note">
          <TriangleAlert size={13} aria-hidden /> Its first answer had no questions in it, so it was asked again, this
          time without a fixed format.
        </p>
      )}
    </div>
  )
}

/** The text sent to the model: every page's text, with the same page markers the backend adds. */
function documentText(document: DocumentInfo): string {
  return document.pages.map((page) => `=== Page ${page.number} ===\n${page.ocr?.text.trim() ?? ''}`).join('\n\n')
}
