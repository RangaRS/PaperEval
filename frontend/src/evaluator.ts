import type { DocumentInfo, EvaluationSummary, Exam, ExamSummary } from './api'
import { isRunning, type EvaluationRun } from './evaluationRunner'
import { questionLabel } from './exams'
import { pageKey, type OcrJob } from './ocrQueue'

/** The steps of an evaluator: its questions and key, the students' answer papers, and the results. */
export type EvaluatorTab = 'key' | 'papers' | 'results'

export type StepState = 'waiting' | 'running' | 'done' | 'failed'

/** Reading an evaluator's questions from its key file: every page's text first, then the model. */
export interface KeyRead {
  documentId: string
  /** The pages whose text this read extracts. */
  extracting: number[]
  extract: StepState
  extractError?: string
  read: StepState
  readStartedAt?: number
  /** Characters of text sent to the model. */
  sent?: number
  /** Characters of the model's answer received so far. */
  received: number
  /** 2 when the model is asked a second time, without a fixed format. */
  attempt: number
  readError?: string
  /** The model's answer, when it could not be used. */
  reply?: string
}

export const isKeyReading = (read: KeyRead | undefined) =>
  read !== undefined && (read.extract === 'running' || read.read === 'running')

export const summaryOf = (exam: Exam): ExamSummary => ({
  id: exam.id,
  name: exam.name,
  created_at: exam.created_at,
  updated_at: exam.updated_at,
  question_count: exam.questions.length,
  total_marks: exam.total_marks,
  unmarked_questions: exam.questions.flatMap((question, index) =>
    question.max_marks <= 0 ? [questionLabel(question.number, index)] : [],
  ),
  key_document_id: exam.key_document_id,
})

/** Why answer papers can't be marked against this evaluator yet, or null when they can. */
export function keyProblem(summary: ExamSummary | undefined): string | null {
  if (!summary || summary.question_count === 0) {
    return 'Add the questions first: upload the question paper with its answer key in step 1.'
  }
  if (summary.unmarked_questions.length > 0) {
    const list = summary.unmarked_questions
    const which = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`
    return `Set the marks for ${which} in step 1 first.`
  }
  return null
}

export type PaperStateKind = 'idle' | 'waiting' | 'running' | 'done' | 'partial' | 'failed'

export interface PaperState {
  kind: PaperStateKind
  label: string
}

/** How an answer paper is getting on: waiting, being read, split or marked, marked, or failed. */
export function paperState(
  document: DocumentInfo,
  run: EvaluationRun | undefined,
  evaluation: EvaluationSummary | undefined,
  jobs: ReadonlyMap<string, OcrJob>,
): PaperState {
  if (run?.status === 'queued') return { kind: 'waiting', label: 'Waiting for its turn' }
  if (isRunning(run)) {
    if (run!.step === 'extract') {
      const reading = document.pages.find((page) => jobs.get(pageKey(document.id, page.number))?.status === 'running')
      const done = document.pages.filter((page) => page.ocr).length
      return {
        kind: 'running',
        label: reading
          ? `Reading page ${reading.number} of ${document.pages.length}`
          : `Reading the pages (${done} of ${document.pages.length} done)`,
      }
    }
    if (run!.step === 'split') {
      const written = run!.received ? ` (${run!.received.toLocaleString()} characters)` : ''
      return { kind: 'running', label: `Finding the answers${written}` }
    }
    if (run!.step === 'mark') {
      return { kind: 'running', label: `Marking ${run!.toMark - run!.marking.length} of ${run!.toMark} answers` }
    }
    return { kind: 'running', label: 'Starting' }
  }
  if (run?.status === 'error' && run.request.kind === 'evaluate' && !run.evaluation) {
    return { kind: 'failed', label: run.error ?? 'Failed' }
  }
  if (evaluation) {
    if (evaluation.complete) return { kind: 'done', label: 'Marked' }
    const unmarked = evaluation.answers.filter((answer) => answer.marks === null).length
    return { kind: 'partial', label: `${unmarked} ${unmarked === 1 ? 'answer' : 'answers'} not marked yet` }
  }
  if (run?.status === 'stopped') return { kind: 'idle', label: 'Stopped' }
  return { kind: 'idle', label: 'Not evaluated yet' }
}
