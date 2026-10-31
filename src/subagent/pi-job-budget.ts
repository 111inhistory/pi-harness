import type { Agent, PrepareRequest, StreamFn } from '@earendil-works/pi-agent-core';
import type { BudgetTerminal, JobBudgetPort } from './job-budget.ts';

export interface ModelCallBudgetSession {
  readonly agent?: Pick<Agent, 'streamFunction' | 'prepareRequest'>;
  abort(): void | Promise<void>;
}
export interface ModelCallBudgetOptions {
  readonly beforeRequest?: () => { readonly stop?: boolean; readonly reason?: string } | undefined;
  readonly warningText?: (warning: string) => string;
}
export class ModelCallBudgetError extends Error {
  readonly code: string;
  readonly terminal: BudgetTerminal | null;
  constructor(terminal: BudgetTerminal | null) {
    const code = terminal?.error?.code ?? 'budget_exceeded';
    super(`Model request refused by the job budget (${code}).`);
    this.name = 'ModelCallBudgetError';
    this.code = code;
    this.terminal = terminal;
  }
}
function abortSession(session: ModelCallBudgetSession): void {
  const pending = session.abort();
  if (pending) void pending.catch(() => {});
}
/** Charge every provider attempt, including compaction and retries, at dispatch. */
export function installModelCallBudget(
  session: ModelCallBudgetSession,
  budget: Pick<JobBudgetPort, 'beginModelCall' | 'takeWarning'>,
  { beforeRequest, warningText }: ModelCallBudgetOptions = {},
): () => void {
  const agent = session.agent;
  if (!agent || typeof agent.streamFunction !== 'function') {
    throw Object.assign(new Error('A live agent stream boundary is required to install the model budget.'), { code: 'budget_hook_unavailable' });
  }
  const previousStream = agent.streamFunction;
  const previousPrepare = agent.prepareRequest;
  const streamWrapper: StreamFn = (model, context, options) => {
    const decision = beforeRequest?.();
    if (decision?.stop) {
      abortSession(session);
      throw new Error(decision.reason ?? 'Model request refused.');
    }
    const debit = budget.beginModelCall();
    if (!debit.ok) {
      abortSession(session);
      throw new ModelCallBudgetError(debit.terminal);
    }
    return previousStream.call(agent, model, context, options);
  };
  const prepareWrapper: PrepareRequest = async (request, signal) => {
    const update = await previousPrepare?.call(agent, request, signal);
    const warning = budget.takeWarning();
    if (warning === null) return update ?? undefined;
    const context = update?.context ?? request.context;
    return { ...update, context: { ...context, messages: [...context.messages, {
      role: 'user', content: [{ type: 'text', text: warningText?.(warning) ?? warning }], timestamp: Date.now(),
    }] } };
  };
  agent.streamFunction = streamWrapper;
  agent.prepareRequest = prepareWrapper;
  return () => {
    if (agent.streamFunction === streamWrapper) agent.streamFunction = previousStream;
    if (agent.prepareRequest === prepareWrapper) {
      if (previousPrepare === undefined) delete agent.prepareRequest;
      else agent.prepareRequest = previousPrepare;
    }
  };
}
