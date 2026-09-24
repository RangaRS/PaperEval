import { describe, expect, it } from 'vitest'

import type { DocumentInfo, EvaluationSummary, ExamSummary } from './api'
import type { EvaluationRun } from './evaluationRunner'
import { keyProblem, paperState } from './evaluator'
import type { OcrJob } from './ocrQueue'

const paper = (withText: number, pages = 3): DocumentInfo => ({
  id: 'asha',
  filename: 'asha.pdf',
  kind: 'pdf',
  created_at: '2026-09-01T10:00:00Z',
  exam_id: 'exam',
  role: 'script',
  pages: Array.from({ length: pages }, (_, index) => ({
    number: index + 1,
    width: 100,
    height: 140,
    image_url: '',
    thumbnail_url: '',
    ocr:
      index < withText
        ? {
            text: 'Text',
            model: 'm',
            prompt: '',
            created_at: '',
            duration_ms: 1,
            truncated: false,
            prompt_tokens: null,
            output_tokens: null,
          }
        : null,
  })),
})

const run = (changes: Partial<EvaluationRun>): EvaluationRun => ({
  request: { kind: 'evaluate', documentId: 'asha', examId: 'exam', model: 'm' },
  status: 'running',
  marking: [],
  toMark: 0,
  ...changes,
})

const evaluation = (marks: (number | null)[]): EvaluationSummary => ({
  id: 'e',
  document_id: 'asha',
  document_name: 'asha.pdf',
  exam_id: 'exam',
  exam_name: 'Unit test',
  model: 'm',
  created_at: '',
  updated_at: '',
  student_name: '',
  roll_number: '',
  marks: 0,
  max_marks: 0,
  complete: marks.every((value) => value !== null),
  answers: marks.map((value, index) => ({
    question_id: `q${index}`,
    number: String(index + 1),
    status: value === null ? 'pending' : 'graded',
    marks: value,
    max_marks: 2,
  })),
})

const noJobs = new Map<string, OcrJob>()

describe('paperState', () => {
  it('follows a paper through its evaluation', () => {
    const reading = new Map<string, OcrJob>([
      [
        'asha/2',
        {
          key: 'asha/2',
          documentId: 'asha',
          pageNumber: 2,
          model: 'm',
          prompt: '',
          status: 'running',
          text: '',
          thinking: false,
        },
      ],
    ])

    expect(paperState(paper(0), undefined, undefined, noJobs)).toEqual({ kind: 'idle', label: 'Not evaluated yet' })
    expect(paperState(paper(0), run({ status: 'queued' }), undefined, noJobs).kind).toBe('waiting')
    expect(paperState(paper(1), run({ step: 'extract' }), undefined, reading).label).toBe('Reading page 2 of 3')
    expect(paperState(paper(3), run({ step: 'split', received: 1500 }), undefined, noJobs).label).toBe(
      'Finding the answers (1,500 characters)',
    )
    expect(paperState(paper(3), run({ step: 'mark', toMark: 4, marking: ['a'] }), undefined, noJobs).label).toBe(
      'Marking 3 of 4 answers',
    )
    expect(paperState(paper(3), run({ status: 'done' }), evaluation([2, 1]), noJobs)).toEqual({
      kind: 'done',
      label: 'Marked',
    })
  })

  it('tells failed and partly marked papers apart', () => {
    expect(paperState(paper(3), run({ status: 'error', error: 'HTTP 402' }), undefined, noJobs)).toEqual({
      kind: 'failed',
      label: 'HTTP 402',
    })
    expect(paperState(paper(3), run({ status: 'stopped' }), evaluation([2, null, null]), noJobs)).toEqual({
      kind: 'partial',
      label: '2 answers not marked yet',
    })
  })
})

describe('keyProblem', () => {
  const summary = (changes: Partial<ExamSummary>): ExamSummary => ({
    id: 'exam',
    name: 'Unit test',
    created_at: '',
    updated_at: '',
    question_count: 3,
    total_marks: 10,
    unmarked_questions: [],
    key_document_id: null,
    ...changes,
  })

  it('says what is missing before papers can be marked', () => {
    expect(keyProblem(summary({ question_count: 0 }))).toMatch(/Add the questions first/)
    expect(keyProblem(summary({ unmarked_questions: ['Q2', 'Q5'] }))).toBe(
      'Set the marks for Q2 and Q5 in step 1 first.',
    )
    expect(keyProblem(summary({}))).toBeNull()
  })
})
