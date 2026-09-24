import { Brain, CircleAlert, CircleCheck, Clock, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

import type { DocumentInfo, Page } from '../api'
import type { KeyRead, StepState } from '../evaluator'
import { useElapsedSeconds } from '../hooks'
import { pageKey, type OcrJob } from '../ocrQueue'
import { documentText, formatElapsed } from '../utils'

const characters = (count: number) => `${count.toLocaleString()} character${count === 1 ? '' : 's'}`

/** Reading a key file: every page's text, one page at a time, then the model finding the questions. */
export function KeyReadProgress({
  read,
  document,
  jobs,
  ocrModel,
  model,
}: {
  read: KeyRead
  document: DocumentInfo
  jobs: ReadonlyMap<string, OcrJob>
  ocrModel: string
  model: string
}) {
  return (
    <ol className="key-steps">
      <li className={`key-step is-${read.extract}`}>
        <StepTitle state={read.extract} number={1} title="Extract the text of every page, one by one">
          {read.extracting.length > 0 ? `with ${ocrModel}` : 'already extracted'}
        </StepTitle>
        <ul className="page-steps">
          {document.pages.map((page) => (
            <PageStep
              key={page.number}
              page={page}
              job={jobs.get(pageKey(document.id, page.number))}
              extracting={read.extracting.includes(page.number)}
            />
          ))}
        </ul>
        {read.extractError && <p className="key-error">{read.extractError}</p>}
        {read.extract === 'done' && (
          <details className="key-details">
            <summary>Show the text that is sent to the model</summary>
            <pre>{documentText(document)}</pre>
          </details>
        )}
      </li>
      <li className={`key-step is-${read.read}`}>
        <StepTitle state={read.read} number={2} title="Find the questions, answers and marks">
          with {model}
        </StepTitle>
        {read.read === 'running' && <ReadProgress run={read} />}
        {read.read === 'failed' && (
          <>
            <p className="key-error">{read.readError}</p>
            {read.reply !== undefined && (
              <details className="key-details" open>
                <summary>What the model answered</summary>
                <pre>{read.reply || '(nothing)'}</pre>
              </details>
            )}
            <p className="hint">
              Check that the extracted text above has the questions in it. Try again, or choose another marking model.
            </p>
          </>
        )}
      </li>
    </ol>
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

export function StateIcon({ state, size = 15 }: { state: StepState; size?: number }) {
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

function ReadProgress({ run }: { run: KeyRead }) {
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
