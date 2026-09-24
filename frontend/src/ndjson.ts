/** Parse a stream of newline-delimited JSON, yielding one value per line. */
export async function* readNdjson<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  try {
    for (;;) {
      const { value, done } = await reader.read()
      // `stream: true` keeps multi-byte characters that are split across chunks intact.
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield JSON.parse(line) as T
        newline = buffer.indexOf('\n')
      }
      if (done) break
    }
    finished = true
    const rest = buffer.trim()
    if (rest) yield JSON.parse(rest) as T
  } finally {
    // Stop downloading if the caller gave up before the end of the stream.
    if (!finished) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
