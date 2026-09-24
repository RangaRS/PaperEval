import { FileJson, FileSearch, KeyRound, LoaderCircle, Plus, TriangleAlert } from 'lucide-react'
import { useRef } from 'react'

import type { EvaluationSummary, ExamSummary } from '../api'
import { formatMarks } from '../exams'
import { pluralize } from '../utils'

interface ExamListProps {
  exams: ExamSummary[]
  loading: boolean
  evaluations: EvaluationSummary[]
  selectedId: string | null
  onSelect: (examId: string) => void
  onCreate: () => void
  onFromDocument: () => void
  onImport: (file: File) => void
}

/** The answer keys, with ways to create new ones. */
export function ExamList({
  exams,
  loading,
  evaluations,
  selectedId,
  onSelect,
  onCreate,
  onFromDocument,
  onImport,
}: ExamListProps) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <div className="sidebar-upload">
        <button type="button" className="btn btn-primary btn-block" onClick={onCreate}>
          <Plus size={16} aria-hidden />
          New answer key
        </button>
        <div className="sidebar-buttons">
          <button
            type="button"
            className="btn btn-small"
            onClick={onFromDocument}
            title="Read an answer key from an uploaded PDF or image"
          >
            <FileSearch size={14} aria-hidden />
            From a document
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => input.current?.click()}
            title="Import an answer key saved as JSON"
          >
            <FileJson size={14} aria-hidden />
            Import JSON
          </button>
          <input
            ref={input}
            type="file"
            hidden
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) onImport(file)
            }}
          />
        </div>
      </div>
      <div className="document-list">
        {loading && exams.length === 0 && <p className="sidebar-empty">Loading answer keys…</p>}
        {!loading && exams.length === 0 && (
          <p className="sidebar-empty">
            No answer keys yet. An answer key lists an exam's questions with their model answers, marking scheme and
            marks.
          </p>
        )}
        <ul className="exam-list">
          {exams.map((exam) => {
            const evaluated = evaluations.filter((evaluation) => evaluation.exam_id === exam.id).length
            return (
              <li key={exam.id}>
                <button
                  type="button"
                  className={`exam-row${exam.id === selectedId ? ' is-selected' : ''}`}
                  onClick={() => onSelect(exam.id)}
                  aria-current={exam.id === selectedId ? 'page' : undefined}
                >
                  <KeyRound size={16} className="exam-row-icon" aria-hidden />
                  <span className="exam-row-text">
                    <span className="exam-row-name">{exam.name}</span>
                    <span className="exam-row-meta">
                      {pluralize(exam.question_count, 'question')} · {formatMarks(exam.total_marks)} marks
                      {evaluated > 0 && ` · ${pluralize(evaluated, 'paper')} evaluated`}
                    </span>
                    {exam.unmarked_questions.length > 0 && exam.question_count > 0 && (
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
    </>
  )
}

/** Shown in the main area while there are no answer keys. */
export function ExamsEmptyState({
  loading,
  onCreate,
  onFromDocument,
}: {
  loading: boolean
  onCreate: () => void
  onFromDocument: () => void
}) {
  if (loading) {
    return (
      <div className="empty-state">
        <LoaderCircle size={28} className="spin" aria-hidden />
      </div>
    )
  }
  return (
    <div className="empty-state">
      <KeyRound size={40} strokeWidth={1.5} aria-hidden />
      <h2>Create an answer key</h2>
      <p>
        An answer key holds an exam's questions, each with its model answer, marking key and marks. Answer scripts are
        split into answers and marked against it.
      </p>
      <div className="empty-state-actions">
        <button type="button" className="btn btn-primary btn-large" onClick={onCreate}>
          <Plus size={16} aria-hidden />
          New answer key
        </button>
        <button type="button" className="btn btn-large" onClick={onFromDocument}>
          <FileSearch size={16} aria-hidden />
          Read one from a document
        </button>
      </div>
      <p className="hint">You can also import an answer key saved as JSON.</p>
    </div>
  )
}
