import type {
  Catalog,
  Department,
  DocumentInfo,
  EvaluationSummary,
  ExamSummary,
  Programme,
  Sitting,
  SittingKind,
  Subject,
} from './api'

/** A part of the college: all of it, a department, a programme, or one semester (or year) of a programme. */
export type Scope =
  | { kind: 'institution' }
  | { kind: 'department'; departmentId: string }
  | { kind: 'programme'; programmeId: string }
  | { kind: 'term'; programmeId: string; term: number }

export const SITTING_KINDS: Record<SittingKind, string> = {
  internal: 'Internal test',
  model: 'Model exam',
  end_term: 'End-term exam',
  supplementary: 'Supplementary exam',
  other: 'Other',
}

export const emptyCatalog = (): Catalog => ({
  institution: { name: '' },
  departments: [],
  programmes: [],
  subjects: [],
  sittings: [],
})

export const hasStructure = (catalog: Catalog) => catalog.departments.length > 0 || catalog.sittings.length > 0

/** "Semester 3" or "Year 2". */
export const termLabel = (programme: Pick<Programme, 'term_type'>, term: number) =>
  `${programme.term_type === 'year' ? 'Year' : 'Semester'} ${term}`

/** "Nov/Dec 2026 · 2026-27". */
export const sittingLabel = (sitting: Sitting) =>
  sitting.academic_year ? `${sitting.name} · ${sitting.academic_year}` : sitting.name

/** "MA301 Differential Equations". */
export const subjectLabel = (subject: Pick<Subject, 'code' | 'name'>) =>
  subject.code ? `${subject.code} ${subject.name}` : subject.name

/** The exam sittings, the most recently added first. */
export const sittingsNewestFirst = (catalog: Catalog) => [...catalog.sittings].reverse()

/** The chosen exam sitting, or else the most recently added one. */
export const currentSitting = (catalog: Catalog, chosenId: string): Sitting | undefined =>
  catalog.sittings.find((sitting) => sitting.id === chosenId) ?? catalog.sittings.at(-1)

const byCode = (a: Subject, b: Subject) =>
  a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: 'base' }) ||
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

export interface TermNode {
  programme: Programme
  term: number
  subjects: Subject[]
}

export interface ProgrammeNode {
  programme: Programme
  /** The terms that have subjects, in order. */
  terms: TermNode[]
}

export interface DepartmentNode {
  department: Department
  programmes: ProgrammeNode[]
}

/** Departments, their programmes, and each programme's terms with their subjects, sorted by code. */
export function collegeTree(catalog: Catalog): DepartmentNode[] {
  return catalog.departments.map((department) => ({
    department,
    programmes: catalog.programmes
      .filter((programme) => programme.department_id === department.id)
      .map((programme) => {
        const subjects = catalog.subjects.filter((subject) => subject.programme_id === programme.id)
        const terms = [...new Set(subjects.map((subject) => subject.term))].sort((a, b) => a - b)
        return {
          programme,
          terms: terms.map((term) => ({
            programme,
            term,
            subjects: subjects.filter((subject) => subject.term === term).sort(byCode),
          })),
        }
      }),
  }))
}

/** The subjects in a part of the college, in the order of the tree. */
export function subjectsIn(catalog: Catalog, scope: Scope): Subject[] {
  return collegeTree(catalog)
    .filter((node) => scope.kind !== 'department' || node.department.id === scope.departmentId)
    .flatMap((node) => node.programmes)
    .filter(
      (node) => scope.kind === 'institution' || scope.kind === 'department' || node.programme.id === scope.programmeId,
    )
    .flatMap((node) => node.terms)
    .filter((node) => scope.kind !== 'term' || node.term === scope.term)
    .flatMap((node) => node.subjects)
}

export interface SubjectPath {
  department: Department | undefined
  programme: Programme | undefined
  subject: Subject
}

/** Where a subject sits: its programme and department. */
export function pathOf(catalog: Catalog, subjectId: string | null): SubjectPath | undefined {
  const subject = catalog.subjects.find((candidate) => candidate.id === subjectId)
  if (!subject) return undefined
  const programme = catalog.programmes.find((candidate) => candidate.id === subject.programme_id)
  const department = catalog.departments.find((candidate) => candidate.id === programme?.department_id)
  return { department, programme, subject }
}

/** What a part of the college is called, for headings: "B.Sc Mathematics · Semester 3". */
export function scopeTitle(catalog: Catalog, scope: Scope): string {
  if (scope.kind === 'institution') return catalog.institution.name || 'All departments'
  if (scope.kind === 'department') {
    return catalog.departments.find((department) => department.id === scope.departmentId)?.name ?? 'Department'
  }
  const programme = catalog.programmes.find((candidate) => candidate.id === scope.programmeId)
  if (!programme) return 'Programme'
  return scope.kind === 'term' ? `${programme.name} · ${termLabel(programme, scope.term)}` : programme.name
}

export const sameScope = (a: Scope, b: Scope) => JSON.stringify(a) === JSON.stringify(b)

/** A subject's paper in an exam sitting, if it has one. */
export const paperOf = (exams: ExamSummary[], subjectId: string, sittingId: string | undefined) =>
  sittingId === undefined
    ? undefined
    : exams.find((exam) => exam.subject_id === subjectId && exam.sitting_id === sittingId)

/**
 * How far a subject's paper has got: no paper yet, waiting for its questions and key,
 * ready for answer papers, being marked, or every answer paper marked.
 */
export type PaperStage = 'none' | 'key' | 'ready' | 'marking' | 'marked'

export interface PaperProgress {
  stage: PaperStage
  /** Answer papers uploaded, and how many of them are fully marked. */
  papers: number
  marked: number
  /** The average of the fully marked papers, as a percentage of the paper's marks. */
  average: number | null
}

export function paperProgress(
  exam: ExamSummary | undefined,
  documents: DocumentInfo[],
  evaluations: EvaluationSummary[],
): PaperProgress {
  if (!exam) return { stage: 'none', papers: 0, marked: 0, average: null }
  const papers = documents.filter((document) => document.exam_id === exam.id && document.role === 'script').length
  const complete = evaluations.filter((evaluation) => evaluation.exam_id === exam.id && evaluation.complete)
  const scored = complete.filter((evaluation) => evaluation.max_marks > 0)
  const average =
    scored.length > 0
      ? scored.reduce((total, evaluation) => total + (evaluation.marks / evaluation.max_marks) * 100, 0) / scored.length
      : null
  const marked = Math.min(complete.length, papers)
  const stage: PaperStage =
    exam.question_count === 0 || exam.unmarked_questions.length > 0
      ? 'key'
      : papers === 0
        ? 'ready'
        : marked < papers
          ? 'marking'
          : 'marked'
  return { stage, papers, marked, average }
}

export function stageLabel(progress: PaperProgress): string {
  switch (progress.stage) {
    case 'none':
      return 'No paper yet'
    case 'key':
      return 'Needs its questions & key'
    case 'ready':
      return 'Ready for answer papers'
    case 'marking':
      return `Marking · ${progress.marked} of ${progress.papers}`
    case 'marked':
      return 'Marked'
  }
}

export interface ScopeTotals {
  subjects: number
  /** Subjects with a paper in the sitting. */
  papers: number
  /** Answer papers uploaded, and fully marked. */
  scripts: number
  marked: number
}

export function scopeTotals(progress: PaperProgress[]): ScopeTotals {
  return {
    subjects: progress.length,
    papers: progress.filter((item) => item.stage !== 'none').length,
    scripts: progress.reduce((total, item) => total + item.papers, 0),
    marked: progress.reduce((total, item) => total + item.marked, 0),
  }
}

export interface PathStep {
  label: string
  scope?: Scope
  subjectId?: string
}

/** The steps from the whole college down to a part of it, or to a subject: for breadcrumbs. */
export function pathTo(catalog: Catalog, target: Scope | { kind: 'subject'; subjectId: string }): PathStep[] {
  const steps: PathStep[] = [{ label: catalog.institution.name || 'All departments', scope: { kind: 'institution' } }]
  if (target.kind === 'institution') return steps
  let programme: Programme | undefined
  let term: number | undefined
  let subject: Subject | undefined
  let department: Department | undefined
  if (target.kind === 'department') {
    department = catalog.departments.find((candidate) => candidate.id === target.departmentId)
  } else {
    if (target.kind === 'subject') {
      subject = catalog.subjects.find((candidate) => candidate.id === target.subjectId)
      programme = catalog.programmes.find((candidate) => candidate.id === subject?.programme_id)
      term = subject?.term
    } else {
      programme = catalog.programmes.find((candidate) => candidate.id === target.programmeId)
      if (target.kind === 'term') term = target.term
    }
    department = catalog.departments.find((candidate) => candidate.id === programme?.department_id)
  }
  if (department) {
    steps.push({ label: department.name, scope: { kind: 'department', departmentId: department.id } })
  }
  if (programme) {
    steps.push({ label: programme.name, scope: { kind: 'programme', programmeId: programme.id } })
    if (term !== undefined) {
      steps.push({ label: termLabel(programme, term), scope: { kind: 'term', programmeId: programme.id, term } })
    }
  }
  if (subject) steps.push({ label: subjectLabel(subject), subjectId: subject.id })
  return steps
}
