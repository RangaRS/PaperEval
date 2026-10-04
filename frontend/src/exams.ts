import type { EvaluatedAnswer, Evaluation, EvaluationSummary, ExamDraft, PaperGroup, PaperNode, Question } from './api'
import { flatPaper, newGroup, normalize, questionRef, ROOT_ID, tally } from './paper'

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

const ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii']

/** The label after another: "4" after "3", "11 (b)" after "11 (a)", "11 (a) (ii)" after "11 (a) (i)", or "". */
export function numberAfter(label: string): string {
  const last = label.trim()
  const digits = /^(.*?)(\d+)$/.exec(last)
  if (digits) return `${digits[1]}${Number(digits[2]) + 1}`
  // Roman numerals come after a letter: "11 (a) (i)".
  const roman = /^(.*\([a-z]\)\s*\()([ivx]+)\)$/i.exec(last)
  const romanIndex = roman ? ROMAN.indexOf(roman[2].toLowerCase()) : -1
  if (roman && romanIndex >= 0 && romanIndex < ROMAN.length - 1) return `${roman[1]}${ROMAN[romanIndex + 1]})`
  const letter = /^(.*\()([a-y])\)$/i.exec(last)
  if (letter) return `${letter[1]}${String.fromCharCode(letter[2].charCodeAt(0) + 1)})`
  return ''
}

/** The label after the last question's: "4" after "3", "11 (b)" after "11 (a)", or "" when there is no pattern. */
export function nextNumber(questions: Question[]): string {
  const last = questions.at(-1)?.number
  return last === undefined ? '1' : numberAfter(last)
}

/** The number after the highest question number: "12" when the last question is "11 (c)". */
export function nextTopNumber(questions: Question[]): string {
  const numbers = questions.flatMap((question) => {
    const match = /^\s*(\d+)/.exec(question.number)
    return match ? [Number(match[1])] : []
  })
  return numbers.length > 0 ? String(Math.max(...numbers) + 1) : nextNumber(questions)
}

/** The label of a part of a question: "11 (a)" for the first part of "11", "11 (a) (i)" for the first of "11 (a)". */
export function partNumber(base: string, index: number): string {
  const trimmed = base.trim()
  if (!trimmed) return ''
  const part = /\([a-z]\)$/i.test(trimmed) ? (ROMAN[index] ?? String(index + 1)) : String.fromCharCode(97 + index)
  return `${trimmed} (${part})`
}

export function blankQuestion(questions: Question[]): Question {
  return { id: newQuestionId(), number: nextNumber(questions), question: '', answer: '', key: '', max_marks: 0 }
}

export const totalMarks = (questions: { max_marks: number }[]) =>
  questions.reduce((total, question) => total + question.max_marks, 0)

/**
 * An answer key as saved to a file: the questions without their internal ids, laid out as on the paper, with
 * sections and choices as items that have `parts`.
 */
export function answerKeyFile(draft: ExamDraft) {
  const questions = new Map(draft.questions.map((question) => [question.id, question]))
  const item = (node: PaperNode): Record<string, unknown>[] => {
    if (node.kind === 'question') {
      const question = questions.get(node.question_id)
      if (!question) return []
      const { number, question: text, answer, key, max_marks } = question
      return [{ number, question: text, answer, key, max_marks }]
    }
    const { label, text, rule, count, min_each, cap } = node
    return [{ number: label, question: text, rule, count, min_each, cap, parts: node.children.flatMap(item) }]
  }
  const { rule, count, min_each, cap } = draft.structure
  const root = rule === 'all' && cap === 0 ? {} : { rule, count, min_each, cap }
  return { name: draft.name, ...root, questions: draft.structure.children.flatMap(item) }
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

function wholeNumber(value: unknown, fallback: number): number {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

/** A group's rule as saved by `answerKeyFile`: `rule` is "all" or "any", with `count`, `min_each` and `cap`. */
function groupRule(item: Record<string, unknown>): Pick<PaperGroup, 'rule' | 'count' | 'min_each' | 'cap'> {
  const any = asText(item.rule).toLowerCase() === 'any'
  return {
    rule: any ? 'any' : 'all',
    count: Math.max(1, wholeNumber(item.count, 1)),
    min_each: any ? wholeNumber(item.min_each, 0) : 0,
    cap: Math.max(0, Number(item.cap) || 0),
  }
}

/**
 * Read an answer key saved as JSON: `{"name": ..., "questions": [...]}`, or just
 * the list of questions. Each question has `number`, `question`, `answer`, `key`
 * and `max_marks`; a few other common names for these are understood too. An
 * item with `parts` is a section or a question with sub-parts, whose `rule` says
 * which parts count.
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
  const questions: Question[] = []
  const read = (items: unknown[]): PaperNode[] =>
    items.map((item: unknown): PaperNode => {
      const place = questions.length + 1
      if (!isObject(item)) throw new Error(`Question ${place} in the file is not an object.`)
      if (Array.isArray(item.parts)) {
        return newGroup({
          label: asText(field(item, 'number', 'label')),
          text: asText(field(item, 'question', 'text')),
          ...groupRule(item),
          children: read(item.parts),
        })
      }
      const rawMarks = field(item, 'max_marks', 'marks', 'max_mark', 'maximum_marks')
      const marks = rawMarks === undefined || rawMarks === '' ? 0 : Number(rawMarks)
      if (!Number.isFinite(marks) || marks < 0) throw new Error(`Question ${place} in the file has invalid marks.`)
      const question: Question = {
        id: newQuestionId(),
        number: asText(field(item, 'number', 'no', 'label')) || String(place),
        question: asText(field(item, 'question', 'text')),
        answer: asText(field(item, 'answer', 'model_answer', 'solution')),
        key: asText(field(item, 'key', 'marking_key', 'marking_scheme', 'scheme', 'rubric')),
        max_marks: marks,
      }
      questions.push(question)
      return questionRef(question.id)
    })
  const children = read(list)
  const rule = isObject(data) && data.rule !== undefined ? groupRule(data) : {}
  const structure = normalize(newGroup({ id: ROOT_ID, ...rule, children }), questions.map((question) => question.id))
  const name = isObject(data) ? asText(data.name) : ''
  return { name: name || fallbackName, questions, structure }
}

/** A student's total and the most they could get, counting only the best of the choices they made. */
export function totals(answers: EvaluatedAnswer[], structure: PaperGroup | null | undefined) {
  const byId = new Map(answers.map((answer) => [answer.question_id, answer]))
  const paper = structure ?? flatPaper(answers.map((answer) => ({ id: answer.question_id })))
  const scored = tally(
    paper,
    (id) => byId.get(id)?.marks ?? 0,
    (id) => byId.get(id)?.status !== 'unanswered' && Boolean(byId.get(id)?.answer),
  )
  const counted = new Set(scored.counted)
  return {
    marks: scored.marks,
    max_marks: tally(paper, (id) => byId.get(id)?.max_marks ?? 0).marks,
    complete: answers.every((answer) => answer.marks !== null),
    not_counted: answers.filter((answer) => !counted.has(answer.question_id)).map((answer) => answer.question_id),
  }
}

/** The evaluation with one of its answers replaced. */
export function withAnswer(evaluation: Evaluation, answer: EvaluatedAnswer): Evaluation {
  const answers = evaluation.answers.map((current) => (current.question_id === answer.question_id ? answer : current))
  return { ...evaluation, answers, ...totals(answers, evaluation.structure) }
}

export function summarize(evaluation: Evaluation): EvaluationSummary {
  // oxlint-disable-next-line no-unused-vars
  const { answers, structure, ...rest } = evaluation
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
