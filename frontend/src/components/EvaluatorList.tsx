import { ClipboardCheck, LoaderCircle, Plus, TriangleAlert } from 'lucide-react'

import type { DocumentInfo, EvaluationSummary, ExamSummary } from '../api'
import { isRunning, type EvaluationRun } from '../evaluationRunner'
import { isKeyReading, type KeyRead } from '../evaluator'
import { classStats, formatMarks } from '../exams'
import { pluralize } from '../utils'

interface EvaluatorListProps {
  exams: ExamSummary[]
  loading: boolean
  documents: DocumentInfo[]
  evaluations: EvaluationSummary[]
  runs: ReadonlyMap<string, EvaluationRun>
  keyReads: Record<string, KeyRead>
  selectedId: string | null
  onSelect: (examId: string) => void
  onCreate: () => void
}

/** The sidebar: every evaluator, with how far it has got. */
export function EvaluatorList({
  exams,
  loading,
  documents,
  evaluations,
  runs,
  keyReads,
  selectedId,
  onSelect,
  onCreate,
}: EvaluatorListProps) {
  return (
    <aside className="sidebar" aria-label="Evaluators">
      <div className="sidebar-upload">
        <button type="button" className="btn btn-primary btn-block" onClick={onCreate}>
          <Plus size={16} aria-hidden />
          New evaluator
        </button>
        <p className="hint">An evaluator marks answer papers against one exam's questions and answer key.</p>
      </div>
      <div className="document-list">
        {loading && exams.length === 0 && <p className="sidebar-empty">Loading…</p>}
        {!loading && exams.length === 0 && <p className="sidebar-empty">No evaluators yet.</p>}
        <ul className="exam-list">
          {exams.map((exam) => {
            const papers = documents.filter((document) => document.exam_id === exam.id && document.role === 'script')
            const evaluated = evaluations.filter((evaluation) => evaluation.exam_id === exam.id)
            const marked = evaluated.filter((evaluation) => evaluation.complete)
            const working =
              isKeyReading(keyReads[exam.id]) || papers.some((document) => isRunning(runs.get(document.id)))
            // The same average as the results.
            const average = classStats(evaluated)?.average ?? null
            return (
              <li key={exam.id}>
                <button
                  type="button"
                  className={`exam-row${exam.id === selectedId ? ' is-selected' : ''}`}
                  onClick={() => onSelect(exam.id)}
                  aria-current={exam.id === selectedId ? 'page' : undefined}
                >
                  {working ? (
                    <LoaderCircle size={16} className="exam-row-icon spin" aria-hidden />
                  ) : (
                    <ClipboardCheck size={16} className="exam-row-icon" aria-hidden />
                  )}
                  <span className="exam-row-text">
                    <span className="exam-row-name">{exam.name}</span>
                    <span className="exam-row-meta">
                      {isKeyReading(keyReads[exam.id])
                        ? 'Reading the key…'
                        : exam.question_count > 0
                          ? `${pluralize(exam.question_count, 'question')} · ${formatMarks(exam.total_marks)} marks`
                          : exam.key_document_id
                            ? 'Questions not read yet'
                            : 'No key file yet'}
                    </span>
                    {papers.length > 0 && (
                      <span className="exam-row-meta">
                        {pluralize(papers.length, 'paper')} · {marked.length} marked
                        {average !== null && ` · average ${formatMarks(average)}`}
                      </span>
                    )}
                    {exam.question_count > 0 && exam.unmarked_questions.length > 0 && (
                      <span className="exam-row-warning">
                        <TriangleAlert size={12} aria-hidden />
                        Some questions have no marks
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </aside>
  )
}
