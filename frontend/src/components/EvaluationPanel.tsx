import {
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  PencilLine,
  RotateCcw,
  Sigma,
  Square,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import type { DocumentInfo, EvaluatedAnswer, Evaluation, EvaluationSummary, Exam, ExamSummary, Question } from '../api'
import { isRunning, type EvaluationRun, type RunStep } from '../evaluationRunner'
import { formatMarks, questionLabel } from '../exams'
import { useElapsedSeconds } from '../hooks'
import { formatElapsed, pluralize } from '../utils'
import { MarksField } from './NumberField'
import { RichText } from './RichText'

export interface EvaluationPanelProps {
  document: DocumentInfo
  /** This document's evaluations, newest first. */
  summaries: EvaluationSummary[]
  details: Record<string, Evaluation>
  run: EvaluationRun | undefined
  exams: ExamSummary[]
  examDetails: Record<string, Exam>
  preview: boolean
  onPreviewChange: (preview: boolean) => void
  /** The model that marks answers again. */
  gradingModel: string
  onLoadEvaluation: (evaluationId: string) => void
  onLoadExam: (examId: string) => void
  onEvaluate: (examId?: string) => void
  onStop: () => void
  onDismissRun: () => void
  onGrade: (evaluation: Evaluation, questionIds?: string[]) => void
  onChangeAnswer: (
    evaluation: Evaluation,
    questionId: string,
    changes: { answer?: string; teacher_marks?: number | null },
  ) => Promise<boolean>
  onChangeStudent: (evaluation: Evaluation, changes: { student_name?: string; roll_number?: string }) => void
  onDelete: (evaluation: Evaluation) => void
  onSelectPage: (pageNumber: number) => void
  onOpenKey: (examId: string) => void
}

/** A script's marks: each answer the model found, with its marks and feedback. */
export function EvaluationPanel({
  document,
  summaries,
  details,
  run,
  exams,
  examDetails,
  preview,
  onPreviewChange,
  gradingModel,
  onLoadEvaluation,
  onLoadExam,
  onEvaluate,
  onStop,
  onDismissRun,
  onGrade,
  onChangeAnswer,
  onChangeStudent,
  onDelete,
  onSelectPage,
  onOpenKey,
}: EvaluationPanelProps) {
  const [chosenId, setChosenId] = useState<string | null>(null)
  const summary = summaries.find((candidate) => candidate.id === chosenId) ?? summaries[0]
  const evaluation = summary ? details[summary.id] : undefined
  const exam = evaluation ? examDetails[evaluation.exam_id] : undefined
  const running = isRunning(run)

  useEffect(() => {
    if (summary && !details[summary.id]) onLoadEvaluation(summary.id)
  }, [summary, details, onLoadEvaluation])
  useEffect(() => {
    if (
      evaluation &&
      !examDetails[evaluation.exam_id] &&
      exams.some((candidate) => candidate.id === evaluation.exam_id)
    ) {
      onLoadExam(evaluation.exam_id)
    }
  }, [evaluation, examDetails, exams, onLoadExam])

  const questions = new Map((exam?.questions ?? []).map((question) => [question.id, question]))
  const examName = (examId: string, fallback: string) =>
    exams.find((candidate) => candidate.id === examId)?.name ?? fallback
  const unmarked = evaluation ? evaluation.answers.filter((answer) => answer.marks === null).length : 0
  const marking = new Set(running ? (run?.marking ?? []) : [])

  return (
    <div className="result">
      <div className="panel-toolbar">
        <span className="panel-title">Marks</span>
        {summaries.length > 1 && (
          <select
            className="select select-small"
            value={summary?.id}
            onChange={(event) => setChosenId(event.target.value)}
            aria-label="Answer key"
          >
            {summaries.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {examName(candidate.exam_id, candidate.exam_name)}
              </option>
            ))}
          </select>
        )}
        <div className="toolbar-group toolbar-end">
          {evaluation && (
            <div className="segmented segmented-small" role="group" aria-label="Show the answers as">
              <button
                type="button"
                className={!preview ? 'is-active' : undefined}
                aria-pressed={!preview}
                onClick={() => onPreviewChange(false)}
              >
                Text
              </button>
              <button
                type="button"
                className={preview ? 'is-active' : undefined}
                aria-pressed={preview}
                onClick={() => onPreviewChange(true)}
              >
                <Sigma size={13} aria-hidden />
                Preview
              </button>
            </div>
          )}
          {evaluation && !running && (
            <button
              type="button"
              className="icon-btn icon-btn-danger"
              onClick={() => onDelete(evaluation)}
              title="Delete these marks"
              aria-label="Delete these marks"
            >
              <Trash2 size={16} />
            </button>
          )}
          {running ? (
            <button type="button" className="btn" onClick={onStop}>
              <Square size={14} aria-hidden />
              {run?.status === 'queued' ? 'Cancel' : 'Stop'}
            </button>
          ) : (
            summaries.length > 0 && (
              <button type="button" className="btn" onClick={() => onEvaluate(summary?.exam_id)}>
                <ClipboardCheck size={14} aria-hidden />
                Evaluate again
              </button>
            )
          )}
        </div>
      </div>

      <div className="result-body evaluation-body">
        {run && <RunStatus run={run} document={document} onDismiss={onDismissRun} />}

        {!summary && !running && run?.status !== 'error' && (
          <div className="result-empty">
            <ClipboardCheck size={36} strokeWidth={1.5} aria-hidden />
            <p>This paper has not been evaluated yet.</p>
            <button type="button" className="btn btn-primary btn-large" onClick={() => onEvaluate()}>
              <ClipboardCheck size={16} aria-hidden />
              Evaluate this paper
            </button>
            <p className="hint">
              {exams.length > 0
                ? 'Its answers are found in the extracted text and marked against an answer key.'
                : 'You will need an answer key: the questions with their model answers, marking scheme and marks.'}
            </p>
          </div>
        )}

        {summary && !evaluation && (
          <div className="result-waiting" role="status">
            <LoaderCircle size={22} className="spin" aria-hidden />
          </div>
        )}

        {evaluation && (
          <>
            <section className="evaluation-summary">
              <div className="student-fields">
                <InlineField
                  label="Student"
                  value={evaluation.student_name}
                  placeholder="Name not found"
                  onSave={(student_name) => onChangeStudent(evaluation, { student_name })}
                />
                <InlineField
                  label="Roll no."
                  value={evaluation.roll_number}
                  placeholder="Not found"
                  onSave={(roll_number) => onChangeStudent(evaluation, { roll_number })}
                />
              </div>
              <div
                className="score"
                aria-label={`${formatMarks(evaluation.marks)} out of ${formatMarks(evaluation.max_marks)} marks`}
              >
                <span className="score-value">{formatMarks(evaluation.marks)}</span>
                <span className="score-max">/ {formatMarks(evaluation.max_marks)}</span>
                {evaluation.max_marks > 0 && (
                  <span className="score-percent">{Math.round((evaluation.marks / evaluation.max_marks) * 100)}%</span>
                )}
              </div>
              <p className="evaluation-meta">
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => onOpenKey(evaluation.exam_id)}
                  title="Open the answer key"
                >
                  <KeyRound size={13} aria-hidden />
                  {examName(evaluation.exam_id, evaluation.exam_name)}
                </button>
                <span title="The model that found the answers in the script">{evaluation.model}</span>
                <span>{new Date(evaluation.updated_at).toLocaleString()}</span>
              </p>
              {unmarked > 0 && !running && (
                <div className="notice notice-warning">
                  <TriangleAlert size={16} className="notice-icon" aria-hidden />
                  <div className="notice-body">
                    {unmarked === 1 ? '1 answer has' : `${unmarked} answers have`} no marks yet, so the total is
                    incomplete.
                  </div>
                  <button type="button" className="btn btn-small" onClick={() => onGrade(evaluation)}>
                    Mark {unmarked === 1 ? 'it' : 'them'}
                  </button>
                </div>
              )}
              {evaluation.answers.every((answer) => answer.status === 'unanswered') && (
                <div className="notice notice-warning">
                  <TriangleAlert size={16} className="notice-icon" aria-hidden />
                  <div className="notice-body">
                    No answers to this answer key's questions were found in the script. Is it the right answer key, and
                    was the text extracted properly?
                  </div>
                </div>
              )}
            </section>

            <ol className="answer-list">
              {evaluation.answers.map((answer, index) => (
                <li key={answer.question_id}>
                  <AnswerCard
                    answer={answer}
                    index={index}
                    question={questions.get(answer.question_id)}
                    marking={marking.has(answer.question_id)}
                    busy={running}
                    preview={preview}
                    onSelectPage={onSelectPage}
                    onMarks={(teacher_marks) => onChangeAnswer(evaluation, answer.question_id, { teacher_marks })}
                    onSaveAnswer={async (text) => {
                      const saved = await onChangeAnswer(evaluation, answer.question_id, { answer: text })
                      if (saved && text.trim()) onGrade(evaluation, [answer.question_id])
                      return saved
                    }}
                    onGrade={() => onGrade(evaluation, [answer.question_id])}
                    gradingModel={gradingModel}
                  />
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </div>
  )
}

const STEP_LABELS: Record<RunStep, string> = {
  extract: 'Read the pages',
  split: 'Find the answers in the script',
  mark: 'Mark the answers',
}

function RunStatus({
  run,
  document,
  onDismiss,
}: {
  run: EvaluationRun
  document: DocumentInfo
  onDismiss: () => void
}) {
  const seconds = useElapsedSeconds(isRunning(run) ? run.stepStartedAt : undefined)
  if (run.status === 'queued') {
    return (
      <div className="run-status" role="status">
        <LoaderCircle size={16} className="spin" aria-hidden />
        <span>Waiting for the papers ahead of this one…</span>
      </div>
    )
  }
  if (run.status === 'error' || run.status === 'stopped') {
    const Icon = run.status === 'error' ? CircleAlert : TriangleAlert
    return (
      <div
        className={`notice notice-${run.status === 'error' ? 'error' : 'warning'}`}
        role={run.status === 'error' ? 'alert' : 'status'}
      >
        <Icon size={16} className="notice-icon" aria-hidden />
        <div className="notice-body">
          {run.status === 'error' ? (
            <>
              <strong>Evaluation failed.</strong> {run.error}
            </>
          ) : (
            'Stopped. The answers marked so far are kept.'
          )}
        </div>
        <button type="button" className="icon-btn" onClick={onDismiss} title="Dismiss" aria-label="Dismiss">
          <X size={14} />
        </button>
      </div>
    )
  }
  if (run.status !== 'running') return null

  const steps: RunStep[] = run.request.kind === 'evaluate' ? ['extract', 'split', 'mark'] : ['mark']
  const current = run.step ? steps.indexOf(run.step) : -1
  const withText = document.pages.filter((page) => page.ocr).length
  const detail: Record<RunStep, string> = {
    extract: `${withText} of ${pluralize(document.pages.length, 'page')} have text`,
    split: formatElapsed(seconds),
    mark: `${run.toMark - run.marking.length} of ${run.toMark} · ${formatElapsed(seconds)}`,
  }
  return (
    <ol className="steps run-steps" aria-label="Progress">
      {steps.map((step, index) => {
        const state = index < current ? 'is-done' : index === current ? 'is-current' : undefined
        return (
          <li key={step} className={state}>
            {state === 'is-done' ? (
              <CircleCheck size={16} aria-hidden />
            ) : state === 'is-current' ? (
              <LoaderCircle size={16} className="spin" aria-hidden />
            ) : (
              <span className="step-dot" aria-hidden />
            )}
            <span>{STEP_LABELS[step]}</span>
            {state === 'is-current' && <span className="step-detail">{detail[step]}</span>}
          </li>
        )
      })}
    </ol>
  )
}

function AnswerCard({
  answer,
  index,
  question,
  marking,
  busy,
  preview,
  onSelectPage,
  onMarks,
  onSaveAnswer,
  onGrade,
  gradingModel,
}: {
  answer: EvaluatedAnswer
  index: number
  question: Question | undefined
  marking: boolean
  busy: boolean
  preview: boolean
  onSelectPage: (pageNumber: number) => void
  onMarks: (teacherMarks: number | null) => void
  onSaveAnswer: (text: string) => Promise<boolean>
  onGrade: () => void
  gradingModel: string
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const label = questionLabel(answer.number, index)
  const status = marking
    ? { text: 'Marking…', className: 'is-marking' }
    : answer.status === 'unanswered'
      ? { text: 'Not answered', className: 'is-unanswered' }
      : answer.status === 'error'
        ? { text: 'Could not mark', className: 'is-error' }
        : answer.status === 'pending'
          ? { text: 'Not marked', className: 'is-pending' }
          : null

  const save = async () => {
    if (editing === null) return
    setSaving(true)
    const saved = await onSaveAnswer(editing)
    setSaving(false)
    if (saved) setEditing(null)
  }

  return (
    <article className={`answer-card${status ? ` ${status.className}` : ''}`} aria-label={label}>
      <header className="answer-head">
        <span className="answer-label">{label}</span>
        {answer.pages.map((page) => (
          <button
            key={page}
            type="button"
            className="page-chip"
            onClick={() => onSelectPage(page)}
            title={`Show page ${page}`}
          >
            p. {page}
          </button>
        ))}
        {status && (
          <span className="answer-status">
            {marking && <LoaderCircle size={12} className="spin" aria-hidden />}
            {status.text}
          </span>
        )}
        <label className="answer-marks">
          <MarksField
            className={`text-input marks-input${answer.teacher_marks !== null ? ' is-changed' : ''}`}
            value={answer.marks}
            max={answer.max_marks}
            placeholder="–"
            onCommit={(value) => onMarks(value === answer.ai_marks && answer.status === 'graded' ? null : value)}
            aria-label={`Marks for ${label}`}
            disabled={marking}
          />
          <span className="answer-max">/ {formatMarks(answer.max_marks)}</span>
        </label>
      </header>

      {editing !== null ? (
        <div className="answer-edit">
          <textarea
            className="textarea"
            rows={Math.min(16, Math.max(4, editing.split('\n').length + 1))}
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            aria-label={`Student's answer to ${label}`}
            autoFocus
          />
          <div className="answer-edit-actions">
            <span className="hint">Saving marks the corrected answer again.</span>
            <button type="button" className="btn btn-small" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn btn-small btn-primary" onClick={() => void save()} disabled={saving}>
              {saving && <LoaderCircle size={12} className="spin" aria-hidden />}
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="answer-text">
          <RichText
            text={answer.answer}
            preview={preview}
            empty="No answer to this question was found in the script."
          />
        </div>
      )}

      {answer.error && (
        <p className="answer-error">
          <CircleAlert size={14} aria-hidden />
          <span>
            {answer.status === 'graded' ? 'Marking it again failed: ' : ''}
            {answer.error}
          </span>
        </p>
      )}
      {answer.feedback && (
        <div className="answer-feedback" title={answer.model ? `Marked by ${answer.model}` : undefined}>
          <MessageSquareText size={14} aria-hidden />
          <RichText text={answer.feedback} preview={preview} />
        </div>
      )}
      {answer.teacher_marks !== null && (
        <p className="answer-override">
          You changed the marks
          {answer.status === 'graded' && answer.ai_marks !== null
            ? ` (the AI gave ${formatMarks(answer.ai_marks)})`
            : ''}
          .
          <button type="button" className="link-btn" onClick={() => onMarks(null)}>
            Undo
          </button>
        </p>
      )}

      <footer className="answer-foot">
        {question && (
          <details className="answer-key">
            <summary>Question and marking key</summary>
            <div className="answer-key-body">
              <span className="field-label">Question</span>
              <RichText text={question.question} preview={preview} empty="Not given" />
              <span className="field-label">Model answer</span>
              <RichText text={question.answer} preview={preview} empty="Not given" />
              <span className="field-label">Marking key</span>
              <RichText text={question.key} preview={preview} empty="Not given" />
            </div>
          </details>
        )}
        <div className="answer-actions">
          {editing === null && (
            <button type="button" className="btn btn-small" onClick={() => setEditing(answer.answer)} disabled={busy}>
              <PencilLine size={13} aria-hidden />
              {answer.answer ? 'Correct the answer' : 'Add the answer'}
            </button>
          )}
          {answer.answer && (
            <button
              type="button"
              className="btn btn-small"
              onClick={onGrade}
              disabled={busy}
              title={`Have ${gradingModel || 'the model'} mark this answer ${answer.status === 'graded' ? 'again' : ''}`}
            >
              <RotateCcw size={13} aria-hidden />
              {answer.status === 'graded' ? 'Mark again' : 'Mark'}
            </button>
          )}
        </div>
      </footer>
    </article>
  )
}

/** A text value that saves when the field loses focus or Enter is pressed. */
function InlineField({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string
  value: string
  placeholder: string
  onSave: (value: string) => void
}) {
  return (
    <label className="inline-field inline-field-text">
      <span>{label}</span>
      <input
        // A new input when the saved value changes, so it shows the new value.
        key={value}
        className="inline-input"
        defaultValue={value}
        placeholder={placeholder}
        maxLength={200}
        onBlur={(event) => {
          const next = event.target.value.trim()
          if (next !== value) onSave(next)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            event.currentTarget.value = value
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}
