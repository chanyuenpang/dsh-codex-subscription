import assert from 'node:assert/strict'
import { captureNativeCheckpoint, replayNativeCheckpoint } from '../../src/native-compaction-state.js'
export async function probeSocketContinuation(provider, api) {
  const originalSocket=globalThis.WebSocket, originalFetch=globalThis.fetch
  const sent=[]; let connections=0,fetches=0
  class FixtureSocket extends EventTarget {
    readyState=1
    constructor() { super(); connections++; queueMicrotask(()=>this.dispatchEvent(new Event('open'))) }
    send(body) {
      sent.push(JSON.parse(body)); const n=sent.length
      const item={type:'message',id:'msg_fixture_'+n,role:'assistant',content:[{type:'output_text',text:'reply-'+n,annotations:[]}]}
      queueMicrotask(()=>{
        for(const event of [
          {type:'response.created',response:{id:'resp_fixture_'+n}},
          {type:'response.output_item.added',output_index:0,item:{...item,content:[]}},
          {type:'response.content_part.added',output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
          {type:'response.output_text.delta',output_index:0,content_index:0,delta:'reply-'+n},
          {type:'response.output_item.done',output_index:0,item},
          {type:'response.completed',response:{id:'resp_fixture_'+n,status:'completed',output:[item],usage:{input_tokens:10,output_tokens:2,total_tokens:12}}},
        ]) this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(event)}))
      })
    }
    close(code=1000,reason='fixture cleanup') {
      if(this.readyState===3)return
      this.readyState=3;this.dispatchEvent(Object.assign(new Event('close'),{code,reason,wasClean:true}))
    }
  }
  globalThis.WebSocket=FixtureSocket
  globalThis.fetch=async()=>{fetches++;throw Error('No network permitted in this probe')}
  const model=provider.getModels()[0],sessionId='native-socket-fixture'
  const apiKey='e30.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}})).toString('base64url')+'.fixture'
  const scope={account:'fixture',model:model.id,session:sessionId}
  const context={messages:[{role:'user',content:'Keep earlier context',timestamp:1},{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'Large synthetic assistant history'}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:1}]}
  let original,state
  const run=async()=>{
    let done
    for await(const event of provider.streamSimple(model,context,{apiKey,transport:'websocket-cached',sessionId,env:{},maxRetries:0,signal:AbortSignal.timeout(3000),onPayload:body=>{
      original??=structuredClone(body)
      if(!state)return body
      const replay=replayNativeCheckpoint(body,state,scope)
      assert.ok(replay);return replay
    }})){
      if(event.type==='error')throw Error('Mock socket probe failed: '+event.error?.errorMessage)
      if(event.type==='done')done=event.message
    }
    assert.ok(done);context.messages.push(done)
  }
  try {
    await run()
    state=captureNativeCheckpoint({result:{payload:original,responseId:'compact_fixture',item:{type:'compaction',encrypted_content:'SYNTHETIC_ONLY'}},scope})
    context.messages.push({role:'user',content:'Second turn',timestamp:2})
    await run()
    context.messages.push({role:'user',content:'Third turn',timestamp:3})
    await run()
    assert.equal(sent.length,3);assert.equal(connections,1);assert.equal(fetches,0)
    assert.equal(sent[0].previous_response_id,undefined)
    assert.equal(sent[1].previous_response_id,undefined,'compaction invalidates old continuation baseline')
    assert.ok(sent[1].input.some(i=>i.type==='compaction'))
    assert.equal(sent[2].previous_response_id,'resp_fixture_2')
    assert.equal(sent[2].input.length,1,'unchanged compacted prefix permits delta again')
    return {passed:true,requests:sent.length,connections,fetches,fullAfterCompaction:true,deltaAfterStablePrefix:true}
  } finally {
    api.closeOpenAICodexWebSocketSessions(sessionId)
    globalThis.WebSocket=originalSocket;globalThis.fetch=originalFetch
  }
}
