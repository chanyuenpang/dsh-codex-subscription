/**
 * Optional startup replacement, never a second service or a live instance patch.
 * Takes the host's exact Basic class to preserve Cordis/Session private identity.
 * Routing follows the host's last committed header, NOT a guessed next model.
 */
export function nativeCompactionRouting(BasicCompactionEngine, enabled) {
  return class NativeRoutedCompaction extends BasicCompactionEngine {
    async compactIfNeeded(agent, trigger, signal) {
      signal?.throwIfAborted()
      if (enabled() && agent.session.requestHeader()?.config.provider === 'openai-codex') return null
      return super.compactIfNeeded(agent, trigger, signal)
    }
  }
}

/** Explicitly purpose-tagged maintenance requests bypass native compaction. */
export function nativeCompactionEligible(options, enabled) {
  return enabled && options?.provider === 'openai-codex' && options.purpose === undefined
}
