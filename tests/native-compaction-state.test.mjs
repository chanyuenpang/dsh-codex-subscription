import test from 'node:test'
import assert from 'node:assert/strict'
import { captureNativeCheckpoint, replayNativeCheckpoint } from '../src/native-compaction-state.js'
const scope = { account: 'fixture', model: 'fixture-model', session: 'fixture-session' }
const payload = { model: scope.model, instructions: 'Canonical instructions', tools: [{ type: 'function', name: 'read' }], stream: true, store: false, input: [
  { role: 'developer', content: [{ type: 'input_text', text: 'Canonical developer context' }] },
  { role: 'user', content: [{ type: 'input_text', text: 'Keep the record' }, { type: 'input_image', image_url: 'synthetic-image' }] },
  { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
  { type: 'function_call_output', call_id: 'c1', output: 'record-marker' },
  { role: 'assistant', content: [{ type: 'output_text', text: 'Noted the record-marker' }] },
] }
const result = { payload, responseId: 'r', item: { type: 'compaction', encrypted_content: 'SYNTHETIC_OPAQUE' } }
const create = () => captureNativeCheckpoint({ result, scope, now: 1000 })
test('JSON restart round trip retains user/instruction/image context and closed tool history only inside checkpoint', () => {
  const before = structuredClone(payload), state = JSON.parse(JSON.stringify(create()))
  const replay = replayNativeCheckpoint(payload, state, scope, 2000)
  assert.deepEqual(payload, before, 'complete source history is never mutated')
  assert.deepEqual(replay.input, [payload.input[0], payload.input[1], result.item])
  assert.deepEqual(replay.tools, payload.tools)
  assert.equal(replay.instructions, payload.instructions)
  assert.equal(JSON.stringify(replay.input).includes('record-marker'), false)
  replay.input[0].content[0].text = 'changed'
  assert.deepEqual(payload, before)
  assert.equal(state.items[0].content[0].text, 'Canonical developer context')
})
test('process-local prompt-cache key rotation does not invalidate semantic history', () => {
  assert.ok(replayNativeCheckpoint({ ...payload, prompt_cache_key:'new-connection' }, create(), scope, 2000))
})
test('tail tool calls and results stay paired after replay', () => {
  const tail = [{ type: 'function_call', call_id: 'c2', name: 'read', arguments: '{}' }, { type: 'function_call_output', call_id: 'c2', output: 'new result' }]
  assert.deepEqual(replayNativeCheckpoint({ ...payload, input: [...payload.input, ...tail] }, create(), scope, 2000).input.slice(-2), tail)
})
test('account/model/session changes, rewind, edits and DSH summary replace all invalidate without changing original', () => {
  const state = create()
  for (const key of ['account','model','session']) assert.equal(replayNativeCheckpoint(payload, state, { ...scope, [key]: 'other' }, 2000), undefined)
  for (const input of [payload.input.slice(0,-1), [{ role:'user', content:'DSH summary' }], payload.input.map((x,i) => i === 4 ? { ...x, content:'edited' } : x)]) {
    const current = { ...payload, input }; const before = structuredClone(current)
    assert.equal(replayNativeCheckpoint(current, state, scope, 2000), undefined)
    assert.deepEqual(current, before)
  }
})
test('instructions/tools change invalidates encrypted state rather than silently reusing stale context', () => {
  for (const replacement of [{ instructions:'new' }, { tools:[] }]) assert.equal(replayNativeCheckpoint({ ...payload, ...replacement }, create(), scope, 2000), undefined)
})
test('corrupt, missing, stale and future cache states are optional and safely discarded', () => {
  const state = create()
  for (const value of [undefined, {}, { ...state, version:2 }, { ...state, digest:'corrupt' }, { ...state, createdAt:3000 }, { ...state, prefixLength:Infinity }]) assert.equal(replayNativeCheckpoint(payload, value, scope, 2000), undefined)
  assert.equal(replayNativeCheckpoint(payload, state, scope, 8*86400000), undefined)
})
test('open, missing and duplicate tool boundaries refuse compaction and replay', () => {
  for (const input of [payload.input.filter(x => x.type !== 'function_call_output'), payload.input.filter(x => x.type !== 'function_call'), [...payload.input, payload.input[2]]]) {
    const current = { ...payload, input }
    assert.throws(() => captureNativeCheckpoint({ result:{ ...result, payload:current }, scope, now:1000 }), /closed tool pairs/)
    assert.equal(replayNativeCheckpoint(current, create(), scope, 2000), undefined)
  }
})
test('checkpoint-on-checkpoint is deliberately not advertised by this first conservative slice', () => {
  const wire = replayNativeCheckpoint(payload, create(), scope, 2000)
  assert.throws(() => captureNativeCheckpoint({ result:{ ...result, payload:wire }, scope, now:2000 }), /uncompacted/)
})
