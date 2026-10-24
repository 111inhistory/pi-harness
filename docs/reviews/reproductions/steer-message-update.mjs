// Pi 1.4.0: deterministic queue/update/history tests; no network or production extension edits.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '/code/pi-harness/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {AssistantMessageEventStream} from '/code/pi-harness/node_modules/@earendil-works/pi-ai/dist/index.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const PROGRESS='CHILD_PROGRESS',MERGED='CHILD_PROGRESS\nCHILD_COMPLETED';
async function probe(mode){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'pi-steer-update-'));
 let session;
 const gate={entered:deferred(),release:deferred()},start={entered:deferred(),release:deferred()},late={entered:deferred(),release:deferred()};
 const requests=[],errors=[],latest=new Map([['batch-1',{content:PROGRESS,status:'running'}]]);
 let piApi,settledWaiter,issued=false,historyBeforeUpdate,queueBeforeUpdate;
 try{
  const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth.json'),modelsPath:null,refreshOnCreate:false});
  const model=runtime.getModel('openai-codex','gpt-6.1-sol');
  runtime.getAuth=async()=>({auth:{apiKey:'offline-only'},env:{}});runtime.hasConfiguredAuth=()=>true;
  runtime.streamSimple=(_model,context)=>{
   requests.push(structuredClone(context.messages));const first=!issued;issued=true;
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:first?[{type:'toolCall',id:'gate-call',name:'gate',arguments:{}}]:[{type:'text',text:'done'}],stopReason:first?'toolUse':'stop',timestamp:Date.now(),usage:{input:1,output:1,totalTokens:2,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}}};
   const stream=new AssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;
  };
  const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false},cacheWarming:{mode:'off'}});
  const useHook=['message_end_while_queued','message_end_after_drain','message_end_preserves_other_messages','later_handler_await_gap','after_history_new_batch'].includes(mode);
  const resourceLoader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[{name:'steer-update-probe',factory(pi){
   piApi=pi;
   pi.registerTool({name:'gate',label:'Gate',description:'Offline synchronization gate',parameters:{type:'object',properties:{}},execute:async()=>{gate.entered.resolve();await gate.release.promise;return {content:[{type:'text',text:'released'}]};}});
   pi.on('message_start',async event=>{
    if(mode==='message_end_after_drain'&&event.message.role==='custom'&&event.message.details?.batchId==='batch-1'){start.entered.resolve();await start.release.promise;}
   });
   if(useHook)pi.on('message_end',event=>{
    const message=event.message;
    if(message.role!=='custom'||message.customType!=='agent-completion')return;
    const update=latest.get(message.details?.batchId);if(!update)return;
    return {message:{...message,content:update.content,details:{...message.details,status:update.status}}};
   });
   if(mode==='later_handler_await_gap')pi.on('message_end',async event=>{
    if(event.message.role==='custom'&&event.message.details?.batchId==='batch-1'){late.entered.resolve();await late.release.promise;}
   });
   pi.on('agent_settled',()=>settledWaiter?.resolve());
  }}]});
  await resourceLoader.reload();
  ({session}=await createAgentSession({cwd,agentDir:cwd,modelRuntime:runtime,model,sessionManager:SessionManager.create(cwd,path.join(cwd,'sessions')),resourceLoader,settingsManager}));
  await session.bindExtensions({onError:e=>errors.push(String(e.error??e.message??e))});session.setActiveToolsByName(['gate']);
  const customEntries=()=>session.sessionManager.getBranch().filter(e=>e.type==='custom_message'&&e.customType==='agent-completion');
  const queued=()=>session.agent.peekQueuedMessages().filter(m=>m.role==='custom'&&m.customType==='agent-completion');
  const original={customType:'agent-completion',content:PROGRESS,display:true,details:{batchId:'batch-1',subagentId:'sub_fixture',round:1,status:'running'}};
  const running=session.prompt('Run a gated tool');await gate.entered.promise;
  piApi.sendMessage(original,{triggerTurn:true,deliverAs:'steer'});
  assert.equal(customEntries().length,0);assert.equal(queued().length,1);
  if(mode==='mutate_original_payload'){
   original.content=MERGED;original.details={...original.details,status:'completed'};
  }else if(mode==='mutate_peeked_reference'){
   const target=queued()[0];target.content=MERGED;target.details={...target.details,status:'completed'};
  }else if(mode==='message_end_while_queued'||mode==='message_end_preserves_other_messages'){
   latest.set('batch-1',{content:MERGED,status:'completed'});
   assert.equal(queued()[0].content,PROGRESS);
  }
  if(mode==='message_end_preserves_other_messages')await session.steer('UNRELATED_USER_STEER');
  gate.release.resolve();
  if(mode==='message_end_after_drain'){
   await start.entered.promise;historyBeforeUpdate=customEntries().length;queueBeforeUpdate=queued().length;
   assert.equal(historyBeforeUpdate,0);assert.equal(queueBeforeUpdate,0);
   latest.set('batch-1',{content:MERGED,status:'completed'});start.release.resolve();
  }
  if(mode==='later_handler_await_gap'){
   await late.entered.promise;historyBeforeUpdate=customEntries().length;queueBeforeUpdate=queued().length;
   assert.equal(historyBeforeUpdate,0);latest.set('batch-1',{content:MERGED,status:'completed'});late.release.resolve();
  }
  await running;await session.waitForIdle();
  const expected=['mutate_original_payload','later_handler_await_gap','after_history_new_batch'].includes(mode)?PROGRESS:MERGED;
  assert.equal(customEntries().length,1);assert.equal(customEntries()[0].content,expected);
  const modelTexts=requests.flatMap(ms=>ms.map(m=>JSON.stringify(m.content)));
  assert.ok(modelTexts.some(t=>t.includes(expected.replaceAll('\n','\\n'))));
  if(mode==='message_end_preserves_other_messages'){
   assert.equal(session.sessionManager.getBranch().filter(e=>e.type==='message'&&e.message.role==='user'&&JSON.stringify(e.message.content).includes('UNRELATED_USER_STEER')).length,1);
   assert.ok(modelTexts.some(t=>t.includes('UNRELATED_USER_STEER')));
  }
  if(mode==='after_history_new_batch'){
   latest.set('batch-2',{content:'CHILD_COMPLETED',status:'completed'});settledWaiter=deferred();
   piApi.sendMessage({...original,details:{...original.details,batchId:'batch-2'}},{triggerTurn:true,deliverAs:'steer'});
   await settledWaiter.promise;await session.waitForIdle();
   assert.deepEqual(customEntries().map(e=>e.content),[PROGRESS,'CHILD_COMPLETED']);
  }
  const diskEntries=(await readFile(session.sessionManager.getSessionFile(),'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(e=>e.type==='custom_message'&&e.customType==='agent-completion');
  assert.deepEqual(diskEntries.map(e=>e.content),customEntries().map(e=>e.content));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({scenario:mode,historyBeforeUpdate,queueBeforeUpdate,modelCalls:requests.length,history:customEntries().map(e=>({content:e.content,status:e.details.status,batchId:e.details.batchId})),diskMatches:true,unrelatedMessagePreserved:mode==='message_end_preserves_other_messages'?true:undefined,errors}));
 }finally{
  gate.release.resolve();start.release.resolve();late.release.resolve();await session?.waitForIdle();session?.dispose();await rm(cwd,{recursive:true,force:true});
 }
}
for(const mode of ['mutate_original_payload','mutate_peeked_reference','message_end_while_queued','message_end_after_drain','message_end_preserves_other_messages','later_handler_await_gap','after_history_new_batch'])await probe(mode);
