import { describe, expect, it, vi } from 'vitest'

import type { OcrEvent, OcrResult } from './api'
import { OcrQueue, pageKey, type OcrJob } from './ocrQueue'

const result = (text: string): OcrResult => ({
  text,
  model: 'llava',
  prompt: 'Read it',
  created_at: '2026-01-01T00:00:00Z',
  duration_ms: 1200,
  truncated: false,
  prompt_tokens: 10,
  output_tokens: 2,
})

/** A job runner whose streams the test drives by hand. */
function controllableRunner() {
  const streams = new Map<string, { push: (event: OcrEvent) => void; fail: (error: Error) => void }>()
  const run = (job: OcrJob, signal: AbortSignal): AsyncIterable<OcrEvent> => ({
    async *[Symbol.asyncIterator]() {
      const pending: OcrEvent[] = []
      let wake: (() => void) | undefined
      let failure: Error | undefined
      streams.set(job.key, {
        push(event) {
          pending.push(event)
          wake?.()
        },
        fail(error) {
          failure = error
          wake?.()
        },
      })
      signal.addEventListener('abort', () => {
        failure = new DOMException('Aborted', 'AbortError')
        wake?.()
      })
      for (;;) {
        while (pending.length > 0) {
          const event = pending.shift()!
          yield event
          if (event.type === 'done' || event.type === 'error') return
        }
        if (failure) throw failure
        await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  })
  return { run, stream: (key: string) => streams.get(key)! }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup(concurrency = 1) {
  const runner = controllableRunner()
  const onResult = vi.fn()
  const queue = new OcrQueue({ run: runner.run, onResult, concurrency })
  const job = (pageNumber: number) => queue.getSnapshot().get(pageKey('doc', pageNumber))
  const enqueue = (pageNumber: number) => queue.enqueue({ documentId: 'doc', pageNumber, model: 'llava', prompt: 'Read it' })
  return { queue, runner, onResult, job, enqueue }
}

describe('OcrQueue', () => {
  it('streams text into the job and reports the saved result', async () => {
    const { runner, onResult, job, enqueue } = setup()

    enqueue(1)
    await flush()
    expect(job(1)?.status).toBe('running')

    runner.stream('doc/1').push({ type: 'start', model: 'llava' })
    runner.stream('doc/1').push({ type: 'chunk', text: 'Hello ' })
    runner.stream('doc/1').push({ type: 'chunk', text: 'world' })
    await flush()
    expect(job(1)?.text).toBe('Hello world')

    runner.stream('doc/1').push({ type: 'done', result: result('Hello world') })
    await flush()
    expect(job(1)).toMatchObject({ status: 'done', result: result('Hello world') })
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 1 }), result('Hello world'))
  })

  it('runs one page at a time, in order', async () => {
    const { runner, job, enqueue } = setup()

    enqueue(1)
    enqueue(2)
    await flush()
    expect([job(1)?.status, job(2)?.status]).toEqual(['running', 'queued'])

    runner.stream('doc/1').push({ type: 'done', result: result('one') })
    await flush()
    expect([job(1)?.status, job(2)?.status]).toEqual(['done', 'running'])
  })

  it('can run several pages at once', async () => {
    const { job, enqueue } = setup(2)

    enqueue(1)
    enqueue(2)
    enqueue(3)
    await flush()

    expect([job(1)?.status, job(2)?.status, job(3)?.status]).toEqual(['running', 'running', 'queued'])
  })

  it('ignores a page that is already queued or running', async () => {
    const { queue, enqueue } = setup()
    const listener = vi.fn()
    queue.subscribe(listener)

    enqueue(1)
    const updates = listener.mock.calls.length
    enqueue(1)

    expect(listener).toHaveBeenCalledTimes(updates)
    expect(queue.getSnapshot().size).toBe(1)
  })

  it('stops a running page and keeps the partial text', async () => {
    const { queue, runner, job, enqueue } = setup()
    enqueue(1)
    enqueue(2)
    await flush()
    runner.stream('doc/1').push({ type: 'chunk', text: 'Part' })
    await flush()

    queue.cancel('doc/1')
    await flush()

    expect(job(1)).toMatchObject({ status: 'stopped', text: 'Part' })
    expect(job(2)?.status).toBe('running')
  })

  it('takes a waiting page off the queue', async () => {
    const { queue, job, enqueue } = setup()
    enqueue(1)
    enqueue(2)
    await flush()

    queue.cancel('doc/2')

    expect(job(2)).toBeUndefined()
  })

  it('records errors from the server and from the connection', async () => {
    const { runner, job, enqueue } = setup(2)
    enqueue(1)
    enqueue(2)
    await flush()

    runner.stream('doc/1').push({ type: 'error', message: 'Model not found' })
    runner.stream('doc/2').fail(new Error('Network down'))
    await flush()

    expect(job(1)).toMatchObject({ status: 'error', error: 'Model not found' })
    expect(job(2)).toMatchObject({ status: 'error', error: 'Network down' })
  })

  it('flags a stream that ends without a result', async () => {
    const queue = new OcrQueue({
      run: async function* () {
        yield { type: 'start', model: 'llava' } as OcrEvent
      },
      onResult: vi.fn(),
    })

    queue.enqueue({ documentId: 'doc', pageNumber: 1, model: 'llava', prompt: '' })
    await flush()

    expect(queue.getSnapshot().get('doc/1')?.status).toBe('error')
  })

  it('shows when the model is thinking', async () => {
    const { runner, job, enqueue } = setup()
    enqueue(1)
    await flush()

    runner.stream('doc/1').push({ type: 'thinking' })
    await flush()
    expect(job(1)?.thinking).toBe(true)

    runner.stream('doc/1').push({ type: 'chunk', text: 'Text' })
    await flush()
    expect(job(1)?.thinking).toBe(false)
  })

  it('stops all pages of a document without starting the waiting ones', async () => {
    const run = vi.fn(controllableRunner().run)
    const queue = new OcrQueue({ run, onResult: vi.fn() })
    for (const pageNumber of [1, 2, 3]) queue.enqueue({ documentId: 'doc', pageNumber, model: 'llava', prompt: '' })
    queue.enqueue({ documentId: 'other', pageNumber: 1, model: 'llava', prompt: '' })
    await flush()

    queue.cancelAll((job) => job.documentId === 'doc')
    await flush()

    const jobs = queue.getSnapshot()
    expect(jobs.get('doc/1')?.status).toBe('stopped')
    expect(jobs.has('doc/2') || jobs.has('doc/3')).toBe(false)
    expect(jobs.get('other/1')?.status).toBe('running')
    expect(run.mock.calls.map(([job]) => job.key)).toEqual(['doc/1', 'other/1'])
  })

  it('dismisses a failed job but not an active one', async () => {
    const { queue, runner, job, enqueue } = setup()
    enqueue(1)
    enqueue(2)
    await flush()
    runner.stream('doc/1').push({ type: 'error', message: 'Nope' })
    await flush()

    queue.dismiss('doc/1')
    queue.dismiss('doc/2')

    expect(job(1)).toBeUndefined()
    expect(job(2)?.status).toBe('running')
  })

  it('forgets the jobs of a deleted document', async () => {
    const { queue, job, enqueue } = setup()
    enqueue(1)
    enqueue(2)
    await flush()

    queue.remove((candidate) => candidate.documentId === 'doc')
    await flush()

    expect(job(1)).toBeUndefined()
    expect(job(2)).toBeUndefined()
  })
})
