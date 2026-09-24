import type { OcrEvent, OcrResult, Page } from './api'

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'stopped'
export type PageStatus = JobStatus | 'idle'

export interface OcrRequest {
  documentId: string
  pageNumber: number
  model: string
  prompt: string
}

export interface OcrJob extends OcrRequest {
  key: string
  status: JobStatus
  /** Text received so far. */
  text: string
  /** True while the model reasons before it starts answering. */
  thinking: boolean
  startedAt?: number
  error?: string
  result?: OcrResult
}

export interface OcrQueueOptions {
  /** Streams the OCR events for a job. */
  run: (job: OcrJob, signal: AbortSignal) => AsyncIterable<OcrEvent>
  /** Called once a job's text has been saved. */
  onResult: (job: OcrJob, result: OcrResult) => void
  /** How many pages are read at the same time. */
  concurrency?: number
}

export const pageKey = (documentId: string, pageNumber: number) => `${documentId}/${pageNumber}`

export const isActive = (job: OcrJob | undefined) => job?.status === 'queued' || job?.status === 'running'

/** A page's status: its latest job in this session, or else whether it has saved text. */
export const pageStatus = (page: Page, job: OcrJob | undefined): PageStatus =>
  job ? job.status : page.ocr ? 'done' : 'idle'

/**
 * Runs OCR jobs one after another (or a few at a time) and keeps track of their
 * progress. Components subscribe to it with `useSyncExternalStore`.
 */
export class OcrQueue {
  private readonly options: Required<OcrQueueOptions>
  private jobs = new Map<string, OcrJob>()
  private waiting: string[] = []
  private readonly controllers = new Map<string, AbortController>()
  private readonly listeners = new Set<() => void>()
  private snapshot: ReadonlyMap<string, OcrJob> = new Map()

  constructor(options: OcrQueueOptions) {
    this.options = { concurrency: 1, ...options }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ReadonlyMap<string, OcrJob> => this.snapshot

  /** Queue a page for OCR, unless it is already queued or running. */
  enqueue(request: OcrRequest): void {
    const key = pageKey(request.documentId, request.pageNumber)
    if (isActive(this.jobs.get(key))) return
    this.jobs.set(key, { ...request, key, status: 'queued', text: '', thinking: false })
    this.waiting.push(key)
    this.emit()
    this.startNext()
  }

  /** Stop a running job, or take a waiting one off the queue. */
  cancel(key: string): void {
    this.cancelAll((job) => job.key === key)
  }

  /** Stop every matching job: waiting ones are dropped, running ones keep their partial text. */
  cancelAll(matches: (job: OcrJob) => boolean): void {
    // Drop the waiting jobs first so that stopping a running job does not start one of them.
    const dropped = this.waiting.filter((key) => matches(this.jobs.get(key)!))
    if (dropped.length > 0) {
      for (const key of dropped) this.jobs.delete(key)
      this.waiting = this.waiting.filter((key) => this.jobs.has(key))
      this.emit()
    }
    for (const job of this.jobs.values()) {
      if (job.status === 'running' && matches(job)) this.controllers.get(job.key)?.abort()
    }
  }

  /** Forget a finished, failed or stopped job. */
  dismiss(key: string): void {
    if (isActive(this.jobs.get(key)) || !this.jobs.delete(key)) return
    this.emit()
  }

  /** Cancel and forget every job that matches. */
  remove(matches: (job: OcrJob) => boolean): void {
    for (const job of [...this.jobs.values()]) {
      if (!matches(job)) continue
      this.controllers.get(job.key)?.abort()
      this.waiting = this.waiting.filter((key) => key !== job.key)
      this.jobs.delete(job.key)
    }
    this.emit()
  }

  private startNext(): void {
    while (this.controllers.size < this.options.concurrency && this.waiting.length > 0) {
      const key = this.waiting.shift()!
      const job = this.jobs.get(key)
      if (job) void this.run(job)
    }
  }

  private async run(job: OcrJob): Promise<void> {
    const controller = new AbortController()
    this.controllers.set(job.key, controller)
    this.update(job.key, { status: 'running', startedAt: Date.now() })
    try {
      for await (const event of this.options.run(job, controller.signal)) {
        if (event.type === 'thinking') {
          this.update(job.key, { thinking: true })
        } else if (event.type === 'chunk') {
          const current = this.jobs.get(job.key)
          this.update(job.key, { text: (current?.text ?? '') + event.text, thinking: false })
        } else if (event.type === 'done') {
          this.options.onResult(job, event.result)
          this.update(job.key, { status: 'done', text: event.result.text, result: event.result, thinking: false })
          return
        } else if (event.type === 'error') {
          this.update(job.key, { status: 'error', error: event.message, thinking: false })
          return
        }
      }
      this.update(job.key, { status: 'error', error: 'The connection closed before the text was complete.' })
    } catch (error) {
      if (controller.signal.aborted) {
        this.update(job.key, { status: 'stopped', thinking: false })
      } else {
        this.update(job.key, { status: 'error', error: messageOf(error), thinking: false })
      }
    } finally {
      this.controllers.delete(job.key)
      this.startNext()
    }
  }

  private update(key: string, changes: Partial<OcrJob>): void {
    const job = this.jobs.get(key)
    if (!job) return // Removed while it was running.
    this.jobs.set(key, { ...job, ...changes })
    this.emit()
  }

  private emit(): void {
    this.snapshot = new Map(this.jobs)
    for (const listener of this.listeners) listener()
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return 'Something went wrong while reading the page.'
}
