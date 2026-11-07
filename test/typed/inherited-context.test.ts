import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelRuntime, SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { fauxProvider, InMemoryCredentialStore, type AssistantMessage, type Api, type Model } from '@earendil-works/pi-ai';
import { captureInheritedContext } from '../../src/inherited-context.ts';
import { physicalModelForCall } from '../../src/subagent/model-runtime.ts';
import { recordSessionCacheIdentity, CACHE_IDENTITY_CUSTOM_TYPE } from '../../src/session-cache-runtime.ts';

type CaptureContext = Parameters<typeof captureInheritedContext>[1];
const pi = {getActiveTools:()=>['read','capability']};
const physical = fauxProvider({models:[{id:'physical-fixture',reasoning:true}]}).models[0];
function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {role:'assistant',api:physical.api,provider:physical.provider,model:physical.id,content,
    stopReason:'toolUse',timestamp:1,usage:{input:0,output:0,totalTokens:0,cacheRead:0,cacheWrite:0,cost:{input:0,output:0,total:0,cacheRead:0,cacheWrite:0}}};
}
function context(manager: SessionManager, model: Model<Api> = physical, registry?: CaptureContext['modelRegistry']): CaptureContext {
  return {cwd:'/tmp/fixture',sessionManager:manager,model,thinkingLevel:'high',getSystemPrompt:()=>'PARENT_CONTEXT',
    modelRegistry:registry ?? {} as ExtensionContext['modelRegistry']};
}

test('capture retains native blocks, gives every child its own id, and removes only pending calls', () => {
  const manager = SessionManager.inMemory('/tmp/fixture');
  manager.appendMessage({role:'user',content:'task',timestamp:1});
  const thinking = {type:'thinking' as const,thinking:'reasoning',thinkingSignature:'fixture-signature'};
  const id = manager.appendMessage(assistant([thinking,{type:'toolCall',id:'completed',name:'read',arguments:{}},
    {type:'toolCall',id:'spawn',name:'capability',arguments:{}}]));
  manager.appendMessage({role:'toolResult',toolCallId:'completed',toolName:'read',content:[{type:'text',text:'body'}],isError:false,timestamp:2});
  const before = structuredClone(manager.getBranch());
  const first = captureInheritedContext(pi,context(manager),'spawn');
  const second = captureInheritedContext(pi,context(manager),'spawn');
  assert.notEqual(first.entries[0]?.id,second.entries[0]?.id);
  assert.notEqual(first.entries[0]?.id,manager.getHeader()?.id);
  assert.equal(first.model,physical);
  assert.equal(first.systemPrompt,'PARENT_CONTEXT');
  assert.equal(first.thinkingLevel,'high');
  assert.deepEqual(first.tools,['read','capability']);
  const captured = first.entries.find(entry => entry.id===id);
  assert.ok(captured?.type==='message' && captured.message.role==='assistant');
  assert.deepEqual(captured.message.content,[thinking,{type:'toolCall',id:'completed',name:'read',arguments:{}}]);
  assert.deepEqual(manager.getBranch(),before);
});

test('pending-only message removal relinks followers without touching the parent branch', () => {
  const manager = SessionManager.inMemory('/tmp/fixture');
  const user = manager.appendMessage({role:'user',content:'task',timestamp:1});
  const spawn = manager.appendMessage(assistant([{type:'toolCall',id:'spawn',name:'capability',arguments:{}}]));
  const info = manager.appendSessionInfo('child-ready');
  const snapshot = captureInheritedContext(pi,context(manager),'spawn');
  assert.ok(!snapshot.entries.some(entry=>entry.id===spawn));
  const followed = snapshot.entries.find(entry=>entry.id===info);
  assert.ok(followed!==undefined && 'parentId' in followed);
  assert.equal(followed.parentId,user);
  assert.equal(manager.getEntry(info)?.parentId,spawn);
});

test('an already completed response remains untouched', () => {
  const manager = SessionManager.inMemory('/tmp/fixture');
  const id = manager.appendMessage({...assistant([{type:'text',text:'done'}]),stopReason:'stop'});
  const snapshot = captureInheritedContext(pi,context(manager));
  assert.equal(snapshot.entries.find(entry=>entry.id===id),manager.getEntry(id));
});

test('virtual capture pins the producing physical model before dropping its spawning call', async () => {
  const faux = fauxProvider({models:[{id:'physical-fixture',reasoning:true}]});
  const runtime = await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false});
  runtime.registerNativeProvider(faux.provider);
  const manager = SessionManager.inMemory('/tmp/fixture');
  manager.appendMessage(assistant([{type:'toolCall',id:'spawn',name:'subagent_create',arguments:{}}]));
  const virtual = {...physical,id:'router',api:'pi-virtual' as Api};
  const ctx = context(manager,virtual,{runtime} as unknown as ExtensionContext['modelRegistry']);
  const snapshot = captureInheritedContext(pi,ctx,'spawn');
  assert.equal(snapshot.model?.id,physical.id);
  assert.notEqual(snapshot.model?.api,'pi-virtual');
  assert.ok(!snapshot.entries.some(entry=>entry.type==='message' && entry.message.role==='assistant'));
  assert.equal(physicalModelForCall(ctx,'spawn/1')?.id,physical.id,'nested tool calls resolve their producing outer call');
  assert.equal(captureInheritedContext(pi,ctx).model?.id,physical.id,'commands inherit the latest physical response');
  manager.appendMessage({...assistant([{type:'text',text:'latest answer'}]),stopReason:'stop'});
  assert.equal(captureInheritedContext(pi,ctx).model?.id,physical.id,'commands do not require a tool call in the response');
  assert.throws(()=>captureInheritedContext(pi,ctx,'missing'),/physical model.*unavailable/);
  assert.equal(ctx.model?.api,'pi-virtual','parent selection remains untouched');
});

test('captureInheritedContext captures branch cacheKey and retains harness-cache-identity entries', () => {
  const manager = SessionManager.inMemory('/tmp/fixture');
  manager.appendMessage({role:'user',content:'root task',timestamp:1});

  // 1. Default when no entry on branch
  const defaultSnapshot = captureInheritedContext(pi, context(manager));
  assert.equal(defaultSnapshot.cacheKey, manager.getSessionId());

  // 2. Explicit cache key recorded on branch
  recordSessionCacheIdentity(manager, 'explicit-parent-cache-key');
  const explicitSnapshot = captureInheritedContext(pi, context(manager));
  assert.equal(explicitSnapshot.cacheKey, 'explicit-parent-cache-key');

  // Verify that the custom entry survived in snapshot.entries for nested branch restoration
  const customInEntries = explicitSnapshot.entries.find(
    (entry): entry is Extract<(typeof explicitSnapshot.entries)[number], { type: 'custom' }> =>
      entry.type === 'custom' && entry.customType === CACHE_IDENTITY_CUSTOM_TYPE,
  );
  assert.ok(customInEntries, 'harness-cache-identity entry must be preserved in snapshot.entries');
  assert.deepEqual(customInEntries.data, { key: 'explicit-parent-cache-key' });

  // 3. Disabled cache (key = null)
  recordSessionCacheIdentity(manager, null);
  const disabledSnapshot = captureInheritedContext(pi, context(manager));
  assert.equal(disabledSnapshot.cacheKey, null);
});
