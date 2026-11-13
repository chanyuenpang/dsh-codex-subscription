// Explicit opt-in; at most one compact + two continuation calls, synthetic text only.
// No credential refresh, no DSH config/session writes, no model tool execution.
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { requestNativeCompaction } from '../../src/native-compaction-request.js'
import { captureNativeCheckpoint, replayNativeCheckpoint } from '../../src/native-compaction-state.js'
import { withCodexNetwork, resolveCodexOAuthProxy } from '../../src/oauth-network.js'
const args = process.argv.slice(2)
const value = flag => args[args.indexOf(flag) + 1]
let stage = 'admission', statuses = []
try {
  if (!args.includes('--live') || !args.includes('--runtime-root')) throw Error('Explicit live and runtime root flags required')
  const runtime = path.resolve(value('--runtime-root'))
  const { openaiCodexProvider } = await import(pathToFileURL(path.join(runtime, '@earendil-works/pi-ai/dist/providers/openai-codex.js')))
  const ws = await import(pathToFileURL(path.join(runtime, '@earendil-works/pi-ai/dist/api/openai-codex-responses.js')))
  const provider = openaiCodexProvider(), model = provider.getModels().find(m => m.id === 'gpt-5.6-luna')
  if (!model) throw Error('Audited model unavailable')
  // Consume the existing official Codex login, like the other isolated experiments.
  // Do not print, copy, refresh or modify authentication material.
  const authPath = path.join(process.env.USERPROFILE ?? process.env.HOME, '.codex', 'auth.json')
  const auth = JSON.parse(await fs.readFile(authPath, 'utf8')).tokens
  if (!auth?.access_token) throw Error('Existing OAuth login required')
  const token = JSON.parse(Buffer.from(auth.access_token.split('.')[1], 'base64url'))
  const account = token['https://api.openai.com/auth']?.chatgpt_account_id
  if (!account || !Number.isFinite(token.exp) || token.exp * 1000 <= Date.now() + 180000) throw Error('Fresh existing login required; refresh is intentionally disabled')
  const apiKey = auth.access_token
  const marker = 'NATIVE-' + '734109'
  const emptyUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  const session = args.includes('--restore') ? undefined : 'native-validation-' + randomUUID()
  const options = { apiKey, reasoningEffort: 'low', maxRetries: 0, onResponse: info => { if (Number.isInteger(info?.status)) statuses.push(info.status) } }
  const assistant = text => ({ role: 'assistant', api: model.api, provider: 'openai-codex', model: model.id, content: [{ type: 'text', text }], usage: emptyUsage, stopReason: 'stop', timestamp: 1 })
  if (!args.includes('--restore')) {
    const context = { systemPrompt: 'This is a synthetic continuity test. Preserve exact recorded markers. Never call tools.', messages: [
      { role: 'user', content: 'Keep the exact marker recorded by the assistant for later recall.', timestamp: 1 },
      assistant('Synthetic history. '.repeat(120) + ' The recorded marker is ' + marker + '. ' + 'Synthetic history. '.repeat(120)),
      { role: 'user', content: 'Continue to retain that marker. No action is needed yet.', timestamp: 1 },
    ] }
    await fs.mkdir(path.resolve('.artifacts'), { recursive: true })
    stage = 'native-compaction'
    const result = await requestNativeCompaction({ provider, model, context, options: { ...options, signal: AbortSignal.timeout(90000) } })
    const scope = { account, model: model.id, session }
    const state = captureNativeCheckpoint({ result, scope })
    assert.equal(JSON.stringify(state.items.filter(i => i.type !== 'compaction')).includes(marker), false)
    const fixture = path.resolve('.artifacts', 'native-compaction-live-' + randomUUID())
    await fs.mkdir(fixture, { recursive: false })
    await fs.writeFile(path.join(fixture, 'synthetic-checkpoint.json'), JSON.stringify({ state, context, session, marker }), { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ stage, passed: true, checkpointBytes: Buffer.byteLength(JSON.stringify(result.item)), usage: result.usage, sdk: 'host', model: model.id, statuses }))
    console.log(JSON.stringify({ stage: 'checkpoint-saved', passed: true, logicalRequests: 1, fixture }))
    // Invoke --restore in a genuinely separate process; a GUI executable's exit
    // code is not proof that its child script ran. Require the restore evidence.
    if (!args.includes('--capture-only')) {
      stage = 'fresh-process-continuation'
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--live', '--runtime-root', runtime, '--restore', fixture], { stdio: 'inherit', env: process.env })
      assert.equal(child.status, 0, 'Fresh-process continuation did not pass')
      const receipt = JSON.parse(await fs.readFile(path.join(fixture, 'restore-receipt.json'), 'utf8'))
      assert.equal(receipt.passed, true)
      console.log(JSON.stringify({ stage: 'complete', passed: true, logicalRequests: 3, fixture }))
    }
  } else {
    const fixture = path.resolve(value('--restore'))
    const stored = JSON.parse(await fs.readFile(path.join(fixture, 'synthetic-checkpoint.json'), 'utf8'))
    const scope = { account, model: model.id, session: stored.session }
    const context = stored.context
    context.messages.push({ role: 'user', content: 'Return only the exact recorded marker, with no explanation.', timestamp: 2 })
    const proxy = await resolveCodexOAuthProxy({ target: new URL('https://chatgpt.com/') })
    let rewrites = 0
    const normal = async () => {
      let completed
      await withCodexNetwork(async () => {
        for await (const event of provider.streamSimple(model, context, { ...options, transport: 'websocket-cached', sessionId: stored.session, env: {}, websocketConnectTimeoutMs: 10000, signal: AbortSignal.timeout(60000), onPayload: body => {
          const replay = replayNativeCheckpoint(body, stored.state, scope)
          assert.ok(replay, 'Persisted checkpoint did not match the original history')
          if (rewrites === 0) assert.equal(JSON.stringify(replay.input.filter(i => i.type !== 'compaction')).includes(stored.marker), false)
          rewrites++; return replay
        } })) {
          if (event.type === 'error') throw Error('Continuation failed')
          if (event.type === 'done') completed = event.message
        }
      }, { websocket: true, websocketProxy: proxy })
      assert.ok(completed)
      assert.equal(completed.content.some(b => b.type === 'toolCall'), false)
      assert.equal(completed.content.filter(b => b.type === 'text').map(b => b.text).join('').trim(), stored.marker)
      return completed
    }
    try {
      stage = 'restored-continuation'
      const first = await normal()
      console.log(JSON.stringify({ stage, passed: true, markerRecalled: true, usage: first.usage, transport: ws.getOpenAICodexWebSocketDebugStats(stored.session) }))
      context.messages.push(first, { role: 'user', content: 'Repeat the same marker only.', timestamp: 3 })
      stage = 'websocket-continuation'
      await normal()
      console.log(JSON.stringify({ stage, passed: true, rewrites, transport: ws.getOpenAICodexWebSocketDebugStats(stored.session) }))
      await fs.writeFile(path.join(fixture, 'restore-receipt.json'), JSON.stringify({ passed: true, rewrites }), { flag: 'wx' })
    } finally { ws.closeOpenAICodexWebSocketSessions(stored.session) }
  }
} catch (error) {
  // Intentional allowlist: never print tokens, encrypted state, response bodies or stacks.
  console.log(JSON.stringify({ stage, passed: false, code: error?.code ?? error?.name ?? 'FAILED', statuses }))
  process.exitCode = 1
}
