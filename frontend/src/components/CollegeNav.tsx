import {
  Building2,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  LoaderCircle,
  Network,
  Plus,
  Sparkles,
} from 'lucide-react'
import type { ReactNode } from 'react'

import type { Catalog, DocumentInfo, EvaluationSummary, ExamSummary, Sitting } from '../api'
import {
  collegeTree,
  hasStructure,
  paperOf,
  paperProgress,
  sameScope,
  SITTING_KINDS,
  sittingsNewestFirst,
  termLabel,
  type PaperProgress,
  type Scope,
} from '../college'
import { isRunning, type EvaluationRun } from '../evaluationRunner'
import { isKeyReading, type KeyRead } from '../evaluator'
import { formatMarks } from '../exams'
import { pluralize } from '../utils'

/** What is open in the main area, to highlight it in the sidebar. */
export type NavSelection =
  | { kind: 'scope'; scope: Scope }
  | { kind: 'subject'; subjectId: string }
  | { kind: 'exam'; examId: string }
  | { kind: 'structure' }
  | { kind: 'none' }

interface CollegeNavProps {
  catalog: Catalog
  sitting: Sitting | undefined
  exams: ExamSummary[]
  documents: DocumentInfo[]
  evaluations: EvaluationSummary[]
  runs: ReadonlyMap<string, EvaluationRun>
  keyReads: Record<string, KeyRead>
  loading: boolean
  selection: NavSelection
  /** Departments and programmes whose subjects are shown. */
  expanded: string[]
  onToggle: (id: string) => void
  onSittingChange: (sittingId: string) => void
  onSelectScope: (scope: Scope) => void
  onSelectSubject: (subjectId: string) => void
  onSelectExam: (examId: string) => void
  onCreateEvaluator: () => void
  onOpenStructure: () => void
  onLoadSample: () => void
}

/** The sidebar: the college's departments, programmes, semesters and subjects for an exam sitting, and other evaluators. */
export function CollegeNav({
  catalog,
  sitting,
  exams,
  documents,
  evaluations,
  runs,
  keyReads,
  loading,
  selection,
  expanded,
  onToggle,
  onSittingChange,
  onSelectScope,
  onSelectSubject,
  onSelectExam,
  onCreateEvaluator,
  onOpenStructure,
  onLoadSample,
}: CollegeNavProps) {
  const structured = hasStructure(catalog)
  const tree = collegeTree(catalog)
  const working = (exam: ExamSummary | undefined) =>
    exam !== undefined &&
    (isKeyReading(keyReads[exam.id]) ||
      documents.some((document) => document.exam_id === exam.id && isRunning(runs.get(document.id))))
  const isScope = (scope: Scope) => selection.kind === 'scope' && sameScope(selection.scope, scope)
  const selectedExam = selection.kind === 'exam' ? exams.find((exam) => exam.id === selection.examId) : undefined
  const selectedSubject = selection.kind === 'subject' ? selection.subjectId : (selectedExam?.subject_id ?? null)
  // The path to what is open is always shown.
  const open = new Set(expanded)
  const openSubject = catalog.subjects.find((subject) => subject.id === selectedSubject)
  const openProgramme = catalog.programmes.find(
    (programme) =>
      programme.id === openSubject?.programme_id ||
      (selection.kind === 'scope' && 'programmeId' in selection.scope && selection.scope.programmeId === programme.id),
  )
  if (openProgramme) open.add(openProgramme.id).add(openProgramme.department_id)
  if (selection.kind === 'scope' && selection.scope.kind === 'department') open.add(selection.scope.departmentId)

  const loose = exams.filter((exam) => !exam.subject_id)

  return (
    <aside className="sidebar college-nav" aria-label="College">
      {structured ? (
        <div className="nav-head">
          <div className="nav-institution-row">
            <button
              type="button"
              className={`nav-institution${isScope({ kind: 'institution' }) ? ' is-selected' : ''}`}
              onClick={() => onSelectScope({ kind: 'institution' })}
              title="Overview of every department"
            >
              <Building2 size={16} aria-hidden />
              <span className="truncate">{catalog.institution.name || 'Your college'}</span>
            </button>
            <button
              type="button"
              className={`icon-btn${selection.kind === 'structure' ? ' is-active' : ''}`}
              onClick={onOpenStructure}
              title="Departments, programmes, subjects and exam sittings"
              aria-label="College structure"
            >
              <Network size={17} />
            </button>
          </div>
          {catalog.sittings.length > 0 ? (
            <label
              className="nav-sitting"
              title={
                sitting
                  ? `${sitting.name}: ${SITTING_KINDS[sitting.kind]}. Each subject's paper is shown for this exam sitting.`
                  : undefined
              }
            >
              <CalendarDays size={15} aria-hidden />
              <span className="sr-only">Exam sitting</span>
              <select value={sitting?.id ?? ''} onChange={(event) => onSittingChange(event.target.value)}>
                {sittingsNewestFirst(catalog).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.academic_year ? ` · ${item.academic_year}` : ''}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="nav-sitting-chevron" aria-hidden />
            </label>
          ) : (
            <button type="button" className="nav-sitting nav-sitting-empty" onClick={onOpenStructure}>
              <CalendarDays size={15} aria-hidden />
              Add an exam sitting
            </button>
          )}
        </div>
      ) : (
        <div className="nav-setup">
          <p className="nav-setup-title">Organise by department</p>
          <p className="hint">
            Set up your departments, programmes, semesters and subjects, and mark every subject's papers in each exam
            sitting.
          </p>
          <div className="nav-setup-actions">
            <button type="button" className="btn btn-small btn-primary" onClick={onLoadSample} disabled={loading}>
              <Sparkles size={14} aria-hidden />
              Try a sample college
            </button>
            <button type="button" className="btn btn-small" onClick={onOpenStructure}>
              Set up yours
            </button>
          </div>
        </div>
      )}

      <div className="document-list nav-tree">
        {structured && tree.length === 0 && (
          <p className="sidebar-empty">
            No departments yet.{' '}
            <button type="button" className="link-btn" onClick={onOpenStructure}>
              Add one
            </button>
          </p>
        )}
        <ul className="nav-list" role="tree" aria-label="Departments">
          {tree.map(({ department, programmes }) => {
            const departmentOpen = open.has(department.id)
            const subjects = programmes.flatMap((node) => node.terms.flatMap((term) => term.subjects))
            const withPaper = subjects.filter((subject) => paperOf(exams, subject.id, sitting?.id)).length
            return (
              <li key={department.id} role="treeitem" aria-expanded={departmentOpen}>
                <NavBranch
                  level={0}
                  open={departmentOpen}
                  selected={isScope({ kind: 'department', departmentId: department.id })}
                  label={department.name}
                  meta={subjects.length > 0 ? `${withPaper}/${subjects.length}` : undefined}
                  metaTitle={`${withPaper} of ${pluralize(subjects.length, 'subject')} have a paper in this sitting`}
                  onToggle={() => onToggle(department.id)}
                  onSelect={() => {
                    onSelectScope({ kind: 'department', departmentId: department.id })
                    if (!departmentOpen) onToggle(department.id)
                  }}
                />
                {departmentOpen && (
                  <ul role="group">
                    {programmes.length === 0 && <li className="nav-empty">No programmes yet</li>}
                    {programmes.map(({ programme, terms }) => {
                      const programmeOpen = open.has(programme.id)
                      return (
                        <li key={programme.id} role="treeitem" aria-expanded={programmeOpen}>
                          <NavBranch
                            level={1}
                            open={programmeOpen}
                            selected={isScope({ kind: 'programme', programmeId: programme.id })}
                            label={programme.name}
                            onToggle={() => onToggle(programme.id)}
                            onSelect={() => {
                              onSelectScope({ kind: 'programme', programmeId: programme.id })
                              if (!programmeOpen) onToggle(programme.id)
                            }}
                          />
                          {programmeOpen && (
                            <ul role="group">
                              {terms.length === 0 && <li className="nav-empty">No subjects yet</li>}
                              {terms.map(({ term, subjects: termSubjects }) => {
                                const termScope: Scope = { kind: 'term', programmeId: programme.id, term }
                                return (
                                  <li key={term} role="none">
                                    <button
                                      type="button"
                                      className={`nav-term${isScope(termScope) ? ' is-selected' : ''}`}
                                      onClick={() => onSelectScope(termScope)}
                                    >
                                      {termLabel(programme, term)}
                                    </button>
                                    <ul role="group">
                                      {termSubjects.map((subject) => {
                                        const exam = paperOf(exams, subject.id, sitting?.id)
                                        const progress = paperProgress(exam, documents, evaluations)
                                        return (
                                          <li key={subject.id} role="treeitem">
                                            <button
                                              type="button"
                                              className={`nav-subject${subject.id === selectedSubject ? ' is-selected' : ''}`}
                                              aria-current={subject.id === selectedSubject ? 'page' : undefined}
                                              onClick={() => onSelectSubject(subject.id)}
                                              title={subject.code ? `${subject.code} ${subject.name}` : subject.name}
                                            >
                                              <StageDot progress={progress} working={working(exam)} />
                                              {subject.code && <span className="nav-subject-code">{subject.code}</span>}
                                              <span className="nav-subject-name">{subject.name}</span>
                                              {progress.papers > 0 && (
                                                <span className="nav-meta">
                                                  {progress.marked}/{progress.papers}
                                                </span>
                                              )}
                                            </button>
                                          </li>
                                        )
                                      })}
                                    </ul>
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>

        <div className="nav-section">
          <span>{structured ? 'Other evaluators' : 'Evaluators'}</span>
          {structured && (
            <button
              type="button"
              className="icon-btn icon-btn-small"
              onClick={onCreateEvaluator}
              title="New evaluator outside the college's subjects, e.g. for a quick test"
              aria-label="New evaluator"
            >
              <Plus size={15} />
            </button>
          )}
        </div>
        {!structured && (
          <button type="button" className="btn btn-block nav-new" onClick={onCreateEvaluator}>
            <Plus size={15} aria-hidden />
            New evaluator
          </button>
        )}
        {loading && exams.length === 0 && <p className="sidebar-empty">Loading…</p>}
        {!loading && loose.length === 0 && (
          <p className="nav-empty nav-empty-loose">
            {structured ? 'Quick evaluators that aren’t a subject’s paper show up here.' : 'No evaluators yet.'}
          </p>
        )}
        <ul className="exam-list">
          {loose.map((exam) => (
            <LooseExamRow
              key={exam.id}
              exam={exam}
              selected={exam.id === selectedExam?.id}
              working={working(exam)}
              keyRead={keyReads[exam.id]}
              documents={documents}
              evaluations={evaluations}
              onSelect={() => onSelectExam(exam.id)}
            />
          ))}
        </ul>
      </div>
    </aside>
  )
}

function NavBranch({
  level,
  open,
  selected,
  label,
  meta,
  metaTitle,
  onToggle,
  onSelect,
}: {
  level: 0 | 1
  open: boolean
  selected: boolean
  label: string
  meta?: string
  metaTitle?: string
  onToggle: () => void
  onSelect: () => void
}) {
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div className={`nav-branch nav-level-${level}${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="nav-chevron"
        onClick={onToggle}
        aria-label={open ? `Hide ${label}` : `Show ${label}`}
        aria-expanded={open}
      >
        <Chevron size={14} />
      </button>
      <button
        type="button"
        className="nav-branch-label"
        onClick={onSelect}
        aria-current={selected ? 'page' : undefined}
      >
        <span className="truncate">{label}</span>
        {meta && (
          <span className="nav-meta" title={metaTitle}>
            {meta}
          </span>
        )}
      </button>
    </div>
  )
}

const STAGE_TITLES = {
  none: 'No paper in this sitting yet',
  key: 'The paper needs its questions and key',
  ready: 'Ready for answer papers',
  marking: 'Answer papers are being marked',
  marked: 'Every answer paper is marked',
} as const

export function StageDot({ progress, working }: { progress: PaperProgress; working: boolean }): ReactNode {
  if (working) return <LoaderCircle size={12} className="stage-dot-spinner spin" aria-label="Working" />
  return <span className={`stage-dot stage-${progress.stage}`} title={STAGE_TITLES[progress.stage]} />
}

function LooseExamRow({
  exam,
  selected,
  working,
  keyRead,
  documents,
  evaluations,
  onSelect,
}: {
  exam: ExamSummary
  selected: boolean
  working: boolean
  keyRead: KeyRead | undefined
  documents: DocumentInfo[]
  evaluations: EvaluationSummary[]
  onSelect: () => void
}) {
  const progress = paperProgress(exam, documents, evaluations)
  return (
    <li>
      <button
        type="button"
        className={`exam-row${selected ? ' is-selected' : ''}`}
        onClick={onSelect}
        aria-current={selected ? 'page' : undefined}
      >
        {working ? (
          <LoaderCircle size={16} className="exam-row-icon spin" aria-hidden />
        ) : (
          <ClipboardCheck size={16} className="exam-row-icon" aria-hidden />
        )}
        <span className="exam-row-text">
          <span className="exam-row-name">{exam.name}</span>
          <span className="exam-row-meta">
            {isKeyReading(keyRead)
              ? 'Reading the key…'
              : exam.question_count > 0
                ? `${pluralize(exam.question_count, 'question')} · ${formatMarks(exam.total_marks)} marks`
                : exam.key_document_id
                  ? 'Questions not read yet'
                  : 'No key file yet'}
          </span>
          {progress.papers > 0 && (
            <span className="exam-row-meta">
              {pluralize(progress.papers, 'paper')} · {progress.marked} marked
            </span>
          )}
        </span>
      </button>
    </li>
  )
}
