import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createToolPermissionResolver } from '../capability/tool-permission.ts';
import { createToolAdmission } from '../capability/admission.ts';
import { projectDiscoveryDeclarations } from '../capability/declarations.ts';
import { projectCompactionCapabilityNotice, projectPrunedToolHistory } from '../capability/compaction-context.ts';
import { replayInheritedPromptGuidance, type InheritedSnapshot } from '../inherited-context.ts';
import { promptString } from '../prompt-text.ts';
import { providerSessionPolicy } from '../provider-session.ts';
import { installSessionCacheIdentity } from '../session-cache-runtime.ts';
import { additiveToolTranscript, appendSessionTranscript, firstToolDeclarations } from '../session-transcript.ts';
import { openSubagentExecution, type SubagentExecution } from '../subagent/execution.ts';
import { parentModelRuntime } from '../subagent/model-runtime.ts';

export interface BtwConversation {
  ask(question: string, onText: (text: string) => void): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
}

function assistantText(message: AgentMessage): string {
  return message.role === 'assistant'
    ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    : '';
}

/** An internal inherited SDK session; no Actor, IPC listener or durable history. */
export async function openBtwConversation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: InheritedSnapshot,
  signal: AbortSignal,
): Promise<BtwConversation> {
  if (snapshot.model === null) throw new Error('Select a model before opening /btw.');
  const instructions = promptString('btw.json', 'system');
  const blockedReason = promptString('btw.json', 'toolsBlocked');
  const settings = SettingsManager.inMemory({
    ...pi.getSettings(), packages: [], extensions: [], skills: [], prompts: [], themes: [], cacheWarming: 'off',
  }, { projectTrusted: ctx.isProjectTrusted() });
  const branch = ctx.sessionManager.getBranch();
  const permission = createToolPermissionResolver(pi, pi.getAllTools(), branch);
  const keepInherited = (name: string): boolean =>
    !permission.disabled(name) && !permission.enabled(name);
  const entries = snapshot.entries.map(entry => {
    if (entry.type !== 'message' || entry.message.role !== 'system') return entry;
    const message = entry.message;
    return { ...entry, message: {
      ...message,
      ...(message.toolsAdded === undefined ? {} : { toolsAdded: message.toolsAdded.filter(tool => keepInherited(tool.name)) }),
      ...(message.toolsRemoved === undefined ? {} : { toolsRemoved: message.toolsRemoved.filter(tool => keepInherited(tool.name)) }),
    } };
  });
  const policy = providerSessionPolicy(snapshot.model);
  const additive = policy.midConversationSystemMessages && policy.toolSupport !== 'none';
  const messages = entries.flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  // Only inert declarations are inherited; no parent executable handle is copied.
  const tools: ToolDefinition[] = additive ? firstToolDeclarations(messages).map(tool => ({
    ...tool,
    label: tool.name,
    async execute() { throw new Error(blockedReason); },
  })) : [];
  let toolBlocked = false;
  const resourceLoader = new DefaultResourceLoader({
    cwd: snapshot.cwd, agentDir: getAgentDir(), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: snapshot.systemPrompt.trim() ? snapshot.systemPrompt : instructions,
    ...(snapshot.systemPrompt.trim() ? { appendSystemPrompt: [instructions] } : {}),
    extensionFactories: [{
      name: 'btw-tool-boundary',
      factory(api) {
        api.on('tool_call', () => {
          toolBlocked = true;
          return { block: true, reason: blockedReason, terminate: true };
        });
      },
    }],
  });
  await resourceLoader.reload();
  const execution = await openSubagentExecution({
    cwd: snapshot.cwd, agentDir: getAgentDir(), settingsManager: settings, resourceLoader,
    modelRuntime: parentModelRuntime(ctx.modelRegistry, '/btw'),
    model: snapshot.model, thinkingLevel: snapshot.thinkingLevel ?? 'low',
    sessionManager: SessionManager.inMemory(snapshot.cwd, {}, entries),
    tools: tools.map(tool => tool.name), customTools: tools,
  }, { signal });
  try {
    const session = execution.session;
    execution.addCleanup(installSessionCacheIdentity(session, snapshot.cacheKey));
    await session.bindExtensions({});
    execution.addCleanup(() => session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }));
    const previous = session.agent.transformContext;
    session.agent.transformContext = async (input, requestSignal) => {
      const transformed = previous ? await previous(input, requestSignal) : input;
      const admission = createToolAdmission(pi, snapshot.entries);
      const branch = session.sessionManager.getBranch();
      const historical = projectPrunedToolHistory(transformed, branch);
      const declarations = projectDiscoveryDeclarations(historical, admission.declares,
        () => pi.getAllTools().find(tool => tool.name === 'codemode')?.description);
      const guided = replayInheritedPromptGuidance(declarations, session.sessionManager);
      const projected = additive ? appendSessionTranscript(additiveToolTranscript(guided), {
        blockedTools: tools.map(tool => tool.name),
      }).messages : guided;
      return projectCompactionCapabilityNotice(projected as AgentMessage[], branch);
    };
    return conversation(execution, () => { toolBlocked = false; }, () => toolBlocked, blockedReason);
  } catch (error) {
    await execution.dispose();
    throw error;
  }
}

function conversation(
  execution: SubagentExecution,
  resetBlocked: () => void,
  wasBlocked: () => boolean,
  blockedReason: string,
): BtwConversation {
  let closed = false;
  let pending: Promise<void> | undefined;
  let cancelling: Promise<void> | undefined;
  return {
    async ask(question, onText) {
      if (cancelling) await cancelling;
      if (pending) await pending.catch(() => {});
      if (closed) throw new Error('/btw is closed.');
      resetBlocked();
      const session = execution.session;
      const finished: string[] = [];
      let partial = '';
      const publish = () => onText([...finished, partial].filter(Boolean).join('\n\n'));
      const unsubscribe = session.subscribe(event => {
        if (closed || !('message' in event) || event.message.role !== 'assistant') return;
        if (event.type === 'message_update') partial = assistantText(event.message);
        else if (event.type === 'message_end') {
          const text = assistantText(event.message);
          if (text) finished.push(text);
          partial = '';
        } else return;
        publish();
      });
      const operation = execution.prompt(question, { expandPromptTemplates: false });
      pending = operation;
      try {
        await operation;
        if (wasBlocked()) throw new Error(blockedReason);
        const last = session.state.messages.findLast(message => message.role === 'assistant');
        if (last?.role === 'assistant' && last.stopReason === 'error') {
          throw new Error(last.errorMessage || '/btw request failed.');
        }
      } finally {
        unsubscribe();
        if (pending === operation) pending = undefined;
      }
    },
    cancel() {
      const operation = execution.abort();
      cancelling = operation;
      void operation.finally(() => { if (cancelling === operation) cancelling = undefined; }).catch(() => {});
      return operation;
    },
    dispose() {
      closed = true;
      return execution.dispose();
    },
  };
}
