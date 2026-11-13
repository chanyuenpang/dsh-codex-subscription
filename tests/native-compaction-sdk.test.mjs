import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdDecompressSync } from 'node:zlib'
import { openaiCodexProvider } from '../src/pi-ai-runtime.js'
import { nativeCompactionPayload, createNativeCompactionCollector } from '../src/native-compaction-protocol.js'

// Exercise the installed real SDK with a synthetic transport, never a paid API.
for (const terminalType of ['response.completed', 'response.done']) test('real SDK completes opaque v2 request: ' + terminalType, async () => {
  const provider = openaiCodexProvider()
  const model = provider.getModels()[0]
  const collector = createNativeCompactionCollector()
  const item = { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'SYNTHETIC_ONLY' }
  const events = [
    { type: 'response.created', response: { id: 'resp_fixture' } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: terminalType, response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
  ]
  let requests = 0, payload
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests++
    assert.match(String(url), /chatgpt[.]com.*[/]responses$/)
    const headers = new Headers(init.headers)
    const raw = headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(init.body).toString() : String(init.body)
    payload = JSON.parse(raw)
    for (const event of events) collector.accept(event)
    return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    const apiKey = 'e30.' + Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64url') + '.fixture'
    const output = []
    for await (const event of provider.streamSimple(model, { messages: [{ role: 'user', content: 'Synthetic history. The marker is BLUE-17.', timestamp: 1 }] }, { apiKey, transport: 'sse', maxRetries: 0, onPayload: nativeCompactionPayload })) output.push(event)
    assert.equal(requests, 1)
    assert.equal(output.at(-1).type, 'done', JSON.stringify(output.at(-1)))
    assert.deepEqual(payload.input.at(-1), { type: 'compaction_trigger' })
    assert.equal(payload.context_management, undefined)
    assert.equal(payload.store, false)
    assert.deepEqual(collector.finish().item, item)
    // This is why a text-only summarizer cannot be used as the commit boundary:
    // the SDK's normal content conversion intentionally has no opaque item block.
    assert.equal(JSON.stringify(output.at(-1).message.content).includes('SYNTHETIC_ONLY'), false)
  } finally { globalThis.fetch = previous }
})
