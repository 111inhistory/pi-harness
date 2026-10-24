import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '/code/pi-harness/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {AssistantMessageEventStream,getCurrentTools,getCurrentSystemMessage} from '/code/pi-harness/node_modules/@earendil-works/pi-ai/dist/index.js';
import capabilityExtension from '/code/pi-harness/extensions/capability.mjs';
import {stream as providerStream} from '/code/pi-harness/node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js';
for(const mode of ['direct','nested']) {
 const cwd=await mkdtemp(path.join(os.tmpdir(),'pi-compact-probe-'));
 let session;
 try {
  const runtime=await ModelRuntime.create({authPath:path.join(cwd,'auth.json'),modelsPath:null,refreshOnCreate:false});
  const model=runtime.getModel('openai-codex','gpt-6.1-sol');
  runtime.getAuth=async()=>({auth:{apiKey:'offline-only'},env:{}});
  runtime.hasConfiguredAuth=()=>true;
  let stage='discover',calls=0,executions=0,discoveries=0;
  const requests=[], contexts=[];
  runtime.streamSimple=(_model,context)=>{
   const messages=structuredClone(context.messages);
   contexts.push({stage,messages});
   requests.push({stage,tools:getCurrentTools(messages).map(t=>t.name),memory:getCurrentSystemMessage(messages)?.sections?.capabilities??null});
   let content,stopReason='stop';
   if(stage==='discover'&&calls++===0){content=[{type:'toolCall',id:'discover-call',name:mode==='direct'?'capability':'via_nested',arguments:{}}];stopReason='toolUse';}
   else if(stage==='probe'&&!messages.some(m=>m.role==='toolResult'&&m.toolCallId==='probe-call')){content=[{type:'toolCall',id:'probe-call',name:'fixture_action',arguments:{}}];stopReason='toolUse';}
   else content=[{type:'text',text:'done'}];
   const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,content,stopReason,timestamp:Date.now(),usage:{input:1,output:1,totalTokens:2,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}}};
   const stream=new AssistantMessageEventStream();stream.push({type:'done',reason:stopReason,message});stream.end();return stream;
  };
  const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false,keepRecentTokens:0},cacheWarming:{mode:'off'}});
  const resourceLoader=new DefaultResourceLoader({cwd,agentDir:cwd,settingsManager,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,extensionFactories:[{name:'probe',factory(pi){
   capabilityExtension(pi,{discovery:false});
   pi.registerTool({name:'fixture_action',label:'Fixture',defaultActive:false,description:'Execute fixture',parameters:{type:'object',properties:{}},execute:async()=>{executions++;return {content:[{type:'text',text:'executed'}]};}});
   pi.registerTool({name:'capability',label:'Discovery',description:'Fixture discovery',parameters:{type:'object',properties:{}},execute:async()=>{
    discoveries++;pi.setActiveTools([...pi.getActiveTools(),'fixture_action']);
    return {content:[{type:'text',text:'selected fixture'}],details:{status:'ok',tools:[{ref:'tool://fixture_action',name:'fixture_action',kind:'tool',status:'available',description:'Execute fixture',exposure:'direct'}],mcp:[],skills:[],remote:[]}};
   }});
   pi.registerTool({name:'via_nested',label:'Nested',description:'Calls discovery through the SDK nested tool pipeline',parameters:{type:'object',properties:{}},execute:async(_id,_args,_signal,_update,ctx)=>{
    const result=await ctx.executeTool('capability',{});return {content:result.content};
   }});
   pi.on('session_before_compact',event=>({compaction:{summary:'Summary omits all capability knowledge',firstKeptEntryId:event.preparation.firstKeptEntryId,tokensBefore:event.preparation.tokensBefore}}));
  }}]});
  await resourceLoader.reload();
  ({session}=await createAgentSession({cwd,agentDir:cwd,modelRuntime:runtime,model,sessionManager:SessionManager.inMemory(cwd),resourceLoader,settingsManager}));
  const errors=[];await session.bindExtensions({onError:e=>errors.push(e)});
  session.setActiveToolsByName(['capability','via_nested']);
  await session.prompt('Discover');
  const before=session.getActiveToolNames();
  await session.compact();stage='probe';
  await session.prompt('Use previously discovered tool without calling discovery');
  const payloads=[];
  const jwt='e30.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'offline'}})).toString('base64url')+'.fake';
  for(const context of contexts){
   let body;
   const stream=providerStream(model,{messages:context.messages},{apiKey:jwt,onPayload:payload=>{body=payload;throw new Error('STOP_BEFORE_NETWORK');}});
   await stream.result();
   payloads.push({stage:context.stage,tools:[...(body?.tools??[]),...(body?.input??[]).filter(x=>x.type==='additional_tools'||x.type==='tool_search_output').flatMap(x=>x.tools??[])].map(t=>t.name)});
  }
  console.log(JSON.stringify({mode,before,after:session.getActiveToolNames(),discoveries,executions,requests:requests.map(r=>({...r,memory:!!r.memory})),payloads,errors}));
 }finally{session?.dispose();await rm(cwd,{recursive:true,force:true});}
}
