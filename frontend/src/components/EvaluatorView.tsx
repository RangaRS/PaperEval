import { FileJson, LoaderCircle, Save, Trash2, TriangleAlert, Undo2 } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'

import { api, type Exam, type ExamDraft, type ExamSummary, type ModelInfo } from '../api'
import type { EvaluatorTab } from '../evaluator'
import { answerKeyFile } from '../exams'
import { downloadText, errorMessage, pluralize } from '../utils'
import { ModelSelect } from './ModelSelect'

const toDraft = (exam: Exam): ExamDraft => ({ name: exam.name, questions: exam.questions })
const sameDraft = (a: ExamDraft, b: ExamDraft) => JSON.stringify(a) === JSON.stringify(b)

interface EvaluatorViewProps {
  summary: ExamSummary
  /** The evaluator with its questions, once loaded. */
  exam: Exam | undefined
  tab: EvaluatorTab
  onTabChange: (tab: EvaluatorTab) => void
  paperCount: number
  markedCount: number
  gradingModel: string
  onGradingModelChange: (model: string) => void
  models: ModelInfo[]
  addedModels: string[]
  onSaved: (exam: Exam) => void
  onDelete: () => void
  onDirtyChange: (dirty: boolean) => void
  onError: (message: string) => void
  /** The content of each step, given the questions being edited. */
  children: (draft: ExamDraft, change: (changes: Partial<ExamDraft>) => void, dirty: boolean) => ReactNode
}

/** An evaluator: its name and marking model, and its three steps as tabs. */
export function EvaluatorView({
  summary,
  exam,
  tab,
  onTabChange,
  paperCount,
  markedCount,
  gradingModel,
  onGradingModelChange,
  models,
  addedModels,
  onSaved,
  onDelete,
  onDirtyChange,
  onError,
  children,
}: EvaluatorViewProps) {
  const [draft, setDraft] = useState<ExamDraft | null>(exam ? toDraft(exam) : null)
  const [synced, setSynced] = useState(exam?.updated_at)
  const [saving, setSaving] = useState(false)
  if (exam && exam.updated_at !== synced) {
    // Saved elsewhere, for example when the questions were read from the key file.
    setSynced(exam.updated_at)
    setDraft(toDraft(exam))
  }
  const dirty = exam !== undefined && draft !== null && !sameDraft(draft, toDraft(exam))

  useEffect(() => {
    onDirtyChange(dirty)
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  if (!exam || !draft) {
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
      const saved = await api.updateExam(exam.id, {
        name: draft.name.trim() || 'Untitled evaluator',
        questions: draft.questions,
      })
      setSynced(saved.updated_at)
      setDraft(toDraft(saved))
      onSaved(saved)
    } catch (error) {
      onError(`Could not save: ${errorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }
  const change = (changes: Partial<ExamDraft>) => setDraft((current) => current && { ...current, ...changes })

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }

  const steps: { id: EvaluatorTab; label: string; detail: string }[] = [
    {
      id: 'key',
      label: '1. Questions & key',
      detail:
        summary.question_count > 0
          ? pluralize(summary.question_count, 'question')
          : summary.key_document_id
            ? 'key file added'
            : 'start here',
    },
    {
      id: 'papers',
      label: '2. Answer papers',
      detail: paperCount > 0 ? `${markedCount} of ${paperCount} marked` : 'none yet',
    },
    { id: 'results', label: '3. Results', detail: markedCount > 0 ? pluralize(markedCount, 'student') : 'none yet' },
  ]

  return (
    <section className="exam-editor" onKeyDown={onKeyDown} aria-label={`Evaluator ${exam.name}`}>
      <div className="exam-header">
        <div className="exam-title">
          <input
            className="exam-name"
            value={draft.name}
            onChange={(event) => change({ name: event.target.value })}
            placeholder="Name of the evaluator, e.g. Maths unit test 1"
            aria-label="Name of the evaluator"
            maxLength={200}
          />
          <label
            className="grading-model"
            title="Reads the key file's questions, splits the answer papers and marks them"
          >
            <span>Marking model</span>
            <ModelSelect value={gradingModel} onChange={onGradingModelChange} models={models} added={addedModels} />
          </label>
        </div>
        <div className="exam-actions">
          {dirty && (
            <button type="button" className="btn" onClick={() => setDraft(toDraft(exam))} disabled={saving}>
              <Undo2 size={14} aria-hidden />
              Discard changes
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? <LoaderCircle size={14} className="spin" aria-hidden /> : <Save size={14} aria-hidden />}
            {dirty ? 'Save changes' : 'Saved'}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() =>
              downloadText(
                `${draft.name.trim() || 'evaluator'}.json`,
                JSON.stringify(answerKeyFile(draft), null, 2),
                'application/json',
              )
            }
            title="Export the questions as JSON"
            aria-label="Export the questions as JSON"
          >
            <FileJson size={17} />
          </button>
          <button
            type="button"
            className="icon-btn icon-btn-danger"
            onClick={onDelete}
            title="Delete this evaluator"
            aria-label="Delete this evaluator"
          >
            <Trash2 size={17} />
          </button>
        </div>
      </div>

      <div className="tabs step-tabs" role="tablist" aria-label="Steps">
        {steps.map((step) => (
          <button
            key={step.id}
            type="button"
            role="tab"
            aria-selected={tab === step.id}
            className={tab === step.id ? 'is-active' : undefined}
            onClick={() => onTabChange(step.id)}
          >
            <span className="step-tab-label">{step.label}</span>
            <span className="step-tab-detail">{step.detail}</span>
          </button>
        ))}
        {dirty && (
          <span className="step-tabs-note">
            <TriangleAlert size={13} aria-hidden />
            Unsaved changes
          </span>
        )}
      </div>

      <div className="exam-body">{children(draft, change, dirty)}</div>
    </section>
  )
}
