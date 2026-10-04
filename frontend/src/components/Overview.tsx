import { CalendarDays, ChevronRight, Network, Plus } from 'lucide-react'

import type { Catalog, DocumentInfo, EvaluationSummary, ExamSummary, Sitting } from '../api'
import {
  collegeTree,
  paperOf,
  paperProgress,
  pathTo,
  scopeTitle,
  scopeTotals,
  SITTING_KINDS,
  stageLabel,
  subjectsIn,
  termLabel,
  type Scope,
} from '../college'
import { pluralize } from '../utils'
import { Breadcrumb } from './Breadcrumb'
import { StageDot } from './CollegeNav'

interface OverviewProps {
  catalog: Catalog
  scope: Scope
  sitting: Sitting | undefined
  exams: ExamSummary[]
  documents: DocumentInfo[]
  evaluations: EvaluationSummary[]
  /** Exams with work going on, such as papers being marked. */
  working: ReadonlySet<string>
  onSelectScope: (scope: Scope) => void
  onSelectSubject: (subjectId: string) => void
  onOpenStructure: () => void
}

/** A part of the college in an exam sitting: how far every subject's paper has got. */
export function Overview({
  catalog,
  scope,
  sitting,
  exams,
  documents,
  evaluations,
  working,
  onSelectScope,
  onSelectSubject,
  onOpenStructure,
}: OverviewProps) {
  const subjects = subjectsIn(catalog, scope)
  const rows = subjects.map((subject) => {
    const exam = paperOf(exams, subject.id, sitting?.id)
    return { subject, exam, progress: paperProgress(exam, documents, evaluations) }
  })
  const totals = scopeTotals(rows.map((row) => row.progress))
  const markedShare = totals.scripts > 0 ? Math.round((totals.marked / totals.scripts) * 100) : 0
  const groups = collegeTree(catalog)
    .filter((node) => scope.kind !== 'department' || node.department.id === scope.departmentId)
    .flatMap((node) => node.programmes.map((programme) => ({ ...programme, department: node.department })))
    .filter((node) => !('programmeId' in scope) || node.programme.id === scope.programmeId)
    .flatMap((node) =>
      node.terms
        .filter((term) => scope.kind !== 'term' || term.term === scope.term)
        .map((term) => ({ ...term, department: node.department })),
    )
  const path = pathTo(catalog, scope)

  return (
    <section className="overview" aria-label={scopeTitle(catalog, scope)}>
      <header className="overview-header">
        {path.length > 1 && (
          <Breadcrumb
            items={path.map((step) => ({ label: step.label, onClick: () => step.scope && onSelectScope(step.scope) }))}
          />
        )}
        <h1 className="overview-title">{scopeTitle(catalog, scope)}</h1>
        {sitting ? (
          <p className="overview-sitting">
            <CalendarDays size={14} aria-hidden />
            {sitting.name}
            {sitting.academic_year && <span className="muted"> · {sitting.academic_year}</span>}
            <span className="chip">{SITTING_KINDS[sitting.kind]}</span>
          </p>
        ) : (
          <p className="overview-sitting muted">No exam sitting yet</p>
        )}
      </header>

      <div className="overview-body">
        {!sitting && (
          <div className="notice notice-warning">
            <CalendarDays size={18} className="notice-icon" aria-hidden />
            <div className="notice-body">
              <strong>Add an exam sitting</strong>, such as "Nov/Dec 2026" or "Internal test 1". Each subject gets one
              paper per sitting.
            </div>
            <button type="button" className="btn btn-small" onClick={onOpenStructure}>
              Add a sitting
            </button>
          </div>
        )}

        <div className="stat-grid">
          <Stat label="Subjects with a paper" value={`${totals.papers}`} detail={`of ${totals.subjects}`} />
          <Stat label="Answer papers" value={totals.scripts.toLocaleString()} detail="uploaded" />
          <Stat
            label="Marked"
            value={totals.marked.toLocaleString()}
            detail={totals.scripts > 0 ? `${markedShare}% done` : 'none yet'}
            progress={totals.scripts > 0 ? markedShare : undefined}
          />
        </div>

        {subjects.length === 0 ? (
          <div className="step-card overview-empty">
            <Network size={28} strokeWidth={1.5} aria-hidden />
            <h2>No subjects here yet</h2>
            <p className="muted">Add programmes and their subjects to see each subject's paper and marking here.</p>
            <button type="button" className="btn btn-primary" onClick={onOpenStructure}>
              <Plus size={15} aria-hidden />
              Add subjects
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="results-table overview-table">
              <thead>
                <tr>
                  <th scope="col">Subject</th>
                  <th scope="col">Paper</th>
                  <th scope="col" className="num">
                    Answer papers
                  </th>
                  <th scope="col">Marked</th>
                  <th scope="col" className="num">
                    Average
                  </th>
                  <th scope="col" aria-label="Open" />
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody key={`${group.programme.id}-${group.term}`}>
                  {scope.kind !== 'term' && (
                    <tr className="overview-group">
                      <th colSpan={6} scope="colgroup">
                        <button
                          type="button"
                          className="link-btn overview-group-link"
                          onClick={() =>
                            onSelectScope({ kind: 'term', programmeId: group.programme.id, term: group.term })
                          }
                        >
                          {scope.kind === 'institution' && <span className="muted">{group.department.name} · </span>}
                          {group.programme.name} · {termLabel(group.programme, group.term)}
                        </button>
                      </th>
                    </tr>
                  )}
                  {group.subjects.map((subject) => {
                    const row = rows.find((candidate) => candidate.subject.id === subject.id)!
                    const share = row.progress.papers > 0 ? (row.progress.marked / row.progress.papers) * 100 : 0
                    return (
                      <tr
                        key={subject.id}
                        tabIndex={0}
                        onClick={() => onSelectSubject(subject.id)}
                        onKeyDown={(event) => event.key === 'Enter' && onSelectSubject(subject.id)}
                      >
                        <td className="overview-subject">
                          {subject.code && <span className="subject-code">{subject.code}</span>}
                          <span>{subject.name}</span>
                        </td>
                        <td>
                          <span className={`stage-label stage-label-${row.progress.stage}`}>
                            <StageDot
                              progress={row.progress}
                              working={row.exam !== undefined && working.has(row.exam.id)}
                            />
                            {stageLabel(row.progress)}
                          </span>
                        </td>
                        <td className="num">{row.progress.stage === 'none' ? '' : row.progress.papers}</td>
                        <td>
                          {row.progress.papers > 0 && (
                            <span
                              className="meter"
                              title={`${row.progress.marked} of ${pluralize(row.progress.papers, 'paper')} marked`}
                            >
                              <span className="meter-fill" style={{ width: `${share}%` }} />
                            </span>
                          )}
                        </td>
                        <td className="num">
                          {row.progress.average === null ? '' : `${Math.round(row.progress.average)}%`}
                        </td>
                        <td className="overview-open">
                          {row.progress.stage === 'none' ? (
                            <span className="overview-action">Set up</span>
                          ) : (
                            <ChevronRight size={16} aria-hidden />
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

function Stat({ label, value, detail, progress }: { label: string; value: string; detail: string; progress?: number }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value} <span className="stat-detail">{detail}</span>
      </span>
      {progress !== undefined && (
        <span className="meter meter-wide" aria-hidden>
          <span className="meter-fill" style={{ width: `${progress}%` }} />
        </span>
      )}
    </div>
  )
}
