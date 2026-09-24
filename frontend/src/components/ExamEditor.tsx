import {
  ArrowDown,
  ArrowUp,
  ClipboardCheck,
  Download,
  FileJson,
  LoaderCircle,
  Plus,
  Save,
  Sigma,
  Square,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { api, type DocumentInfo, type EvaluationSummary, type Exam, type ExamDraft, type Question } from '../api'
import { isRunning, type EvaluationRun } from '../evaluationRunner'
import { answerKeyFile, blankQuestion, classStats, formatMarks, questionLabel, totalMarks } from '../exams'
import { isBoolean, useLocalStorage } from '../hooks'
import { downloadBlob, downloadText, errorMessage, pluralize } from '../utils'
import { NumberField } from './NumberField'
import { RichText } from './RichText'

type Tab = 'questions' | 'results'

interface ExamEditorProps {
  examId: string
  evaluations: EvaluationSummary[]
  runs: ReadonlyMap<string, EvaluationRun>
  documents: DocumentInfo[]
  onSaved: (exam: Exam) => void
  onDelete: (exam: Exam) => void
  onOpenPaper: (documentId: string) => void
  onEvaluatePapers: () => void
  onStopRuns: (documentIds: string[]) => void
  onDirtyChange: (dirty: boolean) => void
  onError: (message: string) => void
}

const toDraft = (exam: Exam): ExamDraft => ({ name: exam.name, questions: exam.questions })
const sameDraft = (a: ExamDraft, b: ExamDraft) => JSON.stringify(a) === JSON.stringify(b)

/** An answer key's questions, to edit, and the marks of the papers evaluated with it. */
export function ExamEditor({
  examId,
  evaluations,
  runs,
  documents,
  onSaved,
  onDelete,
  onOpenPaper,
  onEvaluatePapers,
  onStopRuns,
  onDirtyChange,
  onError,
}: ExamEditorProps) {
  const [saved, setSaved] = useState<Exam | null>(null)
  const [draft, setDraft] = useState<ExamDraft | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<Tab>('questions')
  const [preview, setPreview] = useLocalStorage('papereval.keyPreview', false, isBoolean)
  const [focusId, setFocusId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getExam(examId)
      .then((exam) => {
        if (cancelled) return
        setSaved(exam)
        setDraft(toDraft(exam))
      })
      .catch((error) => !cancelled && setLoadError(errorMessage(error)))
    return () => {
      cancelled = true
    }
  }, [examId])

  const dirty = saved !== null && draft !== null && !sameDraft(draft, toDraft(saved))

  useEffect(() => {
    onDirtyChange(dirty)
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  if (loadError) {
    return (
      <div className="empty-state">
        <TriangleAlert size={36} strokeWidth={1.5} aria-hidden />
        <h2>Could not open the answer key</h2>
        <p>{loadError}</p>
      </div>
    )
  }
  if (!saved || !draft) {
    return (
      <div className="empty-state">
        <LoaderCircle size={28} className="spin" aria-hidden />
      </div>
    )
  }

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const exam = await api.updateExam(examId, {
        name: draft.name.trim() || 'Untitled answer key',
        questions: draft.questions,
      })
      setSaved(exam)
      setDraft(toDraft(exam))
      onSaved(exam)
    } catch (error) {
      onError(`Could not save the answer key: ${errorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const change = (changes: Partial<ExamDraft>) => setDraft((current) => current && { ...current, ...changes })
  const changeQuestion = (id: string, changes: Partial<Question>) =>
    setDraft(
      (current) =>
        current && {
          ...current,
          questions: current.questions.map((question) => (question.id === id ? { ...question, ...changes } : question)),
        },
    )
  const move = (index: number, offset: number) =>
    setDraft((current) => {
      if (!current) return current
      const questions = [...current.questions]
      const [question] = questions.splice(index, 1)
      questions.splice(index + offset, 0, question)
      return { ...current, questions }
    })
  const remove = (question: Question, index: number) => {
    const hasContent = question.question || question.answer || question.key
    if (hasContent && !window.confirm(`Remove ${questionLabel(question.number, index)}?`)) return
    change({ questions: draft.questions.filter((candidate) => candidate.id !== question.id) })
  }
  const add = () => {
    const question = blankQuestion(draft.questions)
    change({ questions: [...draft.questions, question] })
    setFocusId(question.id)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }

  const exportJson = () =>
    downloadText(
      `${draft.name.trim() || 'answer key'}.json`,
      JSON.stringify(answerKeyFile(draft), null, 2),
      'application/json',
    )

  const total = totalMarks(draft.questions)
  const unmarked = draft.questions.filter((question) => question.max_marks <= 0).length
  const active = [...runs.values()].filter(
    (run) => isRunning(run) && run.request.kind === 'evaluate' && run.request.examId === examId,
  )

  return (
    <section className="exam-editor" onKeyDown={onKeyDown} aria-label={`Answer key ${saved.name}`}>
      <div className="exam-header">
        <div className="exam-title">
          <input
            className="exam-name"
            value={draft.name}
            onChange={(event) => change({ name: event.target.value })}
            placeholder="Name of the exam"
            aria-label="Name of the answer key"
            maxLength={200}
          />
          <p className="exam-meta">
            {pluralize(draft.questions.length, 'question')} · {formatMarks(total)} marks
            {unmarked > 0 && (
              <span className="exam-meta-warning">
                <TriangleAlert size={13} aria-hidden />
                {unmarked === 1 ? '1 question has' : `${unmarked} questions have`} no marks
              </span>
            )}
          </p>
        </div>
        <div className="exam-actions">
          {dirty && (
            <button type="button" className="btn" onClick={() => setDraft(toDraft(saved))} disabled={saving}>
              <Undo2 size={14} aria-hidden />
              Discard changes
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Save size={14} aria-hidden />}
            {dirty ? 'Save' : 'Saved'}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={exportJson}
            title="Export as JSON"
            aria-label="Export as JSON"
          >
            <FileJson size={17} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            onClick={() => onDelete(saved)}
            title="Delete answer key"
            aria-label="Delete answer key"
          >
            <Trash2 size={17} />
          </button>
        </div>
      </div>

      <div className="tabs" role="tablist" aria-label="Answer key">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'questions'}
          className={tab === 'questions' ? 'is-active' : undefined}
          onClick={() => setTab('questions')}
        >
          Questions
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'results'}
          className={tab === 'results' ? 'is-active' : undefined}
          onClick={() => setTab('results')}
        >
          Results
          {evaluations.length > 0 && <span className="tab-count">{evaluations.length}</span>}
        </button>
      </div>

      {tab === 'questions' ? (
        <div className="exam-body">
          <div className="exam-toolbar">
            <div className="segmented segmented-small" role="group" aria-label="Show the questions">
              <button
                type="button"
                className={!preview ? 'is-active' : undefined}
                aria-pressed={!preview}
                onClick={() => setPreview(false)}
              >
                Edit
              </button>
              <button
                type="button"
                className={preview ? 'is-active' : undefined}
                aria-pressed={preview}
                onClick={() => setPreview(true)}
              >
                <Sigma size={13} aria-hidden />
                Preview
              </button>
            </div>
            <span className="hint">
              Write maths in LaTeX, like <code>$\frac{'{a}{b}'}$</code>. Ctrl+S saves.
            </span>
          </div>
          {draft.questions.length === 0 && <p className="exam-empty">No questions yet. Add the first one below.</p>}
          <ol className="question-list">
            {draft.questions.map((question, index) => (
              <li key={question.id}>
                <QuestionCard
                  question={question}
                  index={index}
                  count={draft.questions.length}
                  preview={preview}
                  autoFocus={question.id === focusId}
                  onChange={(changes) => changeQuestion(question.id, changes)}
                  onMove={(offset) => move(index, offset)}
                  onRemove={() => remove(question, index)}
                />
              </li>
            ))}
          </ol>
          <button type="button" className="btn add-question" onClick={add}>
            <Plus size={15} aria-hidden />
            Add question
          </button>
        </div>
      ) : (
        <div className="exam-body">
          <Results
            exam={saved}
            evaluations={evaluations}
            active={active.map((run) => run.request.documentId)}
            documents={documents}
            onOpenPaper={onOpenPaper}
            onEvaluatePapers={onEvaluatePapers}
            onStopRuns={onStopRuns}
            onError={onError}
            unsaved={dirty}
          />
        </div>
      )}
    </section>
  )
}

function QuestionCard({
  question,
  index,
  count,
  preview,
  autoFocus,
  onChange,
  onMove,
  onRemove,
}: {
  question: Question
  index: number
  count: number
  preview: boolean
  autoFocus: boolean
  onChange: (changes: Partial<Question>) => void
  onMove: (offset: number) => void
  onRemove: () => void
}) {
  const label = questionLabel(question.number, index)
  const questionInput = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (autoFocus) questionInput.current?.focus()
  }, [autoFocus])

  return (
    <article className="question-card" aria-label={label}>
      <div className="question-card-head">
        <label className="inline-field">
          <span>No.</span>
          <input
            className="text-input number-input"
            value={question.number}
            onChange={(event) => onChange({ number: event.target.value })}
            placeholder={String(index + 1)}
            maxLength={40}
            aria-label={`Number of question ${index + 1}`}
          />
        </label>
        <label className="inline-field">
          <span>Marks</span>
          <NumberField
            className="text-input marks-input"
            value={question.max_marks}
            max={1000}
            onChange={(max_marks) => onChange({ max_marks })}
            aria-label={`Marks for ${label}`}
          />
        </label>
        {question.max_marks <= 0 && (
          <span className="question-warning">
            <TriangleAlert size={13} aria-hidden />
            Set the marks
          </span>
        )}
        <div className="question-card-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            title="Move up"
            aria-label={`Move ${label} up`}
          >
            <ArrowUp size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            title="Move down"
            aria-label={`Move ${label} down`}
          >
            <ArrowDown size={15} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            onClick={onRemove}
            title="Remove question"
            aria-label={`Remove ${label}`}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>
      {preview ? (
        <div className="question-preview">
          <PreviewField label="Question" text={question.question} />
          <PreviewField label="Model answer" text={question.answer} />
          <PreviewField label="Marking key" text={question.key} />
        </div>
      ) : (
        <>
          <label className="field">
            <span className="field-label">Question</span>
            <textarea
              ref={questionInput}
              className="textarea"
              rows={2}
              value={question.question}
              onChange={(event) => onChange({ question: event.target.value })}
              placeholder="The question as printed on the paper"
            />
          </label>
          <label className="field">
            <span className="field-label">Model answer</span>
            <textarea
              className="textarea"
              rows={4}
              value={question.answer}
              onChange={(event) => onChange({ answer: event.target.value })}
              placeholder="The expected answer or worked solution"
            />
          </label>
          <label className="field">
            <span className="field-label">Marking key</span>
            <textarea
              className="textarea"
              rows={2}
              value={question.key}
              onChange={(event) => onChange({ key: event.target.value })}
              placeholder="How marks are given, e.g. Formula: 1 mark. Working: 2 marks. Final answer: 1 mark."
            />
          </label>
        </>
      )}
    </article>
  )
}

function PreviewField({ label, text }: { label: string; text: string }) {
  return (
    <div className="preview-field">
      <span className="field-label">{label}</span>
      <RichText text={text} preview empty="Not given" />
    </div>
  )
}

function Results({
  exam,
  evaluations,
  active,
  documents,
  onOpenPaper,
  onEvaluatePapers,
  onStopRuns,
  onError,
  unsaved,
}: {
  exam: Exam
  evaluations: EvaluationSummary[]
  active: string[]
  documents: DocumentInfo[]
  onOpenPaper: (documentId: string) => void
  onEvaluatePapers: () => void
  onStopRuns: (documentIds: string[]) => void
  onError: (message: string) => void
  unsaved: boolean
}) {
  const [downloading, setDownloading] = useState(false)
  const stats = classStats(evaluations)

  const downloadCsv = async () => {
    setDownloading(true)
    try {
      downloadBlob(`${exam.name} results.csv`, await api.resultsCsv(exam.id))
    } catch (error) {
      onError(`Could not download the results: ${errorMessage(error)}`)
    } finally {
      setDownloading(false)
    }
  }
  const rows = [...evaluations].sort(
    (a, b) =>
      Number(!a.roll_number) - Number(!b.roll_number) ||
      a.roll_number.localeCompare(b.roll_number, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.student_name.localeCompare(b.student_name, undefined, { numeric: true, sensitivity: 'base' }) ||
      a.document_name.localeCompare(b.document_name, undefined, { numeric: true, sensitivity: 'base' }),
  )
  const names = new Map(documents.map((document) => [document.id, document.filename]))

  return (
    <>
      <div className="exam-toolbar">
        <span className="results-stats">
          {stats
            ? `${pluralize(stats.count, 'paper')} · average ${formatMarks(stats.average)} · highest ${formatMarks(stats.highest)} · lowest ${formatMarks(stats.lowest)}`
            : 'No papers evaluated yet'}
        </span>
        <div className="toolbar-group">
          <button
            type="button"
            className="btn btn-small btn-accent"
            onClick={onEvaluatePapers}
            disabled={documents.length === 0}
          >
            <ClipboardCheck size={14} aria-hidden />
            Evaluate papers…
          </button>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void downloadCsv()}
            disabled={evaluations.length === 0 || downloading}
            title="Everyone's marks for each question, for Excel or Google Sheets"
          >
            {downloading ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Download size={14} aria-hidden />}
            Download CSV
          </button>
        </div>
      </div>
      {unsaved && (
        <p className="hint results-note">The table uses the saved answer key. Save your changes to see them here.</p>
      )}
      {active.length > 0 && (
        <div className="results-running" role="status">
          <LoaderCircle size={15} className="spin" aria-hidden />
          <span>
            Evaluating {active.length === 1 ? (names.get(active[0]) ?? '1 paper') : `${active.length} papers`}…
          </span>
          <button type="button" className="btn btn-small" onClick={() => onStopRuns(active)}>
            <Square size={12} aria-hidden />
            Stop
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="exam-empty">
          <p>
            Evaluate papers against this answer key to see everyone's marks here. Upload the scripts in the Papers tab,
            one file per student.
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="results-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Roll no.</th>
                <th>Paper</th>
                {exam.questions.map((question, index) => (
                  <th key={question.id} className="num">
                    {questionLabel(question.number, index)}
                    <span className="th-max">/{formatMarks(question.max_marks)}</span>
                  </th>
                ))}
                <th className="num">
                  Total<span className="th-max">/{formatMarks(exam.total_marks)}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((evaluation) => {
                const answers = new Map(evaluation.answers.map((answer) => [answer.question_id, answer]))
                return (
                  <tr
                    key={evaluation.id}
                    tabIndex={0}
                    onClick={() => onOpenPaper(evaluation.document_id)}
                    onKeyDown={(event) => event.key === 'Enter' && onOpenPaper(evaluation.document_id)}
                    title="Open this paper"
                  >
                    <td>{evaluation.student_name || <span className="muted">Not found</span>}</td>
                    <td>{evaluation.roll_number || <span className="muted">–</span>}</td>
                    <td className="results-paper">{evaluation.document_name}</td>
                    {exam.questions.map((question) => {
                      const answer = answers.get(question.id)
                      const marks = answer?.marks
                      return (
                        <td
                          key={question.id}
                          className={`num${answer?.status === 'unanswered' ? ' is-unanswered' : ''}`}
                          title={answer?.status === 'unanswered' ? 'Not answered' : undefined}
                        >
                          {marks === null || marks === undefined ? '–' : formatMarks(marks)}
                        </td>
                      )
                    })}
                    <td className="num results-total">
                      {formatMarks(evaluation.marks)}
                      {!evaluation.complete && (
                        <TriangleAlert
                          size={13}
                          className="results-incomplete"
                          aria-label="Some answers have no marks"
                        />
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
