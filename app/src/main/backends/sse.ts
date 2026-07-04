// Shared SSE line-stream parser for the model backends. Reads a fetch response body,
// buffers, splits on blank-line event boundaries, and yields each `data:` JSON payload.
// Used by GLM (Anthropic Messages streaming) and OpenAI (chat-completions streaming) to
// reassemble the response. Abort propagates as a thrown error from reader.read() — callers
// catch it and treat it as a stop.
export type SSEData = Record<string, unknown>

export async function parseSSE(body: ReadableStream<Uint8Array>, onData: (data: SSEData) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // SSE events are separated by a blank line (\n\n or \r\n\r\n). The trailing partial event
    // stays in the buffer until the next chunk completes it.
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = events.pop() ?? ''
    for (const raw of events) {
      const dataLines = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
      if (!dataLines.length) continue
      const payload = dataLines.join('\n')
      if (payload === '[DONE]') return
      try {
        onData(JSON.parse(payload) as SSEData)
      } catch {
        /* malformed chunk — skip */
      }
    }
  }
}
