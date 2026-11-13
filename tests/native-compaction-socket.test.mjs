import test from 'node:test'
import { openaiCodexProvider } from '../src/pi-ai-runtime.js'
import * as api from '@earendil-works/pi-ai/api/openai-codex-responses'
import { probeSocketContinuation } from '../scripts/experiments/native-compaction-socket.mjs'
test('real SDK sends full compacted history then resumes delta on the same mock socket', async()=>{
  await probeSocketContinuation(openaiCodexProvider(),api)
})
