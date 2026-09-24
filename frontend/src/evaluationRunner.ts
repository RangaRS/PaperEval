import type { Evaluation, EvaluationEvent } from './api'
import { withAnswer } from './exams'

export type RunStatus = 'queued' | 'running' | 'done' | 'error' | 'stopped'
/** Extracting the text of pages that have none, splitting the script into answers, marking the answers. */
export type RunStep = 'extract' | 'split' | 'mark'

/** Evaluate a script against an answer key. */
export interface EvaluateRequest {
  kind: 'evaluate'
  documentId: string
  examId: string
  model: string
}

/** Mark answers of an existing evaluation (again). */
export interface GradeRequest {
  kind: 'grade'
  documentId: string
  evaluation: Evaluation
  model: string
  /** The answers to mark; every answer without marks when left out. */
  questionIds?: string[]
}

export type RunRequest = EvaluateRequest | GradeRequest

export interface EvaluationRun {
  request: RunRequest
  status: RunStatus
  step?: RunStep
  /** When the current step started, for showing how long it takes. */
  stepStartedAt?: number
  /** The answers that are being marked but are not done yet. */
  marking: string[]
  /** How many answers this run marks in all. */
  toMark: number
  /** The evaluation, as it is filled in. */
  evaluation?: Evaluation
  error?: string
}

export interface EvaluationRunnerOptions {
  /** Extract the text of the document's pages that have none. Rejects if that fails. */
  prepare: (documentId: string, signal: AbortSignal) => Promise<void>
  evaluate: (request: EvaluateRequest, signal: AbortSignal) => AsyncIterable<EvaluationEvent>
  grade: (request: GradeRequest, signal: AbortSignal) => AsyncIterable<EvaluationEvent>
  /** Called each time an evaluation changes. */
  onEvaluation: (evaluation: Evaluation) => void
}

export const isRunning = (run: EvaluationRun | undefined) => run?.status === 'queued' || run?.status === 'running'

/**
 * Evaluates scripts one after another, keeping track of each one's progress.
 * Marking answers of an evaluated script again starts at once. There is at most
 * one run per document. Components subscribe with `useSyncExternalStore`.
 */
export class EvaluationRunner {
  private runs = new Map<string, EvaluationRun>()
  private waiting: string[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<() => void>()
  private snapshot: ReadonlyMap<string, EvaluationRun> = new Map()
  private readonly options: EvaluationRunnerOptions

  constructor(options: EvaluationRunnerOptions) {
    this.options = { ...options }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ReadonlyMap<string, EvaluationRun> => this.snapshot

  /** Change how the pages without text are extracted, e.g. after another model was chosen. */
  setPrepare(prepare: EvaluationRunnerOptions['prepare']): void {
    this.options.prepare = prepare
  }

  /** Start (or queue) a run. Returns false if the document already has one in progress. */
  start(request: RunRequest): boolean {
    const { documentId } = request
    if (isRunning(this.runs.get(documentId))) return false
    this.runs.set(documentId, { request, status: 'queued', marking: [], toMark: 0 })
    if (request.kind === 'grade') {
      void this.run(documentId)
    } else {
      this.waiting.push(documentId)
      this.emit()
      this.startNext()
    }
    return true
  }

  /** Stop a document's run: a queued one is dropped, a running one keeps what it has done so far. */
  stop(documentId: string): void {
    if (this.waiting.includes(documentId)) {
      this.waiting = this.waiting.filter((id) => id !== documentId)
      this.runs.delete(documentId)
      this.emit()
      return
    }
    this.controllers.get(documentId)?.abort()
  }

  /** Stop every run, queued or running. */
  stopAll(): void {
    for (const documentId of [...this.waiting]) this.stop(documentId)
    for (const controller of this.controllers.values()) controller.abort()
  }

  /** Forget a finished, failed or stopped run. */
  dismiss(documentId: string): void {
    if (isRunning(this.runs.get(documentId)) || !this.runs.delete(documentId)) return
    this.emit()
  }

  /** Stop and forget a document's run, for example because the document was deleted. */
  remove(documentId: string): void {
    this.waiting = this.waiting.filter((id) => id !== documentId)
    this.controllers.get(documentId)?.abort()
    if (this.runs.delete(documentId)) this.emit()
  }

  private startNext(): void {
    // Evaluations run one at a time; runs that only mark answers do not count.
    const evaluating = [...this.controllers.keys()].some((id) => this.runs.get(id)?.request.kind === 'evaluate')
    if (evaluating) return
    const documentId = this.waiting.shift()
    if (documentId !== undefined) void this.run(documentId)
  }

  private async run(documentId: string): Promise<void> {
    const run = this.runs.get(documentId)
    if (!run) return
    const { request } = run
    const controller = new AbortController()
    this.controllers.set(documentId, controller)
    try {
      let events: AsyncIterable<EvaluationEvent>
      if (request.kind === 'evaluate') {
        this.update(documentId, { status: 'running', step: 'extract', stepStartedAt: Date.now() })
        await this.options.prepare(documentId, controller.signal)
        this.update(documentId, { step: 'split', stepStartedAt: Date.now() })
        events = this.options.evaluate(request, controller.signal)
      } else {
        const marking =
          request.questionIds ??
          request.evaluation.answers.filter((answer) => answer.marks === null).map((answer) => answer.question_id)
        this.update(documentId, {
          status: 'running',
          step: 'mark',
          stepStartedAt: Date.now(),
          evaluation: request.evaluation,
          marking,
          toMark: marking.length,
        })
        events = this.options.grade(request, controller.signal)
      }
      for await (const event of events) {
        if (event.type === 'split') {
          const marking = event.evaluation.answers
            .filter((answer) => answer.status === 'pending')
            .map((answer) => answer.question_id)
          this.update(documentId, {
            step: 'mark',
            stepStartedAt: Date.now(),
            evaluation: event.evaluation,
            marking,
            toMark: marking.length,
          })
          this.options.onEvaluation(event.evaluation)
        } else if (event.type === 'answer') {
          const current = this.runs.get(documentId)
          if (!current?.evaluation) continue
          const evaluation = withAnswer(current.evaluation, event.answer)
          this.update(documentId, {
            evaluation,
            marking: current.marking.filter((id) => id !== event.answer.question_id),
          })
          this.options.onEvaluation(evaluation)
        } else if (event.type === 'done') {
          this.update(documentId, { status: 'done', step: undefined, evaluation: event.evaluation, marking: [] })
          this.options.onEvaluation(event.evaluation)
          return
        } else if (event.type === 'error') {
          this.update(documentId, { status: 'error', error: event.message, marking: [] })
          return
        }
      }
      this.update(documentId, {
        status: 'error',
        error: 'The connection closed before the evaluation was complete.',
        marking: [],
      })
    } catch (error) {
      if (controller.signal.aborted) {
        this.update(documentId, { status: 'stopped', marking: [] })
      } else {
        this.update(documentId, { status: 'error', error: messageOf(error), marking: [] })
      }
    } finally {
      this.controllers.delete(documentId)
      this.startNext()
    }
  }

  private update(documentId: string, changes: Partial<EvaluationRun>): void {
    const run = this.runs.get(documentId)
    if (!run) return // Removed while it was running.
    this.runs.set(documentId, { ...run, ...changes })
    this.emit()
  }

  private emit(): void {
    this.snapshot = new Map(this.runs)
    for (const listener of this.listeners) listener()
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong while evaluating the script.'
}
