import { CalendarDays, ChevronRight, ClipboardPlus, LoaderCircle } from 'lucide-react'
import { useState } from 'react'

import type { Catalog, ExamSummary, Sitting, Subject } from '../api'
import { pathTo, sittingLabel, sittingsNewestFirst, termLabel, type Scope } from '../college'
import { formatMarks } from '../exams'
import { pluralize } from '../utils'
import { Breadcrumb } from './Breadcrumb'

interface SubjectPageProps {
  catalog: Catalog
  subject: Subject
  sitting: Sitting | undefined
  exams: ExamSummary[]
  onSelectScope: (scope: Scope) => void
  /** Create the subject's paper for the sitting. */
  onCreatePaper: () => Promise<void>
  /** Make an existing evaluator the subject's paper for the sitting. */
  onUseEvaluator: (examId: string) => Promise<void>
  onOpenPaper: (exam: ExamSummary) => void
  onOpenStructure: () => void
}

/** A subject that has no paper in the exam sitting yet, with its papers in other sittings. */
export function SubjectPage({
  catalog,
  subject,
  sitting,
  exams,
  onSelectScope,
  onCreatePaper,
  onUseEvaluator,
  onOpenPaper,
  onOpenStructure,
}: SubjectPageProps) {
  const [busy, setBusy] = useState(false)
  const [existing, setExisting] = useState('')
  const programme = catalog.programmes.find((candidate) => candidate.id === subject.programme_id)
  const loose = exams.filter((exam) => !exam.subject_id)
  const earlier = sittingsNewestFirst(catalog).flatMap((item) => {
    const exam = exams.find((candidate) => candidate.subject_id === subject.id && candidate.sitting_id === item.id)
    return exam && item.id !== sitting?.id ? [{ sitting: item, exam }] : []
  })
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    try {
      await work()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="overview" aria-label={subject.name}>
      <header className="overview-header">
        <Breadcrumb
          items={pathTo(catalog, { kind: 'subject', subjectId: subject.id }).map((step) => ({
            label: step.label,
            onClick: () => step.scope && onSelectScope(step.scope),
          }))}
        />
        <h1 className="overview-title">
          {subject.code && <span className="subject-code subject-code-large">{subject.code}</span>}
          {subject.name}
        </h1>
        {programme && (
          <p className="overview-sitting muted">
            {programme.name} · {termLabel(programme, subject.term)}
          </p>
        )}
      </header>

      <div className="overview-body">
        <div className="step-card setup-paper">
          <ClipboardPlus size={30} strokeWidth={1.5} className="setup-paper-icon" aria-hidden />
          {sitting ? (
            <>
              <h2>No paper for {sitting.name} yet</h2>
              <p className="muted">
                Set up this subject's paper for {sittingLabel(sitting)}: upload the question paper with its answer key,
                then the students' answer papers. Each is marked against the key, and you check every mark.
              </p>
              <div className="setup-paper-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-large"
                  onClick={() => void run(onCreatePaper)}
                  disabled={busy}
                >
                  {busy ? (
                    <LoaderCircle size={16} className="spin" aria-hidden />
                  ) : (
                    <ClipboardPlus size={16} aria-hidden />
                  )}
                  Set up the paper
                </button>
              </div>
              {loose.length > 0 && (
                <form
                  className="setup-paper-existing"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (existing) void run(() => onUseEvaluator(existing))
                  }}
                >
                  <span className="muted">or use an evaluator you already made</span>
                  <select
                    className="select select-small"
                    value={existing}
                    onChange={(event) => setExisting(event.target.value)}
                    aria-label="Evaluator to use as this subject's paper"
                  >
                    <option value="">Choose an evaluator…</option>
                    {loose.map((exam) => (
                      <option key={exam.id} value={exam.id}>
                        {exam.name}
                        {exam.question_count > 0 ? ` (${pluralize(exam.question_count, 'question')})` : ''}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="btn btn-small" disabled={!existing || busy}>
                    Use it
                  </button>
                </form>
              )}
            </>
          ) : (
            <>
              <h2>Add an exam sitting first</h2>
              <p className="muted">
                A subject has one paper in each exam sitting, such as "Nov/Dec 2026" or "Internal test 1".
              </p>
              <button type="button" className="btn btn-primary" onClick={onOpenStructure}>
                <CalendarDays size={15} aria-hidden />
                Add an exam sitting
              </button>
            </>
          )}
        </div>

        {earlier.length > 0 && (
          <div className="step-card">
            <div className="step-card-header">
              <h2>Papers in other sittings</h2>
            </div>
            <ul className="sitting-papers">
              {earlier.map(({ sitting: item, exam }) => (
                <li key={item.id}>
                  <button type="button" className="sitting-paper" onClick={() => onOpenPaper(exam)}>
                    <CalendarDays size={15} aria-hidden />
                    <span className="sitting-paper-name">{sittingLabel(item)}</span>
                    <span className="muted">
                      {exam.question_count > 0
                        ? `${pluralize(exam.question_count, 'question')} · ${formatMarks(exam.total_marks)} marks`
                        : 'No questions yet'}
                    </span>
                    <ChevronRight size={16} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  )
}
