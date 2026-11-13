import test from 'node:test'
import assert from 'node:assert/strict'
import { openaiCodexProvider } from '../src/pi-ai-runtime.js'
import { requestNativeCompaction } from '../src/native-compaction-request.js'
const provider = openaiCodexProvider(), model = provider.getModels()[0]
const apiKey = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url') + '.fixture'
const item = { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'SYNTHETIC_中文_ONLY' }
const end = { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item] } }
const frames = [{ type: 'response.output_item.done', item }, end]
const encode = (events, newline = '\n') => events.map(e => 'data: ' + JSON.stringify(e) + newline + newline).join('')
const context = { messages: [{ role: 'user', content: 'Synthetic only', timestamp: 1 }] }
async function run(body, { signal, chunks = 7, streamError = false, abort } = {}) {
  let calls = 0
  const result = await requestNativeCompaction({ provider, model, context,
    options: { apiKey, signal, sessionId: 'fixture' },
    network: { env: {}, platform: 'test', standardHttps: true, fetchThroughProxy: async () => {
      calls++
      const bytes = new TextEncoder().encode(body)
      let i = 0
      return new Response(new ReadableStream({ pull(controller) {
        if (i < bytes.length) { controller.enqueue(bytes.slice(i, i += chunks)); return }
        if (abort) abort()
        if (streamError) controller.error(Error('sensitive transport detail'))
        else controller.close()
      } }), { headers: { 'content-type': 'text/event-stream' } })
    } },
  })
  assert.equal(calls, 1, 'maintenance requests never retry')
  return result
}
for (const newline of ['\n', '\r\n']) test('real byte observer captures opaque item with ' + JSON.stringify(newline), async () => {
  const result = await run(encode(frames, newline))
  assert.deepEqual(result.item, item)
  assert.equal(result.payload.input.some(x => x.type === 'compaction_trigger'), false)
  assert.equal(result.payload.model, model.id)
})
test('split UTF-8, comments and multiline data fields pass through the actual SDK', async () => {
  const body = ': heartbeat\n\n' + 'data: ' + JSON.stringify(frames[0]) + '\n\n'
    + 'data: {"type":"response.done",\ndata: "response":' + JSON.stringify(end.response) + '}\n\n'
  assert.deepEqual((await run(body, { chunks: 1 })).item, item)
})
for (const [name,body] of [
  ['EOF without terminal', encode(frames.slice(0,1))],
  ['malformed JSON', 'data: {bad}\n\n'],
  ['failure after item', encode([frames[0], { type: 'response.failed' }])],
  ['tool output', encode([{ type: 'response.output_item.done', item: { type: 'function_call', call_id: 't' } }, end])],
]) test(name + ' never returns a checkpoint', async () => {
  await assert.rejects(run(body), error => ['REQUEST_FAILED','INCOMPLETE_STREAM'].includes(error.code))
})
test('transport exception before successful terminal is not retried or exposed', async () => {
  await assert.rejects(run(encode(frames.slice(0,1)), { streamError: true }), error => error.code === 'REQUEST_FAILED' && !error.message.includes('sensitive'))
})
test('cancellation while waiting for terminal returns no checkpoint', async () => {
  const abort = new AbortController()
  await assert.rejects(run(encode(frames.slice(0,1)), { signal: abort.signal, abort: () => abort.abort() }), error => error.name === 'AbortError')
})
test('successful terminal is the boundary, matching native Codex; later bytes are not evidence', async () => {
  assert.deepEqual((await run(encode([...frames, { type: 'error' }]), { chunks: 10000 })).item, item)
})
