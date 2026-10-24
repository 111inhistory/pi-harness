import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '/code/pi-harness/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {AssistantMessageEventStream} from '/code/pi-harness/node_modules/@earendil-works/pi-ai/dist/index.js';
for(const mode of ['native_one_at_a_time','turn_end_batch','turn_end_draft']) {
const cwd=await mkdtemp(path.join(os.tmpdir(),'pi-delivery-probe-'));
let session;
try {
 const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth.json'),modelsPath:null,refreshOnCreate:false});
 const model=runtime.getModel('openai-codex','gpt-6.1-sol');
 runtime.getAuth=async()=>({auth:{apiKey:'offline-only'},env:{}});runtime.hasConfiguredAuth=()=>true;
 const requests=[],events=[],pending=[];let piApi,releaseTool,toolEntered,contextCalls=0,modelCalls=0,idleEnded;
 const entered=new Promise(resolve=>toolEntered=resolve);
 const gate=new Promise(resolve=>releaseTool=resolve);
 runtime.streamSimple=(_model,context)=>{
  requests.push(context.messages.map(m=>({role:m.role,customType:m.customType,content:m.content})));
  const first=modelCalls++===0;
  const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:first?[{type:'toolCall',id:'gate-call',name:'gate',arguments:{}}]:[{type:'text',text:'done'}],stopReason:first?'toolUse':'stop',timestamp:Date.now(),usage:{input:1,output:1,totalTokens:2,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}}};
  const stream=new AssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;
 };
 const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false},cacheWarming:{mode:'off'}});
 const resourceLoader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[{name:'delivery-probe',factory(pi){
  piApi=pi;
  pi.registerTool({name:'gate',label:'Gate',description:'Offline synchronization gate',parameters:{type:'object',properties:{}},execute:async()=>{events.push('tool_enter');toolEntered();await gate;events.push('tool_exit');return {content:[{type:'text',text:'gate released'}]};}});
  pi.on('context',()=>{contextCalls++;events.push('context');});
  pi.on('turn_end',event=>{if(mode!=='native_one_at_a_time'&&pending.length){const batch=pending.splice(0).join('\n');events.push('batch_queued_at_turn_end');if(mode==='turn_end_draft')return {entries:[...event.entries,{type:'custom_message',customType:'subagent-test',content:batch,display:true}],continue:true};pi.sendMessage({customType:'subagent-test',content:batch,display:true},{triggerTurn:true,deliverAs:'steer'});}});
  pi.on('agent_start',()=>events.push('agent_start'));
  pi.on('agent_end',()=>events.push('agent_end'));
  pi.on('agent_settled',()=>{events.push('agent_settled');idleEnded?.();});
 }}]});
 await resourceLoader.reload();
 ({session}=await createAgentSession({cwd,agentDir:cwd,modelRuntime:runtime,model,sessionManager:SessionManager.inMemory(cwd),resourceLoader,settingsManager}));
 const errors=[];await session.bindExtensions({onError:e=>errors.push(String(e.error??e.message??e))});session.setActiveToolsByName(['gate']);
 const running=session.prompt('Start gate');await entered;
 const busyContexts=contextCalls,busyModels=modelCalls;
 const messageReturn=mode!=='native_one_at_a_time'?(pending.push('CHILD_PROGRESS'),undefined):piApi.sendMessage({customType:'subagent-test',content:'CHILD_PROGRESS',display:true},{triggerTurn:true,deliverAs:'steer'});
 const terminalReturn=mode!=='native_one_at_a_time'?(pending.push('CHILD_COMPLETED'),undefined):piApi.sendMessage({customType:'subagent-test',content:'CHILD_COMPLETED',display:true},{triggerTurn:true,deliverAs:'steer'});
 events.push('notifications_queued');releaseTool();await running;
 console.log(JSON.stringify({scenario:'busy_parent',mode,busyContexts,busyModels,messageReturnUndefined:messageReturn===undefined,terminalReturnUndefined:terminalReturn===undefined,modelCalls,contextCalls,events:[...events],notificationsPerRequest:requests.map(ms=>ms.filter(m=>JSON.stringify(m.content).includes('CHILD_')).map(m=>m.content)),persistedNotifications:session.sessionManager.getBranch().filter(e=>e.type==='custom_message').map(e=>({type:e.type,customType:e.customType,content:e.content})),errors}));
 const ended=new Promise(resolve=>idleEnded=resolve);const beforeIdle=modelCalls;
 piApi.sendMessage({customType:'subagent-test',content:'IDLE_COMPLETION',display:true},{triggerTurn:true,deliverAs:'steer'});await ended;
 console.log(JSON.stringify({scenario:'idle_parent_wakeup',mode,additionalModelCalls:modelCalls-beforeIdle,lastRequestNotifications:requests.at(-1).filter(m=>JSON.stringify(m.content).includes('CHILD_')||JSON.stringify(m.content).includes('IDLE_COMPLETION')).map(m=>m.content),events:[...events],errors}));
} finally {await session?.waitForIdle();session?.dispose();await rm(cwd,{recursive:true,force:true});}
}
