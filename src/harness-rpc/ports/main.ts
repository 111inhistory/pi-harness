import type { MainInput, SdkMainControls } from '../../session/main-controls.ts';
import type { RpcSessionBinding } from '../../session/rpc-binding.ts';
import type { MethodParams, MethodResult } from '../contract.ts';
import type { RpcConnection } from '../transport.ts';
import { RpcRequestError } from '../error.ts';

export interface MainPortAccess {
  binding(): RpcSessionBinding | undefined;
  controls(): SdkMainControls | undefined;
  generation(): number;
  recover(binding: RpcSessionBinding): Promise<void>;
}

/** Calls the existing SDK or extension operations; it owns no Main execution state. */
export function buildMainPort(access: MainPortAccess) {
  const binding = () => {
    const value = access.binding();
    if (value === undefined) throw new RpcRequestError('runtime_transitioning', 'No active session is bound.');
    value.assertSession();
    return value;
  };
  const controls = () => {
    const value = access.controls();
    if (value === undefined) throw new RpcRequestError('unavailable', 'This operation requires a host bound to the SDK session runtime.');
    return value;
  };
  const transition = async <T extends { cancelled: boolean }>(run: (sdk: SdkMainControls) => Promise<T>): Promise<T> => {
    const before = access.binding();
    const result = await run(controls());
    if (result.cancelled && before !== undefined) await access.recover(before);
    return result;
  };
  return {
    state(): MethodResult<'main.state'> {
      const sdk = access.controls();
      if (sdk !== undefined) {
        const { generation: _bindingGeneration, ...session } = sdk.state();
        return { generation: access.generation(), session: { ...session,
          capabilities: { ...session.capabilities, inputAdmission: true } } };
      }
      const { api, ctx } = binding();
      return { generation: access.generation(), session: {
        sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null,
        name: api.getSessionName() ?? null, leafId: ctx.sessionManager.getLeafId(),
        model: ctx.model === undefined ? null : { provider: ctx.model.provider, id: ctx.model.id },
        thinkingLevel: api.getThinkingLevel(), idle: ctx.isIdle(), streaming: null, compacting: null,
        retrying: null, pendingMessageCount: ctx.hasPendingMessages() ? null : 0, activeTools: api.getActiveTools(),
        capabilities: { input: true, interrupt: true, compact: true, events: true, inputAdmission: false,
          navigateTree: false, reload: false, newSession: false, switchSession: false, fork: false },
      } };
    },
    async input(params: MainInput): Promise<MethodResult<'main.input'>> {
      const generation = access.generation();
      const sdk = access.controls();
      if (sdk !== undefined) {
        const result = await sdk.submitInput(params);
        return { ...result, generation };
      }
      const current = binding();
      current.api.sendUserMessage(params.images === undefined ? params.text : [
        { type: 'text', text: params.text }, ...params.images,
      ], { ...(params.streamingBehavior === undefined ? {} : { deliverAs: params.streamingBehavior }),
        ...(params.expandPromptTemplates === undefined ? {} : { expandPromptTemplates: params.expandPromptTemplates }) });
      return { generation, sessionId: current.ctx.sessionManager.getSessionId(), disposition: 'submitted' };
    },
    async interrupt(): Promise<MethodResult<'main.interrupt'>> {
      const sdk = access.controls();
      if (sdk === undefined) binding().ctx.abort();
      else await sdk.interrupt();
      return { requested: true };
    },
    async compact(params: MethodParams<'main.compact'>): Promise<MethodResult<'main.compact'>> {
      const sdk = access.controls();
      if (sdk !== undefined) return { completed: true, result: await sdk.compact(params.instructions) };
      binding().ctx.compact(params.instructions === undefined ? {} : { customInstructions: params.instructions });
      return { completed: false, result: null };
    },
    navigate(params: MethodParams<'main.navigate'>) {
      return transition(sdk => sdk.navigateTree(params.targetId, {
        ...(params.summarize === undefined ? {} : { summarize: params.summarize }),
        ...(params.customInstructions === undefined ? {} : { customInstructions: params.customInstructions }),
        ...(params.replaceInstructions === undefined ? {} : { replaceInstructions: params.replaceInstructions }),
        ...(params.label === undefined ? {} : { label: params.label }),
      }));
    },
    newSession(params: MethodParams<'main.new'>) {
      return transition(sdk => sdk.newSession(params.parentSession === undefined ? {} : { parentSession: params.parentSession }));
    },
    switchSession(params: MethodParams<'main.switch'>) {
      return transition(sdk => sdk.switchSession(params.sessionPath,
        params.cwdOverride === undefined ? undefined : { cwdOverride: params.cwdOverride }));
    },
    fork(params: MethodParams<'main.fork'>) {
      return transition(sdk => sdk.fork(params.entryId, params.position === undefined ? undefined : { position: params.position }));
    },
    async reload(): Promise<MethodResult<'main.reload'>> { await controls().reload(); return { requested: true }; },
    subscribe(connection: RpcConnection): MethodResult<'main.subscribe'> {
      const sdk = access.controls();
      let unsubscribe: (() => void) | undefined;
      const subscription = connection.addSubscription(() => unsubscribe?.(), sdk === undefined ? 'root' : 'host');
      if (sdk !== undefined) {
        unsubscribe = sdk.subscribe(event => connection.pushEvent(subscription, {
          kind: 'main', rootSessionId: event.sessionId, generation: access.generation(), source: 'sdk',
          event: event.type === 'native' ? event.event : { type: 'input_error', message: event.message },
        }));
      } else {
        const { api, ctx } = binding();
        const push = (event: unknown) => connection.pushEvent(subscription, { kind: 'main',
          rootSessionId: ctx.sessionManager.getSessionId(), generation: access.generation(), source: 'extension', event });
        const releases = [api.on('agent_start', event => { push(event); }), api.on('agent_end', event => { push(event); }),
          api.on('message_end', event => { push(event); }), api.on('model_select', event => { push(event); }),
          api.on('session_compact', event => { push(event); }), api.on('session_info_changed', event => { push(event); })];
        unsubscribe = () => { for (const release of releases) release(); };
      }
      return { subscription };
    },
  };
}

export type MainPort = ReturnType<typeof buildMainPort>;
