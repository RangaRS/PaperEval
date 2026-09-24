import { describe, expect, it } from 'vitest'

import type { EvaluatedAnswer, Evaluation, Question } from './api'
import {
  answerKeyFile,
  classStats,
  formatMarks,
  joinList,
  nextNumber,
  parseAnswerKey,
  questionLabel,
  summarize,
  withAnswer,
  withSummary,
} from './exams'

const question = (number: string, max_marks = 2): Question => ({
  id: `id-${number}`,
  number,
  question: `Question ${number}`,
  answer: 'Answer',
  key: 'Key',
  max_marks,
})

const withoutIds = (questions: Question[]) =>
  questions.map((item) => {
    const copy: Partial<Question> = { ...item }
    delete copy.id
    return copy
  })

const answer = (question_id: string, marks: number | null, max_marks = 5): EvaluatedAnswer => ({
  question_id,
  number: question_id,
  max_marks,
  answer: 'Text',
  pages: [1],
  status: marks === null ? 'pending' : 'graded',
  ai_marks: marks,
  feedback: '',
  error: null,
  model: 'm',
  graded_at: null,
  teacher_marks: null,
  marks,
})

const evaluation = (id: string, answers: EvaluatedAnswer[], overrides: Partial<Evaluation> = {}): Evaluation => ({
  id,
  document_id: 'doc',
  document_name: 'asha.pdf',
  exam_id: 'exam',
  exam_name: 'Unit test',
  model: 'm',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:00:00Z',
  student_name: 'Asha',
  roll_number: '42',
  answers,
  marks: 0,
  max_marks: 0,
  complete: false,
  ...overrides,
})

describe('formatMarks', () => {
  it('writes marks without needless decimals', () => {
    expect([2, 2.5, 0.25, 6.300000000000001, 0].map(formatMarks)).toEqual(['2', '2.5', '0.25', '6.3', '0'])
  })
})

describe('questionLabel', () => {
  it('prefixes numbers with Q and keeps other labels as they are', () => {
    expect(questionLabel('1', 0)).toBe('Q1')
    expect(questionLabel(' 11 (a) ', 3)).toBe('Q11 (a)')
    expect(questionLabel('Part B 12', 3)).toBe('Part B 12')
    expect(questionLabel('', 4)).toBe('Q5')
  })
})

describe('nextNumber', () => {
  it('continues the numbering of the last question', () => {
    expect(nextNumber([])).toBe('1')
    expect(nextNumber([question('1'), question('2')])).toBe('3')
    expect(nextNumber([question('Part B 12')])).toBe('Part B 13')
    expect(nextNumber([question('11 (a)')])).toBe('11 (b)')
    expect(nextNumber([question('Essay')])).toBe('')
  })
})

describe('parseAnswerKey', () => {
  it('reads the exported format', () => {
    const draft = { name: 'Unit test', questions: [question('1', 2), question('2', 3)] }

    const parsed = parseAnswerKey(JSON.stringify(answerKeyFile(draft)), 'file')

    expect(parsed.name).toBe('Unit test')
    expect(withoutIds(parsed.questions)).toEqual(withoutIds(draft.questions))
    // Imported questions get ids of their own.
    expect(new Set(parsed.questions.map((item) => item.id)).size).toBe(2)
  })

  it('reads a bare list of questions with other field names', () => {
    const text = JSON.stringify([
      { question: 'What is $\\frac{1}{2}$?', model_answer: '0.5', marking_scheme: 'All or nothing', marks: '2' },
      { no: 7, text: 'Define a group.', solution: 'A set with...', rubric: '1 mark per axiom' },
    ])

    const parsed = parseAnswerKey(text, 'unit-test.json')

    expect(parsed.name).toBe('unit-test.json')
    expect(withoutIds(parsed.questions)).toEqual([
      { number: '1', question: 'What is $\\frac{1}{2}$?', answer: '0.5', key: 'All or nothing', max_marks: 2 },
      { number: '7', question: 'Define a group.', answer: 'A set with...', key: '1 mark per axiom', max_marks: 0 },
    ])
  })

  it('explains what is wrong with a file it cannot read', () => {
    expect(() => parseAnswerKey('{not json', 'x')).toThrow('not valid JSON')
    expect(() => parseAnswerKey('{"name": "x"}', 'x')).toThrow('no list of questions')
    expect(() => parseAnswerKey('[1]', 'x')).toThrow('Question 1 in the file is not an object')
    expect(() => parseAnswerKey('[{"max_marks": -2}]', 'x')).toThrow('Question 1 in the file has invalid marks')
    expect(() => parseAnswerKey('[{"max_marks": "lots"}]', 'x')).toThrow('invalid marks')
  })
})

describe('evaluations', () => {
  it('updates the totals when an answer is marked', () => {
    const before = evaluation('e1', [answer('a', 2), answer('b', null, 3)], { marks: 2, max_marks: 8 })

    const after = withAnswer(before, { ...answer('b', 2.5, 3), feedback: 'Good' })

    expect(after.answers[1].feedback).toBe('Good')
    expect([after.marks, after.max_marks, after.complete]).toEqual([4.5, 8, true])
    expect(before.answers[1].marks).toBeNull()
  })

  it('keeps one summary per script and answer key, newest first', () => {
    const old = summarize(evaluation('e1', [answer('a', 1)]))
    const otherKey = summarize(evaluation('e2', [], { exam_id: 'other', created_at: '2026-09-02T10:00:00Z' }))
    const latest = summarize(evaluation('e3', [answer('a', 2)], { created_at: '2026-09-03T10:00:00Z' }))

    const list = withSummary(withSummary([old], otherKey), latest)

    expect(list.map((item) => item.id)).toEqual(['e3', 'e2'])
    expect(list[0].answers).toEqual([{ question_id: 'a', number: 'a', status: 'graded', marks: 2, max_marks: 5 }])
  })

  it('sums up a class', () => {
    const marks = [4, 9, 5].map((value, index) => summarize(evaluation(`e${index}`, [], { marks: value })))

    expect(classStats(marks)).toEqual({ count: 3, average: 6, highest: 9, lowest: 4 })
    expect(classStats([])).toBeNull()
  })
})

describe('joinList', () => {
  it('joins items like a sentence', () => {
    expect(joinList([])).toBe('')
    expect(joinList(['2'])).toBe('2')
    expect(joinList(['2', '5'])).toBe('2 and 5')
    expect(joinList(['1', '2', '5'])).toBe('1, 2 and 5')
  })
})
