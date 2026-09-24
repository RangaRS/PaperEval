import { describe, expect, it } from 'vitest'

import { readNdjson } from './ndjson'

function streamOf(...pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const collected: T[] = []
  for await (const value of values) collected.push(value)
  return collected
}

describe('readNdjson', () => {
  it('yields one value per line', async () => {
    const values = await collect(readNdjson(streamOf('{"a":1}\n{"a":2}\n')))

    expect(values).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('joins lines that arrive in several pieces', async () => {
    const values = await collect(readNdjson(streamOf('{"text":"Hel', 'lo"}\n{"te', 'xt":"!"}\n')))

    expect(values).toEqual([{ text: 'Hello' }, { text: '!' }])
  })

  it('skips blank lines and reads a last line without a newline', async () => {
    const values = await collect(readNdjson(streamOf('\n{"a":1}\r\n\n{"a":2}')))

    expect(values).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('decodes multi-byte characters split across pieces', async () => {
    const bytes = new TextEncoder().encode('{"text":"é中"}\n')
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    })

    expect(await collect(readNdjson(stream))).toEqual([{ text: 'é中' }])
  })

  it('cancels the stream when the reader stops early', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":1}\n{"a":2}\n'))
      },
      cancel() {
        cancelled = true
      },
    })

    for await (const value of readNdjson(stream)) {
      expect(value).toEqual({ a: 1 })
      break
    }

    expect(cancelled).toBe(true)
  })
})
