// Offline investigation fixture. Absolute paths record the original Pi 1.4.0 environment.
// Host guards below are candidate policies, not the project's production implementation.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '/code/pi-harness/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {AssistantMessageEventStream} from '/code/pi-harness/node_modules/@earendil-works/pi-ai/dist/index.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function fixture(options,run){
 const cwd=await mkdtemp(path.join(os.tmpdir(),'pi-boundary-probe-'));
 const state={pending:[],requests:[],boundaries:[],settled:[],errors:[],active:true,allowWake:true,generation:1,toolEntered:deferred(),toolRelease:deferred(),boundaryEntered:deferred(),boundaryRelease:deferred()};
 let session;
 try{
  const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth.json'),modelsPath:null,refreshOnCreate:false});
  const model=runtime.getModel('openai-codex','gpt-6.1-sol');
  runtime.getAuth=async()=>({auth:{apiKey:'offline-only'},env:{}});runtime.hasConfiguredAuth=()=>true;
  runtime.streamSimple=(_model,context,streamOptions)=>{
   const call=state.requests.length+1;
   state.requests.push({call,aborted:!!streamOptions.signal?.aborted,notifications:context.messages.filter(m=>JSON.stringify(m.content).includes('CHILD_')).map(m=>m.content)});
   if(call===1&&options.seed)state.pending.push('CHILD_PROGRESS','CHILD_COMPLETED');
   if(call===2&&options.late)state.pending.push('CHILD_LATE');
   const stopReason=streamOptions.signal?.aborted?'aborted':call===1&&options.tool?'toolUse':'stop';
   const content=stopReason==='aborted'?[]:stopReason==='toolUse'?[{type:'toolCall',id:'gate-call',name:'gate',arguments:{}}]:[{type:'text',text:'done'}];
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,stopReason,timestamp:Date.now(),usage:{input:1,output:1,totalTokens:2,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}}};
   const stream=new AssistantMessageEventStream();stream.push({type:stopReason==='aborted'?'error':'done',reason:stopReason,message});stream.end();return stream;
  };
  const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false},cacheWarming:{mode:'off'}});
  const resourceLoader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[{name:'boundary-probe',factory(pi){
   state.pi=pi;
   pi.registerTool({name:'gate',label:'Gate',description:'Offline synchronization gate',parameters:{type:'object',properties:{}},execute:async(_id,_args,signal)=>{
    state.toolEntered.resolve();
    if(!signal.aborted)await new Promise(resolve=>{
     const aborted=()=>resolve();signal.addEventListener('abort',aborted,{once:true});
     state.toolRelease.promise.then(()=>{signal.removeEventListener('abort',aborted);resolve();});
    });
    return {content:[{type:'text',text:signal.aborted?'tool aborted':'tool released'}]};
   }});
   pi.on('turn_end',async event=>{
    state.boundaries.push({outcome:event.outcome,preCanContinue:event.context.canContinue,allowWake:state.allowWake,active:state.active,pending:state.pending.length});
    if(!state.pending.length||!state.active||!state.allowWake)return;
    const generation=state.generation;
    if(options.pauseBoundary&&!state.paused){state.paused=true;state.boundaryEntered.resolve();await state.boundaryRelease.promise;}
    if(options.guardAfterAwait&&(!state.active||!state.allowWake||state.generation!==generation))return;
    const content=state.pending.splice(0).join('\n');
    return {entries:[...event.entries,{type:'custom_message',customType:'subagent-boundary-test',content,display:true}],continue:options.usePrePreview?event.context.canContinue:true};
   });
   if(options.replaceDrafts)pi.on('turn_end',()=>({entries:[],continue:false}));
   pi.on('agent_settled',event=>state.settled.push({aborted:event.aborted}));
  }}]});
  await resourceLoader.reload();
  ({session}=await createAgentSession({cwd,agentDir:cwd,modelRuntime:runtime,model,sessionManager:SessionManager.inMemory(cwd),resourceLoader,settingsManager}));
  await session.bindExtensions({onError:e=>state.errors.push(String(e.error??e.message??e))});session.setActiveToolsByName(['gate']);
  state.session=session;
  state.persisted=()=>session.sessionManager.getBranch().filter(e=>e.type==='custom_message'&&e.customType==='subagent-boundary-test').map(e=>e.content);
  await run(state);
 }finally{await session?.waitForIdle();session?.dispose();await rm(cwd,{recursive:true,force:true});}
}
for(const usePrePreview of [true,false])await fixture({seed:true,usePrePreview},async s=>{
 await s.session.prompt('Reply without tools');
 assert.equal(s.boundaries[0].preCanContinue,false);assert.equal(s.persisted().length,1);assert.equal(s.requests.length,usePrePreview?1:2);assert.deepEqual(s.errors,[]);
 console.log(JSON.stringify({scenario:'final_assistant_draft',policy:usePrePreview?'copy_pre_draft_canContinue':'request_continue_for_new_draft',requests:s.requests,boundaries:s.boundaries,persisted:s.persisted(),errors:s.errors}));
});
await fixture({seed:true,late:true},async s=>{
 await s.session.prompt('Deliver staged notification');
 assert.equal(s.requests.length,3);assert.deepEqual(s.persisted(),['CHILD_PROGRESS\nCHILD_COMPLETED','CHILD_LATE']);assert.deepEqual(s.errors,[]);
 console.log(JSON.stringify({scenario:'event_after_first_batch',requests:s.requests,boundaries:s.boundaries,persisted:s.persisted(),errors:s.errors}));
});
await fixture({tool:true},async s=>{
 const running=s.session.prompt('Run gate');await s.toolEntered.promise;
 s.pending.push('CHILD_PROGRESS','CHILD_COMPLETED');s.allowWake=false;
 const aborted=s.session.abort();await Promise.all([aborted,running]);
 assert.equal(s.persisted().length,0);assert.equal(s.pending.length,2);assert.equal(s.settled.at(-1).aborted,true);assert.deepEqual(s.errors,[]);
 console.log(JSON.stringify({scenario:'explicit_cancel_host_guard',requests:s.requests,boundaries:s.boundaries,settled:s.settled,pending:s.pending,persisted:s.persisted(),errors:s.errors}));
});
await fixture({seed:true,replaceDrafts:true},async s=>{
 await s.session.prompt('Later handler replaces the draft');
 assert.equal(s.requests.length,1);assert.equal(s.persisted().length,0);assert.equal(s.pending.length,0);assert.deepEqual(s.errors,[]);
 console.log(JSON.stringify({scenario:'later_handler_replaces_proposal',requests:s.requests,boundaries:s.boundaries,pending:s.pending,persisted:s.persisted(),errors:s.errors}));
});
for(const guardAfterAwait of [false,true])await fixture({seed:true,pauseBoundary:true,guardAfterAwait},async s=>{
 const running=s.session.prompt('Pause before committing notification');await s.boundaryEntered.promise;
 s.active=false;s.generation++;s.boundaryRelease.resolve();await running;
 assert.equal(s.persisted().length,guardAfterAwait?0:1);assert.equal(s.pending.length,guardAfterAwait?2:0);assert.deepEqual(s.errors,[]);
 console.log(JSON.stringify({scenario:'retirement_during_boundary_await',guardAfterAwait,requests:s.requests,boundaries:s.boundaries,pending:s.pending,persisted:s.persisted(),errors:s.errors}));
});
for(const guardAfterAwait of [false,true])await fixture({seed:true,pauseBoundary:true,guardAfterAwait},async s=>{
 const running=s.session.prompt('Pause before cancelling notification');await s.boundaryEntered.promise;
 s.allowWake=false;const aborting=s.session.abort();s.boundaryRelease.resolve();await Promise.all([running,aborting]);
 assert.equal(s.persisted().length,guardAfterAwait?0:1);assert.equal(s.pending.length,guardAfterAwait?2:0);assert.equal(s.settled.at(-1).aborted,true);assert.deepEqual(s.errors,[]);
 console.log(JSON.stringify({scenario:'cancel_during_boundary_await',guardAfterAwait,requests:s.requests,boundaries:s.boundaries,settled:s.settled,pending:s.pending,persisted:s.persisted(),errors:s.errors}));
});
for(const guard of ['none','cancel','retire'])await fixture({},async s=>{
 await s.session.prompt('Become idle');const before=s.requests.length;
 let scheduled=false,dispatches=0;
 const schedule=()=>{
  if(scheduled)return;scheduled=true;const generation=s.generation;
  queueMicrotask(()=>{
   scheduled=false;
   if(!s.active||!s.allowWake||s.generation!==generation||!s.session.isIdle||!s.pending.length)return;
   dispatches++;const content=s.pending.splice(0).join('\n');
   s.pi.sendMessage({customType:'subagent-boundary-test',content,display:true},{triggerTurn:true,deliverAs:'steer'});
  });
 };
 s.pending.push('CHILD_PROGRESS');schedule();s.pending.push('CHILD_COMPLETED');schedule();
 if(guard==='cancel')s.allowWake=false;if(guard==='retire'){s.active=false;s.generation++;}
 await new Promise(resolve=>queueMicrotask(resolve));await s.session.waitForIdle();
 assert.equal(dispatches,guard==='none'?1:0);assert.equal(s.requests.length-before,guard==='none'?1:0);assert.equal(s.pending.length,guard==='none'?0:2);assert.deepEqual(s.errors,[]);
 console.log(JSON.stringify({scenario:'coalesced_idle_wake',guard,dispatches,requests:s.requests,pending:s.pending,persisted:s.persisted(),errors:s.errors}));
});
