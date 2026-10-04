import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { Catalog, ExamSummary, Placement } from '../api'
import { collegeTree, SITTING_KINDS, sittingsNewestFirst, termLabel } from '../college'
import { errorMessage } from '../utils'

interface PlacementDialogProps {
  open: boolean
  catalog: Catalog
  exam: ExamSummary
  /** The sitting to suggest for an evaluator that has none. */
  defaultSittingId: string | undefined
  onClose: () => void
  onSave: (placement: Placement) => Promise<void>
}

/** Choose the subject and exam sitting an evaluator is the paper of. */
export function PlacementDialog({ open, catalog, exam, defaultSittingId, onClose, onSave }: PlacementDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [subjectId, setSubjectId] = useState(exam.subject_id ?? '')
  const [sittingId, setSittingId] = useState(exam.sitting_id ?? defaultSittingId ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) {
      setSubjectId(exam.subject_id ?? '')
      setSittingId(exam.sitting_id ?? defaultSittingId ?? '')
      setError(null)
      element.showModal()
    }
    if (!open && element.open) element.close()
  }, [open, exam, defaultSittingId])

  const save = async (placement: Placement) => {
    setSaving(true)
    setError(null)
    try {
      await onSave(placement)
      onClose()
    } catch (problem) {
      setError(errorMessage(problem))
    } finally {
      setSaving(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      className="dialog dialog-narrow"
      onClose={onClose}
      onClick={(event) => event.target === event.currentTarget && onClose()}
      aria-labelledby="placement-title"
    >
      <form
        className="dialog-content"
        onSubmit={(event) => {
          event.preventDefault()
          void save({ subject_id: subjectId, sitting_id: sittingId })
        }}
      >
        <header className="dialog-header">
          <h2 id="placement-title">{exam.subject_id ? 'Move this paper' : 'File under a subject'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <p className="hint">
          Make <strong>{exam.name}</strong> a subject's paper in an exam sitting. Its questions, answer papers and marks
          come with it.
        </p>
        <div className="dialog-fields">
          <label className="field">
            <span className="field-label">Exam sitting</span>
            <select
              className="select"
              value={sittingId}
              onChange={(event) => setSittingId(event.target.value)}
              required
            >
              <option value="" disabled>
                Choose a sitting…
              </option>
              {sittingsNewestFirst(catalog).map((sitting) => (
                <option key={sitting.id} value={sitting.id}>
                  {sitting.name}
                  {sitting.academic_year ? ` · ${sitting.academic_year}` : ''} · {SITTING_KINDS[sitting.kind]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Subject</span>
            <select
              className="select"
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              required
            >
              <option value="" disabled>
                Choose a subject…
              </option>
              {collegeTree(catalog).flatMap(({ department, programmes }) =>
                programmes.flatMap(({ programme, terms }) =>
                  terms.map(({ term, subjects }) => (
                    <optgroup
                      key={`${programme.id}-${term}`}
                      label={`${department.name} · ${programme.name} · ${termLabel(programme, term)}`}
                    >
                      {subjects.map((subject) => (
                        <option key={subject.id} value={subject.id}>
                          {subject.code ? `${subject.code} ${subject.name}` : subject.name}
                        </option>
                      ))}
                    </optgroup>
                  )),
                ),
              )}
            </select>
          </label>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-footer">
          {exam.subject_id && (
            <button
              type="button"
              className="btn btn-ghost-danger"
              onClick={() => void save({ subject_id: null, sitting_id: null })}
              disabled={saving}
            >
              Take out of the subject
            </button>
          )}
          <span className="dialog-footer-spacer" />
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !subjectId || !sittingId}>
            Save
          </button>
        </footer>
      </form>
    </dialog>
  )
}
