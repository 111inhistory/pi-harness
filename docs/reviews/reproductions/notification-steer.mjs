// Offline Pi 1.4.0 probe: current notification shape through native custom-message steering.
// Does not load or modify the production Subagent extension; its formatting is reproduced below.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '/code/pi-harness/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {AssistantMessageEventStream} from '/code/pi-harness/node_modules/@earendil-works/pi-ai/dist/index.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const cwd=await mkdtemp(path.join(os.tmpdir(),'pi-notification-steer-'));
let session;
try{
 const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth.json'),modelsPath:null,refreshOnCreate:false});
 const model=runtime.getModel('openai-codex','gpt-6.1-sol');
 runtime.getAuth=async()=>({auth:{apiKey:'offline-only'},env:{}});runtime.hasConfiguredAuth=()=>true;
 let piApi,phase='busy',gate={entered:deferred(),release:deferred()},settledWaiter;
 const issued=new Set(),requests=[],errors=[];
 const usage={input:1,output:1,totalTokens:2,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}};
 runtime.streamSimple=(_model,context,options)=>{
  requests.push({phase,aborted:!!options.signal?.aborted,messages:structuredClone(context.messages)});
  const tool=!options.signal?.aborted&&['busy','abort'].includes(phase)&&!issued.has(phase);if(tool)issued.add(phase);
  const stopReason=options.signal?.aborted?'aborted':tool?'toolUse':'stop';
  const content=stopReason==='aborted'?[]:tool?[{type:'toolCall',id:`gate-${phase}`,name:'gate',arguments:{}}]:[{type:'text',text:'done'}];
  const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,stopReason,timestamp:Date.now(),usage};
  const stream=new AssistantMessageEventStream();stream.push({type:stopReason==='aborted'?'error':'done',reason:stopReason,message});stream.end();return stream;
 };
 const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false},cacheWarming:{mode:'off'}});
 const resourceLoader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[{name:'notification-steer-probe',factory(pi){
  piApi=pi;
  pi.registerTool({name:'gate',label:'Gate',description:'Offline synchronization gate',parameters:{type:'object',properties:{}},execute:async(_id,_args,signal)=>{
   const current=gate;current.entered.resolve();
   if(!signal.aborted)await new Promise(resolve=>{const onAbort=()=>resolve();signal.addEventListener('abort',onAbort,{once:true});current.release.promise.then(()=>{signal.removeEventListener('abort',onAbort);resolve();});});
   return {content:[{type:'text',text:signal.aborted?'aborted':'released'}]};
  }});
  pi.on('agent_settled',()=>settledWaiter?.resolve());
 }}]});
 await resourceLoader.reload();
 ({session}=await createAgentSession({cwd,agentDir:cwd,modelRuntime:runtime,model,sessionManager:SessionManager.inMemory(cwd),resourceLoader,settingsManager}));
 await session.bindExtensions({onError:e=>errors.push(String(e.error??e.message??e))});session.setActiveToolsByName(['gate']);
 const makeEntry=(id,status)=>{
  const notification={type:'notification',subagentId:id,status,content:`fixture ${status}`,history:{summary:`/fixture/${id}/summary.md`,cleanJsonl:`/fixture/${id}/session.jsonl`}};
  return {customType:'agent-completion',content:`[Subagent ${id} ${status}]: ${notification.content}`,display:true,details:notification};
 };
 const entries=()=>session.sessionManager.getBranch().filter(e=>e.type==='custom_message'&&e.customType==='agent-completion');
 const assertPreserved=(entry,index)=>{
  const actual=entries()[index];assert.ok(actual);assert.equal(actual.content,entry.content);assert.deepEqual(actual.details,entry.details);assert.equal(actual.display,true);
  assert.ok(requests.some(r=>!r.aborted&&r.messages.some(m=>JSON.stringify(m.content).includes(entry.content))));
 };
 const busyEntry=makeEntry('sub_busy','completed');
 const running=session.prompt('Run a tool');await gate.entered.promise;
 const busyCount=requests.length;piApi.sendMessage(busyEntry,{triggerTurn:true,deliverAs:'steer'});gate.release.resolve();await running;await session.waitForIdle();
 assert.equal(requests.length-busyCount,1);assertPreserved(busyEntry,0);
 console.log(JSON.stringify({scenario:'typed_notification_during_tool',additionalRequests:requests.length-busyCount,customType:entries()[0].customType,detailsPreserved:true,historyEntries:entries().length,errors}));
 phase='idle';const idleEntry=makeEntry('sub_idle','failed');const idleCount=requests.length;settledWaiter=deferred();
 piApi.sendMessage(idleEntry,{triggerTurn:true,deliverAs:'steer'});await settledWaiter.promise;await session.waitForIdle();
 assert.equal(requests.length-idleCount,1);assertPreserved(idleEntry,1);
 console.log(JSON.stringify({scenario:'typed_notification_while_idle',additionalRequests:requests.length-idleCount,customType:entries()[1].customType,detailsPreserved:true,historyEntries:entries().length,errors}));
 phase='abort';gate={entered:deferred(),release:deferred()};const interrupted=session.prompt('Interrupt this tool');await gate.entered.promise;await Promise.all([session.abort(),interrupted]);await session.waitForIdle();
 phase='after_abort';const resumedEntry=makeEntry('sub_after_abort','completed');const resumedCount=requests.length;settledWaiter=deferred();
 piApi.sendMessage(resumedEntry,{triggerTurn:true,deliverAs:'steer'});await settledWaiter.promise;await session.waitForIdle();
 assert.equal(requests.length-resumedCount,1);assertPreserved(resumedEntry,2);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({scenario:'typed_notification_after_abort_settled',additionalRequests:requests.length-resumedCount,detailsPreserved:true,historyEntries:entries().length,errors}));
}finally{await session?.waitForIdle();session?.dispose();await rm(cwd,{recursive:true,force:true});}
