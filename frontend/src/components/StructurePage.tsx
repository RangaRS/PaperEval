import { Building2, CalendarDays, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { api, type Catalog, type CatalogCollection, type ExamSummary } from '../api'
import { collegeTree, SITTING_KINDS, sittingsNewestFirst, termLabel } from '../college'
import { errorMessage, pluralize } from '../utils'
import { ItemDialog, type Editing } from './ItemDialog'

interface StructurePageProps {
  catalog: Catalog
  exams: ExamSummary[]
  onChange: (catalog: Catalog) => void
  onLoadSample: () => void
  onError: (message: string) => void
}

/** Set up the college: its name, exam sittings, departments, programmes and the subjects of each term. */
export function StructurePage({ catalog, exams, onChange, onLoadSample, onError }: StructurePageProps) {
  const [editing, setEditing] = useState<Editing | null>(null)
  const [name, setName] = useState<string | null>(null)
  const institution = name ?? catalog.institution.name
  const empty = catalog.departments.length === 0 && catalog.sittings.length === 0
  const papers = (field: 'subject_id' | 'sitting_id', id: string) => exams.filter((exam) => exam[field] === id).length

  const saveName = async () => {
    if (name === null || name.trim() === catalog.institution.name) return setName(null)
    try {
      onChange(await api.setInstitution(name))
      setName(null)
    } catch (error) {
      onError(`Could not save the name: ${errorMessage(error)}`)
    }
  }

  const save = async (collection: CatalogCollection, id: string | undefined, body: object) => {
    // The dialog shows the error, so it is not caught here.
    const next = id
      ? await api.updateCatalogItem(collection, id, body as never)
      : await api.addCatalogItem(collection, body as never)
    onChange(next)
  }

  const remove = async (collection: CatalogCollection, id: string, label: string) => {
    if (!window.confirm(`Delete ${label}?`)) return
    try {
      onChange(await api.deleteCatalogItem(collection, id))
    } catch (error) {
      onError(`Could not delete ${label}: ${errorMessage(error)}`)
    }
  }

  return (
    <section className="overview structure" aria-label="College structure">
      <header className="overview-header">
        <h1 className="overview-title">College structure</h1>
        <p className="overview-sitting muted">
          Departments, their programmes, the subjects taught in each semester, and the exam sittings each subject has a
          paper in.
        </p>
      </header>

      <div className="overview-body">
        {empty && (
          <div className="step-card sample-callout">
            <Sparkles size={22} className="sample-callout-icon" aria-hidden />
            <div>
              <h2>Start from a sample college</h2>
              <p className="muted">
                Three departments with their programmes, odd-semester subjects and exam sittings, ready to try. Rename,
                change or delete anything afterwards.
              </p>
            </div>
            <button type="button" className="btn btn-primary" onClick={onLoadSample}>
              Add the sample college
            </button>
          </div>
        )}

        <div className="step-card">
          <div className="step-card-header">
            <Building2 size={17} aria-hidden />
            <h2>Institution</h2>
          </div>
          <form
            className="institution-form"
            onSubmit={(event) => {
              event.preventDefault()
              void saveName()
            }}
          >
            <input
              className="text-input"
              value={institution}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name of your college or university"
              aria-label="Name of your college or university"
              maxLength={200}
            />
            <button type="submit" className="btn" disabled={name === null || name.trim() === catalog.institution.name}>
              Save
            </button>
          </form>
        </div>

        <div className="step-card">
          <div className="step-card-header">
            <CalendarDays size={17} aria-hidden />
            <h2>Exam sittings</h2>
            <span className="muted">Each subject has one paper per sitting</span>
            <div className="toolbar-group">
              <button type="button" className="btn btn-small" onClick={() => setEditing({ collection: 'sittings' })}>
                <Plus size={14} aria-hidden />
                Add sitting
              </button>
            </div>
          </div>
          {catalog.sittings.length === 0 ? (
            <p className="hint step-empty">
              No exam sittings yet. Add one, such as "Nov/Dec 2026" or "Internal test 1".
            </p>
          ) : (
            <ul className="structure-list">
              {sittingsNewestFirst(catalog).map((sitting) => {
                const count = papers('sitting_id', sitting.id)
                return (
                  <li key={sitting.id} className="structure-row">
                    <span className="structure-name">{sitting.name}</span>
                    <span className="muted">{sitting.academic_year}</span>
                    <span className="chip">{SITTING_KINDS[sitting.kind]}</span>
                    <span className="structure-meta">{count > 0 ? pluralize(count, 'paper') : ''}</span>
                    <RowActions
                      label={sitting.name}
                      onEdit={() => setEditing({ collection: 'sittings', item: sitting })}
                      onDelete={() => void remove('sittings', sitting.id, sitting.name)}
                      deleteBlocked={count > 0 ? 'This sitting has papers' : undefined}
                    />
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="structure-departments-head">
          <h2>Departments</h2>
          <button type="button" className="btn btn-small" onClick={() => setEditing({ collection: 'departments' })}>
            <Plus size={14} aria-hidden />
            Add department
          </button>
        </div>
        {catalog.departments.length === 0 && (
          <p className="hint">No departments yet. Add your first department, then its programmes and subjects.</p>
        )}
        {collegeTree(catalog).map(({ department, programmes }) => (
          <div key={department.id} className="step-card structure-department">
            <div className="step-card-header">
              <h2>{department.name}</h2>
              {department.code && <span className="chip">{department.code}</span>}
              <div className="toolbar-group">
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => setEditing({ collection: 'programmes', departmentId: department.id })}
                >
                  <Plus size={14} aria-hidden />
                  Add programme
                </button>
                <RowActions
                  label={department.name}
                  onEdit={() => setEditing({ collection: 'departments', item: department })}
                  onDelete={() => void remove('departments', department.id, department.name)}
                  deleteBlocked={programmes.length > 0 ? 'Delete its programmes first' : undefined}
                />
              </div>
            </div>
            {programmes.length === 0 && <p className="hint step-empty">No programmes yet.</p>}
            {programmes.map(({ programme, terms }) => (
              <div key={programme.id} className="structure-programme">
                <div className="structure-programme-head">
                  <span className="structure-name">{programme.name}</span>
                  <span className="muted">
                    {programme.code && `${programme.code} · `}
                    {pluralize(programme.term_count, programme.term_type)}
                  </span>
                  <div className="toolbar-group">
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={() => setEditing({ collection: 'subjects', programmeId: programme.id })}
                    >
                      <Plus size={14} aria-hidden />
                      Add subjects
                    </button>
                    <RowActions
                      label={programme.name}
                      onEdit={() =>
                        setEditing({ collection: 'programmes', item: programme, departmentId: department.id })
                      }
                      onDelete={() => void remove('programmes', programme.id, programme.name)}
                      deleteBlocked={terms.length > 0 ? 'Delete its subjects first' : undefined}
                    />
                  </div>
                </div>
                {terms.length === 0 && <p className="hint structure-none">No subjects yet.</p>}
                {terms.map(({ term, subjects }) => (
                  <div key={term} className="structure-term">
                    <button
                      type="button"
                      className="structure-term-label"
                      onClick={() => setEditing({ collection: 'subjects', programmeId: programme.id, term })}
                      title={`Add a subject to ${termLabel(programme, term)}`}
                    >
                      {termLabel(programme, term)}
                      <Plus size={12} aria-hidden />
                    </button>
                    <ul className="structure-list">
                      {subjects.map((subject) => {
                        const count = papers('subject_id', subject.id)
                        return (
                          <li key={subject.id} className="structure-row structure-subject">
                            <span className="subject-code">{subject.code}</span>
                            <span className="structure-name">{subject.name}</span>
                            <span className="structure-meta">{count > 0 ? pluralize(count, 'paper') : ''}</span>
                            <RowActions
                              label={subject.name}
                              onEdit={() =>
                                setEditing({ collection: 'subjects', item: subject, programmeId: programme.id })
                              }
                              onDelete={() => void remove('subjects', subject.id, subject.name)}
                              deleteBlocked={count > 0 ? 'This subject has papers' : undefined}
                            />
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>

      <ItemDialog editing={editing} catalog={catalog} onClose={() => setEditing(null)} onSave={save} />
    </section>
  )
}

function RowActions({
  label,
  onEdit,
  onDelete,
  deleteBlocked,
}: {
  label: string
  onEdit: () => void
  onDelete: () => void
  /** Why it can't be deleted, if it can't. */
  deleteBlocked?: string
}) {
  return (
    <span className="row-actions">
      <button
        type="button"
        className="icon-btn icon-btn-small"
        onClick={onEdit}
        title="Change"
        aria-label={`Change ${label}`}
      >
        <Pencil size={14} />
      </button>
      <button
        type="button"
        className="icon-btn icon-btn-small icon-btn-danger"
        onClick={onDelete}
        disabled={deleteBlocked !== undefined}
        title={deleteBlocked ?? 'Delete'}
        aria-label={`Delete ${label}`}
      >
        <Trash2 size={14} />
      </button>
    </span>
  )
}
