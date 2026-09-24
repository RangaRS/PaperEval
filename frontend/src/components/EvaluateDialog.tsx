import { ClipboardCheck, KeyRound, TriangleAlert } from 'lucide-react'
import { useState } from 'react'

import type { DocumentInfo, EvaluationSummary, ExamSummary, ModelInfo } from '../api'
import { formatMarks, joinList } from '../exams'
import { pluralize } from '../utils'
import { Dialog } from './Dialog'
import { ModelSelect } from './ModelSelect'

export interface EvaluateTarget {
  /** The papers to preselect. */
  documentIds: string[]
  examId?: string
  /** Choose among all papers (true) or evaluate just the given ones. */
  choosePapers: boolean
}

interface EvaluateDialogProps {
  target: EvaluateTarget | null
  onClose: () => void
  documents: DocumentInfo[]
  exams: ExamSummary[]
  evaluations: EvaluationSummary[]
  model: string
  onModelChange: (model: string) => void
  models: ModelInfo[]
  addedModels: string[]
  /** The vision model that reads pages without text. */
  ocrModel: string
  onStart: (documentIds: string[], examId: string, model: string) => void
  onCreateKey: () => void
}

/** Choose an answer key, papers and a model, then evaluate the papers. */
export function EvaluateDialog(props: EvaluateDialogProps) {
  const { target, onClose } = props
  return (
    <Dialog open={target !== null} title="Evaluate answer scripts" onClose={onClose}>
      {/* A new form for each opening, so its choices start from the target. */}
      {target && <EvaluateForm key={JSON.stringify(target)} {...props} target={target} />}
    </Dialog>
  )
}

function EvaluateForm({
  target,
  onClose,
  documents,
  exams,
  evaluations,
  model,
  onModelChange,
  models,
  addedModels,
  ocrModel,
  onStart,
  onCreateKey,
}: EvaluateDialogProps & { target: EvaluateTarget }) {
  const [examId, setExamId] = useState(() => target.examId ?? mostRecentKey(evaluations, exams) ?? '')
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(target.documentIds))

  const exam = exams.find((candidate) => candidate.id === examId)
  const papers = target.choosePapers
    ? documents
    : documents.filter((document) => target.documentIds.includes(document.id))
  const selected = papers.filter((document) => chosen.has(document.id))
  const marked = (documentId: string) =>
    evaluations.find((evaluation) => evaluation.document_id === documentId && evaluation.exam_id === examId)
  const replacing = selected.filter((document) => marked(document.id)).length
  const withoutText = selected.filter((document) => document.pages.some((page) => !page.ocr))

  if (exams.length === 0) {
    return (
      <div className="dialog-empty">
        <KeyRound size={32} strokeWidth={1.5} aria-hidden />
        <p>
          Papers are marked against an answer key: the exam's questions with their model answers, marking scheme and
          marks. There is no answer key yet.
        </p>
        <button type="button" className="btn btn-primary" onClick={onCreateKey}>
          Create an answer key
        </button>
      </div>
    )
  }

  const problem = !exam
    ? 'Choose an answer key.'
    : exam.question_count === 0
      ? 'This answer key has no questions yet.'
      : exam.unmarked_questions.length > 0
        ? `Set the marks for ${joinList(exam.unmarked_questions)} in the answer key first.`
        : selected.length === 0
          ? 'Choose the papers to evaluate.'
          : !model
            ? 'Choose a model for marking.'
            : withoutText.length > 0 && !ocrModel
              ? 'Some pages have no text yet. Choose a vision model at the top to read them.'
              : null

  return (
    <form
      className="dialog-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (problem) return
        onStart(
          selected.map((document) => document.id),
          examId,
          model,
        )
        onClose()
      }}
    >
      <label className="field">
        <span className="field-label">Answer key</span>
        <select className="select" value={examId} onChange={(event) => setExamId(event.target.value)}>
          {!exam && <option value="">Choose an answer key</option>}
          {exams.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name} ({pluralize(candidate.question_count, 'question')}, {formatMarks(candidate.total_marks)}{' '}
              marks)
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        <span className="field-label">{target.choosePapers ? 'Papers' : 'Paper'}</span>
        {target.choosePapers ? (
          <>
            <div className="checklist-actions">
              <button type="button" className="link-btn" onClick={() => setChosen(new Set(papers.map((d) => d.id)))}>
                Select all
              </button>
              <button
                type="button"
                className="link-btn"
                onClick={() => setChosen(new Set(papers.filter((d) => !marked(d.id)).map((d) => d.id)))}
              >
                Only papers not evaluated with this key
              </button>
              <button type="button" className="link-btn" onClick={() => setChosen(new Set())}>
                None
              </button>
            </div>
            <ul className="checklist">
              {papers.map((document) => {
                const evaluation = marked(document.id)
                return (
                  <li key={document.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={chosen.has(document.id)}
                        onChange={(event) => {
                          const next = new Set(chosen)
                          if (event.target.checked) next.add(document.id)
                          else next.delete(document.id)
                          setChosen(next)
                        }}
                      />
                      <span className="truncate">{document.filename}</span>
                      <span className="checklist-note">
                        {evaluation
                          ? `${formatMarks(evaluation.marks)}/${formatMarks(evaluation.max_marks)}`
                          : pluralize(document.pages.length, 'page')}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </>
        ) : (
          <p className="field-value">
            {papers.map((document) => `${document.filename} (${pluralize(document.pages.length, 'page')})`).join(', ')}
          </p>
        )}
      </div>

      <label className="field">
        <span className="field-label">Model for marking</span>
        <ModelSelect value={model} onChange={onModelChange} models={models} added={addedModels} />
        <span className="hint">
          Splits each script into answers and marks them. It does not need to read images: a strong text model is best.
        </span>
      </label>

      <p className="hint">
        {withoutText.length > 0
          ? `Pages without text are read first with ${ocrModel || 'the vision model chosen at the top'}. `
          : ''}
        Each script is split into the answers to the key's questions, and each answer is marked against the model answer
        and marking key. You can check and change every mark afterwards.
      </p>

      {replacing > 0 && (
        <p className="dialog-warning">
          <TriangleAlert size={15} aria-hidden />
          {replacing === 1 && selected.length === 1
            ? 'This paper already has marks from this answer key. Evaluating it again replaces them, including marks you changed.'
            : `${pluralize(replacing, 'paper')} already have marks from this answer key. Evaluating them again replaces those marks, including marks you changed.`}
        </p>
      )}
      {problem && exam && <p className="dialog-problem">{problem}</p>}

      <footer className="dialog-footer">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={problem !== null}>
          <ClipboardCheck size={15} aria-hidden />
          {selected.length > 1 ? `Evaluate ${selected.length} papers` : 'Evaluate'}
        </button>
      </footer>
    </form>
  )
}

/** The answer key used most recently, or else the newest one. */
function mostRecentKey(evaluations: EvaluationSummary[], exams: ExamSummary[]): string | undefined {
  const recent = evaluations.find((evaluation) => exams.some((exam) => exam.id === evaluation.exam_id))
  return recent?.exam_id ?? exams[0]?.id
}
