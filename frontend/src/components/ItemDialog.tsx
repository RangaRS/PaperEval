import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import type { Catalog, CatalogCollection, Department, Programme, Sitting, SittingKind, Subject, TermType } from '../api'
import { SITTING_KINDS, termLabel } from '../college'
import { errorMessage } from '../utils'

/** What is being added or changed in the college's structure. */
export type Editing =
  | { collection: 'departments'; item?: Department }
  | { collection: 'programmes'; item?: Programme; departmentId: string }
  | { collection: 'subjects'; item?: Subject; programmeId: string; term?: number }
  | { collection: 'sittings'; item?: Sitting }

const NOUNS: Record<CatalogCollection, string> = {
  departments: 'department',
  programmes: 'programme',
  subjects: 'subject',
  sittings: 'exam sitting',
}

interface Form {
  name: string
  code: string
  departmentId: string
  termType: TermType
  termCount: number
  programmeId: string
  term: number
  kind: SittingKind
  academicYear: string
}

function initialForm(editing: Editing, catalog: Catalog): Form {
  const form: Form = {
    name: '',
    code: '',
    departmentId: '',
    termType: 'semester',
    termCount: 6,
    programmeId: '',
    term: 1,
    kind: 'end_term',
    academicYear: '',
  }
  switch (editing.collection) {
    case 'departments':
      return { ...form, name: editing.item?.name ?? '', code: editing.item?.code ?? '' }
    case 'programmes':
      return {
        ...form,
        name: editing.item?.name ?? '',
        code: editing.item?.code ?? '',
        departmentId: editing.item?.department_id ?? editing.departmentId,
        termType: editing.item?.term_type ?? 'semester',
        termCount: editing.item?.term_count ?? 6,
      }
    case 'subjects':
      return {
        ...form,
        name: editing.item?.name ?? '',
        code: editing.item?.code ?? '',
        programmeId: editing.item?.programme_id ?? editing.programmeId,
        term: editing.item?.term ?? editing.term ?? 1,
      }
    case 'sittings': {
      // Suggest the academic year of the newest sitting.
      const latest = catalog.sittings.at(-1)?.academic_year ?? ''
      return {
        ...form,
        name: editing.item?.name ?? '',
        kind: editing.item?.kind ?? 'end_term',
        academicYear: editing.item?.academic_year ?? latest,
      }
    }
  }
}

function bodyOf(editing: Editing, form: Form) {
  switch (editing.collection) {
    case 'departments':
      return { name: form.name, code: form.code }
    case 'programmes':
      return {
        name: form.name,
        code: form.code,
        department_id: form.departmentId,
        term_type: form.termType,
        term_count: form.termCount,
      }
    case 'subjects':
      return { name: form.name, code: form.code, programme_id: form.programmeId, term: form.term }
    case 'sittings':
      return { name: form.name, kind: form.kind, academic_year: form.academicYear }
  }
}

interface ItemDialogProps {
  editing: Editing | null
  catalog: Catalog
  onClose: () => void
  onSave: (collection: CatalogCollection, id: string | undefined, body: object) => Promise<void>
}

/** Add or change a department, programme, subject or exam sitting. */
export function ItemDialog({ editing, catalog, onClose, onSave }: ItemDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const firstField = useRef<HTMLInputElement>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState<string[]>([])
  // The form starts from the item when the dialog opens, not on every change to the structure.
  const [openedFor, setOpenedFor] = useState<Editing | null>(null)
  if (editing !== openedFor) {
    setOpenedFor(editing)
    if (editing) {
      setForm(initialForm(editing, catalog))
      setError(null)
      setAdded([])
    }
  }

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (editing && !element.open) {
      element.showModal()
      firstField.current?.focus()
    }
    if (!editing && element.open) element.close()
  }, [editing])

  const change = (changes: Partial<Form>) => setForm((current) => current && { ...current, ...changes })
  const noun = editing ? NOUNS[editing.collection] : ''
  const isNew = editing?.item === undefined
  const programme = catalog.programmes.find((candidate) => candidate.id === form?.programmeId)

  const save = async (another: boolean) => {
    if (!editing || !form) return
    setSaving(true)
    setError(null)
    try {
      await onSave(editing.collection, editing.item?.id, bodyOf(editing, form))
      if (another) {
        setAdded((current) => [...current, form.code ? `${form.code} ${form.name}` : form.name])
        // Keep the programme and term, to add the next subject quickly.
        change({ name: '', code: '' })
        firstField.current?.focus()
      } else {
        onClose()
      }
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
      aria-labelledby="item-title"
    >
      {editing && form && (
        <form
          className="dialog-content"
          onSubmit={(event) => {
            event.preventDefault()
            void save(false)
          }}
        >
          <header className="dialog-header">
            <h2 id="item-title">{isNew ? `Add a ${noun}` : `Change the ${noun}`}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <X size={18} />
            </button>
          </header>

          <div className="dialog-fields">
            {editing.collection === 'programmes' && (
              <label className="field">
                <span className="field-label">Department</span>
                <select
                  className="select"
                  value={form.departmentId}
                  onChange={(event) => change({ departmentId: event.target.value })}
                >
                  {catalog.departments.map((department) => (
                    <option key={department.id} value={department.id}>
                      {department.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {editing.collection === 'subjects' && (
              <div className="field-row">
                <label className="field">
                  <span className="field-label">Programme</span>
                  <select
                    className="select"
                    value={form.programmeId}
                    onChange={(event) => change({ programmeId: event.target.value, term: 1 })}
                  >
                    {catalog.programmes.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field field-narrow">
                  <span className="field-label">{programme?.term_type === 'year' ? 'Year' : 'Semester'}</span>
                  <select
                    className="select"
                    value={form.term}
                    onChange={(event) => change({ term: Number(event.target.value) })}
                  >
                    {Array.from({ length: programme?.term_count ?? 1 }, (_, index) => index + 1).map((term) => (
                      <option key={term} value={term}>
                        {programme ? termLabel(programme, term) : term}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {editing.collection === 'sittings' ? (
              <>
                <label className="field">
                  <span className="field-label">Name</span>
                  <input
                    ref={firstField}
                    className="text-input"
                    value={form.name}
                    onChange={(event) => change({ name: event.target.value })}
                    placeholder="e.g. Nov/Dec 2026, or Internal test 1"
                    maxLength={200}
                    required
                  />
                </label>
                <div className="field-row">
                  <label className="field">
                    <span className="field-label">Kind of exam</span>
                    <select
                      className="select"
                      value={form.kind}
                      onChange={(event) => change({ kind: event.target.value as SittingKind })}
                    >
                      {Object.entries(SITTING_KINDS).map(([kind, label]) => (
                        <option key={kind} value={kind}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field field-narrow">
                    <span className="field-label">Academic year</span>
                    <input
                      className="text-input"
                      value={form.academicYear}
                      onChange={(event) => change({ academicYear: event.target.value })}
                      placeholder="2026-27"
                      maxLength={20}
                    />
                  </label>
                </div>
              </>
            ) : (
              <div className="field-row">
                <label className="field field-narrow">
                  <span className="field-label">Code</span>
                  <input
                    ref={editing.collection === 'subjects' ? firstField : undefined}
                    className="text-input"
                    value={form.code}
                    onChange={(event) => change({ code: event.target.value })}
                    placeholder={
                      editing.collection === 'subjects' ? 'MA301' : editing.collection === 'programmes' ? 'BSc' : 'MA'
                    }
                    maxLength={40}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Name</span>
                  <input
                    ref={editing.collection === 'subjects' ? undefined : firstField}
                    className="text-input"
                    value={form.name}
                    onChange={(event) => change({ name: event.target.value })}
                    placeholder={
                      editing.collection === 'subjects'
                        ? 'e.g. Differential Equations'
                        : editing.collection === 'programmes'
                          ? 'e.g. B.Sc Mathematics'
                          : 'e.g. Mathematics'
                    }
                    maxLength={200}
                    required
                  />
                </label>
              </div>
            )}

            {editing.collection === 'programmes' && (
              <div className="field-row">
                <div className="field">
                  <span className="field-label">Taught in</span>
                  <div className="segmented segmented-field" role="group" aria-label="Taught in">
                    {(['semester', 'year'] as const).map((type) => (
                      <button
                        key={type}
                        type="button"
                        className={form.termType === type ? 'is-active' : undefined}
                        aria-pressed={form.termType === type}
                        onClick={() => change({ termType: type })}
                      >
                        {type === 'semester' ? 'Semesters' : 'Years'}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="field field-narrow">
                  <span className="field-label">How many</span>
                  <input
                    className="text-input"
                    type="number"
                    min={1}
                    max={12}
                    value={form.termCount}
                    onChange={(event) => change({ termCount: Number(event.target.value) })}
                    required
                  />
                </label>
              </div>
            )}
          </div>

          {added.length > 0 && (
            <p className="hint dialog-added" role="status">
              Added {added.join(', ')}.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <footer className="dialog-footer">
            <span className="dialog-footer-spacer" />
            <button type="button" className="btn" onClick={onClose}>
              {added.length > 0 ? 'Done' : 'Cancel'}
            </button>
            {isNew && editing.collection === 'subjects' && (
              <button
                type="button"
                className="btn"
                onClick={() => void save(true)}
                disabled={saving || !form.name.trim()}
              >
                Add and add another
              </button>
            )}
            <button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim()}>
              {isNew ? 'Add' : 'Save'}
            </button>
          </footer>
        </form>
      )}
    </dialog>
  )
}
