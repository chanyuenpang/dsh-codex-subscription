// One isolated maintenance request. Not wired into automatic DSH compaction.
import { withCodexNetwork } from './oauth-network.js'
import { NativeCompactionError, nativeCompactionPayload, createNativeCompactionCollector } from './native-compaction-protocol.js'
const terminal = new Set(['response.completed', 'response.done'])
const invalid = () => new NativeCompactionError('INVALID_STREAM', 'Native compaction returned an invalid event stream')

/** Parse actual bytes, including split UTF-8 and CRLF, before pi-ai drops opaque items. */
export function observeNativeCompactionResponse(response, collector, { maxEventBytes = 3 * 1024 * 1024 } = {}) {
  if (!response.ok || !response.body) return response
  if (!Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1) throw new TypeError('Invalid event size limit')
  const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder()
  let pending = '', data = [], dataBytes = 0, completed = false
  const dispatch = controller => {
    if (!data.length) return
    const value = data.join('\n'); data = []; dataBytes = 0
    if (value === '[DONE]') { controller.enqueue(encoder.encode('data: [DONE]\n\n')); return }
    let event
    try { event = JSON.parse(value) } catch { throw invalid() }
    collector.accept(event)
    controller.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'))
    // Like native Codex and pi-ai, a successful terminal is the response boundary,
    // not socket EOF. No claim is made about bytes after that terminal.
    completed = terminal.has(event.type)
  }
  const line = (value, controller) => {
    if (value.endsWith('\r')) value = value.slice(0, -1)
    if (!value) { dispatch(controller); return }
    if (!value.startsWith('data:')) return
    const field = value.slice(5).replace(/^ /, '')
    dataBytes += Buffer.byteLength(field, 'utf8') + 1
    if (dataBytes > maxEventBytes) throw invalid()
    data.push(field)
  }
  const stream = response.body.pipeThrough(new TransformStream({
    transform(bytes, controller) {
      if (completed) return
      try { pending += decoder.decode(bytes, { stream: true }) } catch { throw invalid() }
      let index
      while (!completed && (index = pending.indexOf('\n')) >= 0) {
        const value = pending.slice(0, index); pending = pending.slice(index + 1)
        line(value, controller)
      }
      if (completed) { pending = ''; data = []; return }
      if (Buffer.byteLength(pending, 'utf8') + dataBytes > maxEventBytes) throw invalid()
    },
    flush(controller) {
      if (completed) return
      try { pending += decoder.decode() } catch { throw invalid() }
      if (pending) line(pending, controller)
      dispatch(controller)
    },
  }))
  const headers = new Headers(response.headers)
  headers.delete('content-length'); headers.delete('content-encoding')
  return new Response(stream, { status: response.status, statusText: response.statusText, headers })
}

/** Reuse pi-ai's request builder/auth and the plugin's scoped proxy transport. */
export async function requestNativeCompaction({ provider, model, context, options = {}, network = {} }) {
  const collector = createNativeCompactionCollector()
  const signal = options.signal ?? AbortSignal.timeout(120_000)
  let payload, successful = false
  signal.throwIfAborted()
  try {
    await withCodexNetwork(async () => {
      const stream = provider.streamSimple(model, context, {
        ...options, signal, transport: 'sse', maxRetries: 0,
        onPayload: async (body, requestModel) => {
          const prepared = await options.onPayload?.(body, requestModel) ?? body
          payload = structuredClone(prepared)
          return nativeCompactionPayload(prepared)
        },
      })
      for await (const event of stream) {
        signal.throwIfAborted()
        if (event.type === 'error') throw new NativeCompactionError('REQUEST_FAILED', 'Native compaction request failed; no checkpoint was committed')
        if (event.type === 'done') successful = true
      }
    }, {
      ...network, websocket: false,
      transformResponse: (response, target) => {
        if (target.hostname !== 'chatgpt.com' || target.pathname !== '/backend-api/codex/responses') return response
        return observeNativeCompactionResponse(response, collector)
      },
    })
    signal.throwIfAborted()
    if (!successful || !payload) throw invalid()
    return { ...collector.finish(signal), payload }
  } catch (error) {
    if (signal.aborted) throw signal.reason
    if (error instanceof NativeCompactionError) throw error
    // Do not expose transport messages which might echo a payload or credentials.
    throw new NativeCompactionError('REQUEST_FAILED', 'Native compaction request failed; no checkpoint was committed')
  }
}
