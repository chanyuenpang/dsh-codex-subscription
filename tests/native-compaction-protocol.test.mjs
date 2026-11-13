import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeCompactionPayload, createNativeCompactionCollector } from '../src/native-compaction-protocol.js'
const item = { type: 'compaction', id: 'cmp_synthetic', encrypted_content: 'SYNTHETIC_CHECKPOINT_ONLY' }
const done = (type = 'response.completed', output = [item]) => ({ type, response: { id: 'resp_synthetic', status: 'completed', output } })
const code = expected => error => error.code === expected

test('v2 keeps complete instructions/tools/input, isolates continuation and does not mutate the caller', () => {
  const source = { model: 'fixture', instructions: 'keep', tools: [{ type: 'function', name: 'lookup' }], input: [{ role: 'user', content: 'history' }], context_management: [{}], previous_response_id: 'old', store: true }
  const before = structuredClone(source)
  const request = nativeCompactionPayload(source)
  assert.deepEqual(source, before)
  assert.deepEqual(request.input, [...source.input, { type: 'compaction_trigger' }])
  assert.equal(request.context_management, undefined)
  assert.equal(request.previous_response_id, undefined)
  assert.equal(request.store, false)
  assert.equal(request.stream, true)
  assert.deepEqual(request.tools, source.tools)
  request.tools[0].name = 'changed'
  assert.equal(source.tools[0].name, 'lookup')
})
test('invalid and already-triggered requests are refused', () => {
  for (const value of [{}, { model: 'fixture' }, { model: 'fixture', input: [{ type: 'compaction_trigger' }] }]) assert.throws(() => nativeCompactionPayload(value), code('INVALID_REQUEST'))
})
for (const type of ['response.completed', 'response.done']) test(type + ' preserves a completed checkpoint without item-done', () => {
  const c = createNativeCompactionCollector()
  c.accept(done(type))
  assert.deepEqual(c.finish(), { item, responseId: 'resp_synthetic' })
  assert.throws(() => c.finish(), code('ALREADY_FINISHED'))
})
test('streamed checkpoint and terminal copy are accepted once; usage is allowlisted', () => {
  const c = createNativeCompactionCollector()
  c.accept({ type: 'response.output_item.done', item })
  const end = done()
  end.response.usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 80, sensitive: 'not retained' }, extra: 'not retained' }
  c.accept(end)
  assert.deepEqual(c.finish().usage, { input_tokens: 100, output_tokens: 10, total_tokens: 110, input_tokens_details: { cached_tokens: 80 } })
})
test('an item without a terminal event never becomes a checkpoint', () => {
  const c = createNativeCompactionCollector()
  c.accept({ type: 'response.output_item.done', item })
  assert.throws(() => c.finish(), code('INCOMPLETE_STREAM'))
  assert.throws(() => c.accept(done()), code('INCOMPLETE_STREAM'))
  assert.throws(() => c.finish(), code('INCOMPLETE_STREAM'))
})
test('terminal without output can complete a previously delivered item', () => {
  const c = createNativeCompactionCollector()
  c.accept({ type: 'response.output_item.done', item })
  const end = done(); delete end.response.output
  c.accept(end)
  assert.deepEqual(c.finish().item, item)
})
test('failure poisons collection, even if a later successful terminal arrives', () => {
  for (const type of ['error', 'response.failed', 'response.incomplete', 'response.cancelled']) {
    const c = createNativeCompactionCollector()
    assert.throws(() => c.accept({ type, message: item.encrypted_content }), error => error.code === 'COMPACTION_FAILED' && !error.message.includes(item.encrypted_content))
    assert.throws(() => c.accept(done()), code('COMPACTION_FAILED'))
    assert.throws(() => c.finish(), code('COMPACTION_FAILED'))
  }
})
test('cancellation after terminal still prevents publication', () => {
  const c = createNativeCompactionCollector(); c.accept(done())
  const reason = new Error('cancelled')
  assert.throws(() => c.finish(AbortSignal.abort(reason)), error => error === reason)
  assert.throws(() => c.finish(), error => error === reason)
  assert.throws(() => c.accept(done()), error => error === reason)
})
test('ordinary output and duplicate checkpoints are never executed or adopted', () => {
  const c = createNativeCompactionCollector()
  assert.throws(() => c.accept({ type: 'response.output_item.done', item: { type: 'function_call', name: 'dangerous' } }), code('UNEXPECTED_OUTPUT'))
  const duplicate = createNativeCompactionCollector()
  duplicate.accept({ type: 'response.output_item.done', item })
  assert.throws(() => duplicate.accept({ type: 'response.output_item.done', item }), code('DUPLICATE_CHECKPOINT'))
})
test('invalid, multiple, conflicting, and oversized checkpoints are rejected', () => {
  for (const output of [[], [item, item], [{ ...item, encrypted_content: '' }], [{ type: 'message', content: [] }]]) {
    const c = createNativeCompactionCollector()
    assert.throws(() => c.accept(done('response.completed', output)), code('INVALID_CHECKPOINT'))
  }
  const c = createNativeCompactionCollector()
  c.accept({ type: 'response.output_item.done', item })
  assert.throws(() => c.accept(done('response.completed', [{ ...item, encrypted_content: 'other' }])), code('CHECKPOINT_MISMATCH'))
  assert.throws(() => createNativeCompactionCollector({ maxBytes: 10 }).accept(done()), code('CHECKPOINT_TOO_LARGE'))
})
test('non-successful terminal and missing response id are rejected', () => {
  for (const mutate of [e => e.response.status = 'incomplete', e => delete e.response.id]) {
    const c = createNativeCompactionCollector(); const end = done(); mutate(end)
    assert.throws(() => c.accept(end), code('INVALID_TERMINAL'))
  }
})
test('a post-terminal event invalidates the result before publication', () => {
  const c = createNativeCompactionCollector(); c.accept(done())
  assert.throws(() => c.accept({ type: 'error' }), code('EVENT_AFTER_TERMINAL'))
  assert.throws(() => c.finish(), code('EVENT_AFTER_TERMINAL'))
})
