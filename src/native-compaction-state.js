// Optional derived cache only. Never replaces or truncates the DSH event history.
import { createHash } from 'node:crypto'
import { createNativeCompactionCollector } from './native-compaction-protocol.js'
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
const MAX_BYTES = 2 * 1024 * 1024
const MAX_AGE = 7 * 24 * 60 * 60 * 1000
const retainedRole = new Set(['user', 'system', 'developer'])
const identity = scope => {
  const parts = ['account', 'model', 'session'].map(key => scope?.[key])
  if (parts.some(value => typeof value !== 'string' || !value)) throw new Error('Checkpoint requires account, model and session scope')
  return hash(['openai-codex', ...parts])
}
// prompt_cache_key identifies a connection/cache, not conversation semantics.
// It legitimately changes when a process restarts or the WS namespace rotates.
const envelope = ({ input: _input, previous_response_id: _previous, context_management: _inline, prompt_cache_key: _cache, ...rest }) => rest
function closedTools(input) {
  const pending = new Set(), seen = new Set()
  for (const item of input) {
    if (['function_call', 'custom_tool_call'].includes(item?.type)) {
      if (!item.call_id || seen.has(item.call_id)) return false
      pending.add(item.call_id); seen.add(item.call_id)
    } else if (['function_call_output', 'custom_tool_call_output'].includes(item?.type)) {
      if (!pending.delete(item.call_id)) return false
    }
  }
  return pending.size === 0
}

/**
 * Bind a complete maintenance response to the EXACT uncompressed request input.
 * This first slice deliberately does not chain compaction-on-compaction. Retain
 * every original user/system/developer message (including images), unlike a
 * checkpoint-only replay. Native Codex also retains these message roles, with a
 * bounded truncation policy; this conservative slice does not truncate them.
 */
export function captureNativeCheckpoint({ result, scope, now = Date.now() }) {
  const payload = result?.payload
  if (!Array.isArray(payload?.input) || !payload.input.length || payload.model !== scope?.model
    || payload.input.some(item => ['compaction', 'compaction_trigger'].includes(item?.type)) || !closedTools(payload.input)) {
    throw new Error('Checkpoint requires complete uncompacted history with closed tool pairs')
  }
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid checkpoint time')
  // Validate independently rather than persisting an unchecked external object.
  const collector = createNativeCompactionCollector()
  collector.accept({ type: 'response.completed', response: { id: result.responseId, status: 'completed', output: [result.item] } })
  const { item } = collector.finish()
  const items = [...payload.input.filter(entry => retainedRole.has(entry?.role)), item]
  if (Buffer.byteLength(JSON.stringify(items), 'utf8') > MAX_BYTES) throw new Error('Retained checkpoint history exceeds the cache limit')
  return clone({ version: 1, kind: 'codex-native-v2-cache', createdAt: now, scope: identity(scope),
    envelope: hash(envelope(payload)), prefixLength: payload.input.length, prefix: hash(payload.input),
    items, digest: hash(items) })
}

/** Return undefined on any mismatch; callers keep the complete original input. */
export function replayNativeCheckpoint(payload, state, scope, now = Date.now()) {
  try {
    if (state?.version !== 1 || state.kind !== 'codex-native-v2-cache' || state.scope !== identity(scope)
      || payload?.model !== scope.model || !Array.isArray(payload.input)
      || !Number.isSafeInteger(now) || !Number.isSafeInteger(state.createdAt)
      || state.createdAt < 0 || now < state.createdAt || now - state.createdAt > MAX_AGE
      || state.envelope !== hash(envelope(payload)) || !closedTools(payload.input)
      || !Number.isSafeInteger(state.prefixLength) || state.prefixLength < 1 || state.prefixLength > payload.input.length
      || state.prefix !== hash(payload.input.slice(0, state.prefixLength))
      || !Array.isArray(state.items) || !state.items.length || state.digest !== hash(state.items)
      || Buffer.byteLength(JSON.stringify(state.items), 'utf8') > MAX_BYTES) return undefined
    const expectedRetained = payload.input.slice(0, state.prefixLength).filter(entry => retainedRole.has(entry?.role))
    if (hash(state.items.slice(0, -1)) !== hash(expectedRetained)) return undefined
    const item = state.items.at(-1)
    if (item?.type !== 'compaction' || typeof item.encrypted_content !== 'string' || !item.encrypted_content.trim()) return undefined
    const { previous_response_id: _previous, context_management: _inline, ...rest } = payload
    return clone({ ...rest, input: [...state.items, ...payload.input.slice(state.prefixLength)] })
  } catch { return undefined }
}
