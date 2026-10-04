import { describe, expect, it } from 'vitest'

import type { Catalog, DocumentInfo, EvaluationSummary, ExamSummary } from './api'
import {
  collegeTree,
  currentSitting,
  paperOf,
  paperProgress,
  pathTo,
  scopeTitle,
  scopeTotals,
  stageLabel,
  subjectsIn,
} from './college'

const catalog: Catalog = {
  institution: { name: 'Greenfield College' },
  departments: [
    { id: 'cs', name: 'Computer Science', code: 'CS' },
    { id: 'ma', name: 'Mathematics', code: 'MA' },
  ],
  programmes: [
    { id: 'bsc-cs', department_id: 'cs', name: 'B.Sc CS', code: '', term_type: 'semester', term_count: 6 },
    { id: 'bsc-ma', department_id: 'ma', name: 'B.Sc Maths', code: '', term_type: 'year', term_count: 3 },
  ],
  subjects: [
    { id: 'ds', programme_id: 'bsc-cs', term: 3, code: 'CS302', name: 'Data Structures' },
    { id: 'c', programme_id: 'bsc-cs', term: 1, code: 'CS101', name: 'Programming in C' },
    { id: 'java', programme_id: 'bsc-cs', term: 3, code: 'CS301', name: 'Java' },
    { id: 'de', programme_id: 'bsc-ma', term: 2, code: 'MA201', name: 'Differential Equations' },
  ],
  sittings: [
    { id: 'apr', name: 'Apr/May 2026', kind: 'end_term', academic_year: '2025-26' },
    { id: 'nov', name: 'Nov/Dec 2026', kind: 'end_term', academic_year: '2026-27' },
  ],
}

const exam = (changes: Partial<ExamSummary>): ExamSummary => ({
  id: 'exam',
  name: 'Paper',
  created_at: '',
  updated_at: '',
  question_count: 3,
  total_marks: 10,
  unmarked_questions: [],
  key_document_id: null,
  subject_id: 'ds',
  sitting_id: 'nov',
  ...changes,
})

const script = (id: string, examId = 'exam') => ({ id, exam_id: examId, role: 'script' }) as DocumentInfo
const evaluation = (documentId: string, marks: number, complete = true) =>
  ({
    id: `e-${documentId}`,
    document_id: documentId,
    exam_id: 'exam',
    marks,
    max_marks: 10,
    complete,
  }) as EvaluationSummary

describe('collegeTree', () => {
  it('lists each programme’s terms in order, with their subjects sorted by code', () => {
    const tree = collegeTree(catalog)

    expect(tree.map((node) => node.department.name)).toEqual(['Computer Science', 'Mathematics'])
    const terms = tree[0].programmes[0].terms
    expect(terms.map((term) => term.term)).toEqual([1, 3])
    expect(terms[1].subjects.map((subject) => subject.code)).toEqual(['CS301', 'CS302'])
  })
})

describe('subjectsIn', () => {
  it('finds the subjects of the whole college, a department, a programme or a term', () => {
    expect(subjectsIn(catalog, { kind: 'institution' })).toHaveLength(4)
    expect(subjectsIn(catalog, { kind: 'department', departmentId: 'ma' }).map((s) => s.id)).toEqual(['de'])
    expect(subjectsIn(catalog, { kind: 'programme', programmeId: 'bsc-cs' })).toHaveLength(3)
    expect(subjectsIn(catalog, { kind: 'term', programmeId: 'bsc-cs', term: 3 }).map((s) => s.id)).toEqual([
      'java',
      'ds',
    ])
  })
})

describe('names and paths', () => {
  it('names a part of the college, with semesters or years', () => {
    expect(scopeTitle(catalog, { kind: 'institution' })).toBe('Greenfield College')
    expect(scopeTitle(catalog, { kind: 'term', programmeId: 'bsc-ma', term: 2 })).toBe('B.Sc Maths · Year 2')
  })

  it('gives the path from the college down to a subject', () => {
    expect(pathTo(catalog, { kind: 'subject', subjectId: 'ds' }).map((step) => step.label)).toEqual([
      'Greenfield College',
      'Computer Science',
      'B.Sc CS',
      'Semester 3',
      'CS302 Data Structures',
    ])
    expect(pathTo(catalog, { kind: 'department', departmentId: 'ma' })).toHaveLength(2)
  })

  it('uses the chosen sitting, or else the newest', () => {
    expect(currentSitting(catalog, 'apr')?.id).toBe('apr')
    expect(currentSitting(catalog, 'gone')?.id).toBe('nov')
  })
})

describe('paperProgress', () => {
  it('follows a paper from setting up to marked', () => {
    expect(paperProgress(undefined, [], []).stage).toBe('none')
    expect(paperProgress(exam({ question_count: 0 }), [], []).stage).toBe('key')
    expect(paperProgress(exam({ unmarked_questions: ['Q2'] }), [], []).stage).toBe('key')
    expect(paperProgress(exam({}), [], []).stage).toBe('ready')

    const papers = [script('a'), script('b'), script('other', 'elsewhere')]
    const marking = paperProgress(exam({}), papers, [evaluation('a', 8), evaluation('b', 4, false)])
    expect(marking).toEqual({ stage: 'marking', papers: 2, marked: 1, average: 80 })
    expect(stageLabel(marking)).toBe('Marking · 1 of 2')

    const marked = paperProgress(exam({}), papers, [evaluation('a', 8), evaluation('b', 6)])
    expect(marked.stage).toBe('marked')
    expect(marked.average).toBe(70)
  })

  it('adds up a part of the college', () => {
    const totals = scopeTotals([
      { stage: 'none', papers: 0, marked: 0, average: null },
      { stage: 'marking', papers: 30, marked: 12, average: 61 },
      { stage: 'ready', papers: 0, marked: 0, average: null },
    ])
    expect(totals).toEqual({ subjects: 3, papers: 2, scripts: 30, marked: 12 })
  })

  it('finds a subject’s paper in a sitting', () => {
    const exams = [exam({}), exam({ id: 'old', sitting_id: 'apr' })]
    expect(paperOf(exams, 'ds', 'apr')?.id).toBe('old')
    expect(paperOf(exams, 'ds', undefined)).toBeUndefined()
    expect(paperOf(exams, 'java', 'nov')).toBeUndefined()
  })
})
