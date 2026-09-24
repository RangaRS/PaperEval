import { ClipboardCheck, RotateCcw, Square, Trash2, TriangleAlert } from 'lucide-react'

import type { DocumentInfo, EvaluationSummary } from '../api'
import { isRunning, type EvaluationRun } from '../evaluationRunner'
import { paperState } from '../evaluator'
import { formatMarks } from '../exams'
import type { OcrJob } from '../ocrQueue'
import { pluralize } from '../utils'
import { StateIcon } from './KeyReadProgress'
import { UploadZone } from './UploadButton'
import { UseEarlierUpload } from './UseEarlierUpload'

interface PapersStepProps {
  papers: DocumentInfo[]
  looseDocuments: DocumentInfo[]
  /** This evaluator's evaluations, newest first. */
  evaluations: EvaluationSummary[]
  runs: ReadonlyMap<string, EvaluationRun>
  jobs: ReadonlyMap<string, OcrJob>
  /** Why papers can't be marked yet, if they can't. */
  keyProblem: string | null
  accept: string[]
  uploading: boolean
  onUploadPapers: (files: File[]) => void
  onUseDocument: (documentId: string) => void
  onEvaluate: (documentId: string) => void
  onEvaluateAll: () => void
  onStop: (documentId: string) => void
  onStopAll: () => void
  onOpenPaper: (documentId: string) => void
  onDeletePaper: (document: DocumentInfo) => void
  onGoToKey: () => void
}

/** Step 2 of an evaluator: the students' answer papers, each marked against the key as it is uploaded. */
export function PapersStep({
  papers,
  looseDocuments,
  evaluations,
  runs,
  jobs,
  keyProblem,
  accept,
  uploading,
  onUploadPapers,
  onUseDocument,
  onEvaluate,
  onEvaluateAll,
  onStop,
  onStopAll,
  onOpenPaper,
  onDeletePaper,
  onGoToKey,
}: PapersStepProps) {
  const rows = papers.map((document) => {
    const evaluation = evaluations.find((candidate) => candidate.document_id === document.id)
    const run = runs.get(document.id)
    return { document, evaluation, run, state: paperState(document, run, evaluation, jobs) }
  })
  const marked = rows.filter((row) => row.state.kind === 'done').length
  const busy = rows.filter((row) => row.state.kind === 'running' || row.state.kind === 'waiting').length
  const unevaluated = rows.filter((row) => ['idle', 'failed', 'partial'].includes(row.state.kind)).length

  return (
    <div className="step-body">
      {keyProblem && (
        <div className="notice notice-warning">
          <TriangleAlert size={16} className="notice-icon" aria-hidden />
          <div className="notice-body">
            {keyProblem} Answer papers you upload now are marked when you press <strong>Evaluate all</strong>.
          </div>
          <button type="button" className="btn btn-small" onClick={onGoToKey}>
            Go to step 1
          </button>
        </div>
      )}

      <section className="step-card" aria-label="Upload answer papers">
        <UploadZone
          title="Upload the students' answer papers"
          hint="One PDF (or image) per student. Each paper is marked against this evaluator's key: its pages are read one at a time, the text is split into the answers to each question, and every answer is marked. Papers are done one after another."
          label={uploading ? 'Uploading…' : 'Upload answer papers'}
          accept={accept}
          busy={uploading}
          multiple
          compact={rows.length > 0}
          onFiles={onUploadPapers}
        />
        <UseEarlierUpload
          documents={looseDocuments}
          label="Or add a file you uploaded earlier:"
          button="Add it"
          onUse={onUseDocument}
        />
      </section>

      {rows.length > 0 && (
        <section className="step-card" aria-label="Answer papers">
          <header className="step-card-header">
            <h2>Answer papers</h2>
            <span className="muted">
              {pluralize(rows.length, 'paper')} · {marked} marked{busy > 0 ? ` · ${busy} in progress` : ''}
            </span>
            <div className="toolbar-group">
              {busy > 0 && (
                <button type="button" className="btn btn-small" onClick={onStopAll}>
                  <Square size={12} aria-hidden />
                  Stop all
                </button>
              )}
              {unevaluated > 0 && (
                <button
                  type="button"
                  className="btn btn-small btn-accent"
                  onClick={onEvaluateAll}
                  disabled={keyProblem !== null}
                  title={keyProblem ?? 'Mark every paper that is not fully marked yet'}
                >
                  <ClipboardCheck size={13} aria-hidden />
                  Evaluate all ({unevaluated})
                </button>
              )}
            </div>
          </header>
          <ul className="paper-list">
            {rows.map(({ document, evaluation, run, state }) => (
              <li key={document.id} className={`paper-row is-${state.kind}`}>
                <button
                  type="button"
                  className="paper-row-main"
                  onClick={() => onOpenPaper(document.id)}
                  title="Review this paper"
                >
                  <img className="paper-thumb" src={document.pages[0]?.thumbnail_url} alt="" loading="lazy" />
                  <span className="paper-row-text">
                    <span className="paper-row-name">{evaluation?.student_name || document.filename}</span>
                    <span className="paper-row-meta">
                      {[
                        evaluation?.student_name ? document.filename : null,
                        evaluation?.roll_number ? `Roll no. ${evaluation.roll_number}` : null,
                        pluralize(document.pages.length, 'page'),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </button>
                <span className="paper-row-status" title={state.label}>
                  <StateIcon
                    state={
                      state.kind === 'done'
                        ? 'done'
                        : state.kind === 'running'
                          ? 'running'
                          : state.kind === 'failed'
                            ? 'failed'
                            : 'waiting'
                    }
                  />
                  <span>{state.label}</span>
                </span>
                <span className="paper-row-marks">
                  {evaluation ? (
                    <>
                      <strong>{formatMarks(evaluation.marks)}</strong> / {formatMarks(evaluation.max_marks)}
                    </>
                  ) : (
                    <span className="muted">–</span>
                  )}
                </span>
                <span className="paper-row-actions">
                  {isRunning(run) ? (
                    <button type="button" className="btn btn-small" onClick={() => onStop(document.id)}>
                      <Square size={12} aria-hidden />
                      Stop
                    </button>
                  ) : state.kind === 'done' ? (
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onEvaluate(document.id)}
                      disabled={keyProblem !== null}
                      title="Evaluate this paper again"
                      aria-label={`Evaluate ${document.filename} again`}
                    >
                      <RotateCcw size={15} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-small btn-accent"
                      onClick={() => onEvaluate(document.id)}
                      disabled={keyProblem !== null}
                      title={keyProblem ?? undefined}
                    >
                      <ClipboardCheck size={12} aria-hidden />
                      {state.kind === 'failed' ? 'Try again' : state.kind === 'partial' ? 'Finish' : 'Evaluate'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn icon-btn-danger"
                    onClick={() => onDeletePaper(document)}
                    title="Delete this paper"
                    aria-label={`Delete ${document.filename}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
