import { describe, expect, it, vi } from 'vitest'

import type { EvaluatedAnswer, Evaluation, EvaluationEvent } from './api'
import { EvaluationRunner, type EvaluateRequest, type GradeRequest } from './evaluationRunner'

const answer = (id: string, status: EvaluatedAnswer['status'], marks: number | null = null): EvaluatedAnswer => ({
  question_id: id,
  number: id,
  max_marks: 5,
  answer: status === 'unanswered' ? '' : 'Text',
  pages: [1],
  status,
  ai_marks: marks,
  feedback: '',
  error: null,
  model: null,
  graded_at: null,
  teacher_marks: null,
  marks: status === 'unanswered' ? 0 : marks,
})

const evaluation = (documentId: string, answers: EvaluatedAnswer[]): Evaluation => ({
  id: `evaluation-of-${documentId}`,
  document_id: documentId,
  document_name: `${documentId}.pdf`,
  exam_id: 'exam',
  exam_name: 'Unit test',
  model: 'm',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:00:00Z',
  student_name: '',
  roll_number: '',
  answers,
  marks: 0,
  max_marks: answers.length * 5,
  complete: false,
})

/** Event streams that the test feeds by hand, one per document. */
function controllableStreams() {
  const streams = new Map<string, { push: (event: EvaluationEvent) => void }>()
  const open = (documentId: string, signal: AbortSignal): AsyncIterable<EvaluationEvent> => ({
    async *[Symbol.asyncIterator]() {
      const pending: EvaluationEvent[] = []
      let wake: (() => void) | undefined
      streams.set(documentId, {
        push(event) {
          pending.push(event)
          wake?.()
        },
      })
      signal.addEventListener('abort', () => wake?.())
      for (;;) {
        while (pending.length > 0) yield pending.shift()!
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        await new Promise<void>((resolve) => (wake = resolve))
      }
    },
  })
  return { open, stream: (documentId: string) => streams.get(documentId)! }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  const streams = controllableStreams()
  const prepared: string[] = []
  let prepare = (documentId: string): Promise<void> => {
    prepared.push(documentId)
    return Promise.resolve()
  }
  const evaluate = vi.fn((request: EvaluateRequest, signal: AbortSignal) => streams.open(request.documentId, signal))
  const grade = vi.fn((request: GradeRequest, signal: AbortSignal) => streams.open(request.documentId, signal))
  const onEvaluation = vi.fn()
  const runner = new EvaluationRunner({
    prepare: (documentId) => prepare(documentId),
    evaluate,
    grade,
    onEvaluation,
  })
  const run = (documentId: string) => runner.getSnapshot().get(documentId)
  const start = (documentId: string) => runner.start({ kind: 'evaluate', documentId, examId: 'exam', model: 'm' })
  return {
    runner,
    streams,
    prepared,
    setPrepare: (next: typeof prepare) => (prepare = next),
    evaluate,
    grade,
    onEvaluation,
    run,
    start,
  }
}

describe('EvaluationRunner', () => {
  it('extracts, splits and marks a script, reporting its progress', async () => {
    const { streams, prepared, onEvaluation, run, start } = setup()

    start('asha')
    expect(run('asha')).toMatchObject({ status: 'running', step: 'extract' })
    await flush()

    expect(prepared).toEqual(['asha'])
    expect(run('asha')?.step).toBe('split')

    const split = evaluation('asha', [answer('q1', 'pending'), answer('q2', 'unanswered'), answer('q3', 'pending')])
    streams.stream('asha').push({ type: 'split', evaluation: split })
    await flush()
    expect(run('asha')).toMatchObject({ step: 'mark', marking: ['q1', 'q3'], toMark: 2 })
    expect(onEvaluation).toHaveBeenLastCalledWith(split)

    streams.stream('asha').push({ type: 'answer', answer: answer('q3', 'graded', 4) })
    await flush()
    expect(run('asha')?.marking).toEqual(['q1'])
    expect(run('asha')?.evaluation?.marks).toBe(4)
    expect(onEvaluation.mock.lastCall?.[0].answers[2].marks).toBe(4)

    const done = { ...split, marks: 7, complete: true }
    streams.stream('asha').push({ type: 'done', evaluation: done })
    await flush()
    expect(run('asha')).toMatchObject({ status: 'done', evaluation: done, marking: [] })
    expect(onEvaluation).toHaveBeenLastCalledWith(done)
  })

  it('evaluates one script at a time', async () => {
    const { streams, evaluate, run, start } = setup()

    start('asha')
    start('ravi')
    await flush()

    expect(run('ravi')?.status).toBe('queued')
    expect(evaluate).toHaveBeenCalledTimes(1)

    streams.stream('asha').push({ type: 'error', message: 'Out of credit' })
    await flush()

    expect(run('asha')).toMatchObject({ status: 'error', error: 'Out of credit' })
    expect(run('ravi')?.status).toBe('running')
    expect(evaluate).toHaveBeenCalledTimes(2)
  })

  it('does not start a second run for the same script', async () => {
    const { runner, start } = setup()

    expect(start('asha')).toBe(true)
    expect(start('asha')).toBe(false)
    expect(runner.start({ kind: 'grade', documentId: 'asha', evaluation: evaluation('asha', []), model: 'm' })).toBe(
      false,
    )
  })

  it('stops a running evaluation and drops a queued one', async () => {
    const { runner, run, start } = setup()
    start('asha')
    start('ravi')
    await flush()

    runner.stop('ravi')
    runner.stop('asha')
    await flush()

    expect(run('asha')?.status).toBe('stopped')
    expect(run('ravi')).toBeUndefined()
  })

  it('reports pages whose text could not be extracted', async () => {
    const { setPrepare, evaluate, run, start } = setup()
    setPrepare(() => Promise.reject(new Error('Could not extract the text of page 2.')))

    start('asha')
    await flush()

    expect(run('asha')).toMatchObject({ status: 'error', error: 'Could not extract the text of page 2.' })
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('marks answers again without waiting for other evaluations', async () => {
    const { runner, streams, grade, run, start } = setup()
    start('asha')
    await flush()
    const marked = evaluation('ravi', [answer('q1', 'graded', 2), answer('q2', 'error'), answer('q3', 'pending')])

    runner.start({ kind: 'grade', documentId: 'ravi', evaluation: marked, model: 'm' })
    await flush()

    expect(grade).toHaveBeenCalledTimes(1)
    expect(run('ravi')).toMatchObject({ status: 'running', step: 'mark', marking: ['q2', 'q3'], toMark: 2 })

    streams.stream('ravi').push({ type: 'answer', answer: answer('q2', 'graded', 3) })
    await flush()
    expect(run('ravi')?.marking).toEqual(['q3'])

    runner.start({ kind: 'grade', documentId: 'nila', evaluation: marked, model: 'm', questionIds: ['q1'] })
    expect(run('nila')?.marking).toEqual(['q1'])
  })

  it('reports a stream that ends too early', async () => {
    const { runner, run } = setup()
    const empty: AsyncIterable<EvaluationEvent> = { async *[Symbol.asyncIterator]() {} }
    const custom = new EvaluationRunner({
      prepare: () => Promise.resolve(),
      evaluate: () => empty,
      grade: () => empty,
      onEvaluation: () => {},
    })

    custom.start({ kind: 'evaluate', documentId: 'asha', examId: 'exam', model: 'm' })
    await flush()

    expect(custom.getSnapshot().get('asha')?.error).toMatch(/closed before/)
    expect(run('asha')).toBeUndefined()
    expect(runner.getSnapshot().size).toBe(0)
  })

  it('forgets the run of a deleted script', async () => {
    const { runner, run, start } = setup()
    start('asha')
    await flush()

    runner.remove('asha')
    await flush()

    expect(run('asha')).toBeUndefined()
  })
})
