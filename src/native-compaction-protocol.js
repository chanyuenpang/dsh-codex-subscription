// Codex remote compaction v2 is a dedicated Responses request, not inline
// context_management and not /responses/compact. This module owns only the wire
// contract. It never changes a DSH session or executes returned tools.
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const terminalTypes = new Set(['response.completed', 'response.done'])
const copy = value => JSON.parse(JSON.stringify(value))

export class NativeCompactionError extends Error {
  constructor(code, message) { super(message); this.name = 'NativeCompactionError'; this.code = code }
}
const reject = (code, message) => { throw new NativeCompactionError(code, message) }

/** Preserve the provider-built instructions/tools/history; ask only for compaction. */
export function nativeCompactionPayload(payload) {
  if (!payload || typeof payload.model !== 'string' || !payload.model || !Array.isArray(payload.input)) {
    reject('INVALID_REQUEST', 'Native compaction requires a model and complete input history')
  }
  if (payload.input.some(item => item?.type === 'compaction_trigger')) {
    reject('INVALID_REQUEST', 'Native compaction input already contains a trigger')
  }
  const { context_management: _inline, previous_response_id: _previous, ...rest } = payload
  return copy({ ...rest, store: false, stream: true, input: [...payload.input, { type: 'compaction_trigger' }] })
}

function checkpoint(item, maxBytes) {
  if (item?.type !== 'compaction' || typeof item.encrypted_content !== 'string' || !item.encrypted_content.trim()) {
    reject('INVALID_CHECKPOINT', 'Native compaction returned no usable encrypted checkpoint')
  }
  let encoded
  try { encoded = JSON.stringify(item) } catch { reject('INVALID_CHECKPOINT', 'Native compaction checkpoint is not JSON') }
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) reject('CHECKPOINT_TOO_LARGE', 'Native compaction checkpoint exceeds the storage limit')
  return JSON.parse(encoded)
}
function usageOf(value) {
  if (!value || typeof value !== 'object') return undefined
  const result = {}
  for (const name of ['input_tokens', 'output_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(value[name]) && value[name] >= 0) result[name] = value[name]
  }
  const cached = value.input_tokens_details?.cached_tokens
  if (Number.isSafeInteger(cached) && cached >= 0) result.input_tokens_details = { cached_tokens: cached }
  return Object.keys(result).length ? result : undefined
}

/**
 * Collect raw provider events before the generic text/tool parser discards opaque
 * items. finish() is called only after the transport itself settled successfully.
 * A delivered item alone is NOT a durable checkpoint. Error text and raw payloads
 * deliberately never enter exceptions, as they may contain encrypted state.
 */
export function createNativeCompactionCollector({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer')
  let item, terminal, failure, finished = false
  const poison = (code, message) => {
    failure ??= new NativeCompactionError(code, message)
    throw failure
  }
  const fail = error => { failure ??= error; throw failure }
  const inspectItem = candidate => {
    if (candidate?.type !== 'compaction') return poison('UNEXPECTED_OUTPUT', 'Native compaction returned ordinary model output')
    const next = checkpoint(candidate, maxBytes)
    if (item) return poison('DUPLICATE_CHECKPOINT', 'Native compaction returned multiple checkpoints')
    item = next
  }
  return {
    accept(event) {
      if (failure) throw failure
      if (finished || terminal) return poison('EVENT_AFTER_TERMINAL', 'Native compaction received an event after completion')
      try {
        if (event?.type === 'error' || ['response.failed', 'response.incomplete', 'response.cancelled'].includes(event?.type)) {
          return poison('COMPACTION_FAILED', 'Native compaction did not complete successfully')
        }
        if (event?.type === 'response.output_item.done') inspectItem(event.item)
        if (!terminalTypes.has(event?.type)) return
        const response = event.response
        if (response?.status !== 'completed' || typeof response.id !== 'string' || !response.id) {
          return poison('INVALID_TERMINAL', 'Native compaction has no successful response identity')
        }
        // The terminal output is authoritative. Some backends omit item-done;
        // others repeat that item here. Never accept conflicting checkpoints.
        if (response.output !== undefined) {
          if (!Array.isArray(response.output) || response.output.length !== 1) {
            return poison('INVALID_CHECKPOINT', 'Native compaction must return exactly one checkpoint')
          }
          const finalItem = checkpoint(response.output[0], maxBytes)
          if (item && (item.encrypted_content !== finalItem.encrypted_content || (item.id && finalItem.id && item.id !== finalItem.id))) {
            return poison('CHECKPOINT_MISMATCH', 'Native compaction checkpoint changed at completion')
          }
          item = finalItem
        }
        if (!item) return poison('INVALID_CHECKPOINT', 'Native compaction completed without a checkpoint')
        terminal = { responseId: response.id, usage: usageOf(response.usage) }
      } catch (error) { fail(error) }
    },
    finish(signal) {
      if (failure) throw failure
      if (signal?.aborted) {
        failure = signal.reason ?? new NativeCompactionError('ABORTED', 'Native compaction was cancelled')
        throw failure
      }
      if (finished) reject('ALREADY_FINISHED', 'Native compaction result was already consumed')
      if (!terminal || !item) poison('INCOMPLETE_STREAM', 'Native compaction stream ended before successful completion')
      finished = true
      return copy({ item, ...terminal })
    },
  }
}
