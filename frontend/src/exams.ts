import type { EvaluatedAnswer, Evaluation, EvaluationSummary, ExamDraft, Question } from './api'

/** Marks as people write them: 2, 2.5, 0.25. */
export function formatMarks(marks: number): string {
  return String(Math.round(marks * 100) / 100)
}

/** How to refer to a question: "Q1", "Q11 (a)", or "Part B 12" as printed. */
export function questionLabel(number: string, index: number): string {
  const trimmed = number.trim()
  if (!trimmed) return `Q${index + 1}`
  return /^\d/.test(trimmed) ? `Q${trimmed}` : trimmed
}

export function newQuestionId(): string {
  // crypto.randomUUID needs a secure context, which a page opened over the network is not.
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The label after the last question's: "4" after "3", "11 (b)" after "11 (a)", or "" when there is no pattern. */
export function nextNumber(questions: Question[]): string {
  const last = questions.at(-1)?.number.trim()
  if (last === undefined) return '1'
  const digits = /^(.*?)(\d+)$/.exec(last)
  if (digits) return `${digits[1]}${Number(digits[2]) + 1}`
  const letter = /^(.*\()([a-y])\)$/i.exec(last)
  if (letter) return `${letter[1]}${String.fromCharCode(letter[2].charCodeAt(0) + 1)})`
  return ''
}

export function blankQuestion(questions: Question[]): Question {
  return { id: newQuestionId(), number: nextNumber(questions), question: '', answer: '', key: '', max_marks: 0 }
}

export const totalMarks = (questions: { max_marks: number }[]) =>
  questions.reduce((total, question) => total + question.max_marks, 0)

/** An answer key as saved to a file: the questions without their internal ids. */
export function answerKeyFile(draft: ExamDraft) {
  return {
    name: draft.name,
    questions: draft.questions.map(({ number, question, answer, key, max_marks }) => ({
      number,
      question,
      answer,
      key,
      max_marks,
    })),
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The first of the fields that the item has. */
function field(item: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) if (item[name] !== undefined && item[name] !== null) return item[name]
  return undefined
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return String(value)
  return ''
}

/**
 * Read an answer key saved as JSON: `{"name": ..., "questions": [...]}`, or just
 * the list of questions. Each question has `number`, `question`, `answer`, `key`
 * and `max_marks`; a few other common names for these are understood too.
 */
export function parseAnswerKey(text: string, fallbackName: string): ExamDraft {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('The file is not valid JSON.')
  }
  const list = Array.isArray(data) ? data : isObject(data) ? data.questions : undefined
  if (!Array.isArray(list)) throw new Error('The file has no list of questions.')
  const questions = list.map((item: unknown, index): Question => {
    if (!isObject(item)) throw new Error(`Question ${index + 1} in the file is not an object.`)
    const rawMarks = field(item, 'max_marks', 'marks', 'max_mark', 'maximum_marks')
    const marks = rawMarks === undefined || rawMarks === '' ? 0 : Number(rawMarks)
    if (!Number.isFinite(marks) || marks < 0) throw new Error(`Question ${index + 1} in the file has invalid marks.`)
    return {
      id: newQuestionId(),
      number: asText(field(item, 'number', 'no', 'label')) || String(index + 1),
      question: asText(field(item, 'question', 'text')),
      answer: asText(field(item, 'answer', 'model_answer', 'solution')),
      key: asText(field(item, 'key', 'marking_key', 'marking_scheme', 'scheme', 'rubric')),
      max_marks: marks,
    }
  })
  const name = isObject(data) ? asText(data.name) : ''
  return { name: name || fallbackName, questions }
}

function totals(answers: { marks: number | null; max_marks: number }[]) {
  return {
    marks: answers.reduce((total, answer) => total + (answer.marks ?? 0), 0),
    max_marks: totalMarks(answers),
    complete: answers.every((answer) => answer.marks !== null),
  }
}

/** The evaluation with one of its answers replaced. */
export function withAnswer(evaluation: Evaluation, answer: EvaluatedAnswer): Evaluation {
  const answers = evaluation.answers.map((current) => (current.question_id === answer.question_id ? answer : current))
  return { ...evaluation, answers, ...totals(answers) }
}

export function summarize(evaluation: Evaluation): EvaluationSummary {
  const { answers, ...rest } = evaluation
  return {
    ...rest,
    answers: answers.map(({ question_id, number, status, marks, max_marks }) => ({
      question_id,
      number,
      status,
      marks,
      max_marks,
    })),
  }
}

/** The list with the summary added, replacing earlier evaluations of the same script with the same key. */
export function withSummary(list: EvaluationSummary[], summary: EvaluationSummary): EvaluationSummary[] {
  const others = list.filter(
    (item) => item.id !== summary.id && !(item.document_id === summary.document_id && item.exam_id === summary.exam_id),
  )
  return [summary, ...others].sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export interface ClassStats {
  count: number
  average: number
  highest: number
  lowest: number
}

export function classStats(evaluations: EvaluationSummary[]): ClassStats | null {
  if (evaluations.length === 0) return null
  const marks = evaluations.map((evaluation) => evaluation.marks)
  return {
    count: marks.length,
    average: marks.reduce((total, value) => total + value, 0) / marks.length,
    highest: Math.max(...marks),
    lowest: Math.min(...marks),
  }
}

/** "2", "2 and 5", "1, 2 and 5". */
export function joinList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}
