// No application boot, model calls, config writes or real sessions.
import assert from 'node:assert/strict'
import { nativeCompactionRouting, nativeCompactionEligible } from '../../src/native-compaction-routing.js'
export async function probeHostRouting(root) {
  const { Context } = await import(new URL('@deepseek-ai/cordis/lib/index.js', root))
  const { BasicCompactionEngine } = await import(new URL('@deepseek-ai/dsh-compaction-basic/lib/index.js', root))
  const { CONTEXT_WINDOW_EXCEEDED_CODE } = await import(new URL('@deepseek-ai/dsh-llm/lib/index.js', root))
  const ctx = new Context()
  let measured=0, proceeded=0, enabled=true, provider='openai-codex', maintenance=0
  const warnings=[]
  ctx.provide('llm',{resolveModelInfo:async()=>({context:{contextWindow:200000},defaultMaxTokens:4096})})
  ctx.provide('tokenMeter',{measure:()=>{measured++;return {totalTokens:0,nodes:[]}}})
  ctx.provide('sessions',{flush:async()=>{}})
  ctx.provide('logger',{info(){},warn(m){warnings.push(m)}})
  const Engine=nativeCompactionRouting(BasicCompactionEngine,()=>enabled)
  const engine=new Engine(ctx,{headroomTokens:0,retainTokens:0,maxTokens:1024})
  const agent={ options:{}, session:{log:[],surface:{nodes:[],replaceGeneration:0},requestHeader:()=>provider ? {config:{provider,model:'fixture'}} : undefined},
    runMaintenance:fn=>{maintenance++;return fn(new AbortController().signal)} }
  const signal=new AbortController().signal
  const step=()=>ctx.waterfall('agent/pre-step',{agent,signal},()=>{proceeded++})
  await step(); assert.equal(measured,0); assert.equal(proceeded,1)
  const overflow=await ctx.waterfall('agent/request-error',{agent,signal,failure:{code:CONTEXT_WINDOW_EXCEEDED_CODE}},()=> 'original-error')
  assert.equal(overflow,'original-error'); assert.equal(measured,0)
  provider='other'; await step(); assert.equal(measured,1)
  provider='openai-codex'; enabled=false; await step(); assert.equal(measured,2)
  enabled=true
  assert.equal(await engine.compactNow(agent,signal),null)
  assert.equal(measured,3); assert.equal(maintenance,1)
  assert.equal(Engine.prototype.compactNow,BasicCompactionEngine.prototype.compactNow)
  assert.throws(()=>new BasicCompactionEngine(ctx),/registered/)
  await step(); assert.equal(proceeded,4); assert.equal(measured,3)
  provider=undefined; await step(); assert.equal(measured,3)
  const abort=AbortSignal.abort(new Error('fixture cancellation'))
  await assert.rejects(engine.compactIfNeeded(agent,'pressure',abort),/fixture cancellation/)
  for(const purpose of ['compaction','session-title']) assert.equal(nativeCompactionEligible({provider:'openai-codex',purpose},true),false)
  assert.equal(warnings.length,0)
  return {passed:true,checks:['codex-pressure-bypass','codex-overflow-no-retry','other-provider-delegation','disabled-native-delegation','manual-entry-retained','duplicate-service-refused','single-hook','unknown-route-no-op','cancelled-before-work','purpose-tagged-side-request-bypass'],
    limitations:['manual entry tested with an empty synthetic surface, not a persisted summary','route follows last committed header; next-model switch is not pre-resolved','no production startup replacement installed']}
}
