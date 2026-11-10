/**
 * Machine-readable schema for the Harness RPC endpoint.
 *
 * This module is the source of truth for `schemas/harness-rpc.schema.json`.
 * It describes the implemented protocol in `transport.ts`, `router.ts` and the
 * four ports; it does not define a second state model. Shared structures are
 * referenced through `#/$defs/...`, so one envelope or payload shape has one
 * definition.
 *
 * Payloads owned by Pi stay opaque and name their upstream type:
 *
 * - `NativeSessionEvent` is Pi's `AgentSessionEvent` (see
 *   `@earendil-works/pi-coding-agent`). `message_update` is the projected shape
 *   from `stream-projection.ts`: the cumulative `partial` is dropped, and
 *   `toolcall_start` adds `id` / `toolName`.
 * - `NativeMessage` is Pi's `AgentMessage`; `NativePartial` is the streaming
 *   assistant message; `NativeEntry` is Pi's session file entry.
 * - `ToolDetail.parameters` is the tool's Pi TypeBox/JSON parameter schema.
 * - `JobRecordView.result` is the domain result value.
 *
 * The generated document is checked against real router/domain outputs by
 * `test/typed/harness-rpc-schema.test.ts`; `scripts/check-rpc-schema.mjs`
 * checks generated JSON against the tracked SHA256SUMS and that every method
 * has one parameter and one result definition.
 */

import { Type, type TSchema } from 'typebox';

import { RPC_METHODS, type RpcMethod } from './protocol.ts';

const ref = (name: string): TSchema => Type.Ref(`#/$defs/${name}`);

const nullable = (schema: TSchema): TSchema => Type.Union([schema, Type.Null()]);

const stringArray = (options: { readonly minItems?: number; readonly description?: string } = {}): TSchema =>
  Type.Array(Type.String(), {
    ...(options.minItems === undefined ? {} : { minItems: options.minItems }),
    ...(options.description === undefined ? {} : { description: options.description }),
  });

const description = (text: string): { readonly description: string } => ({ description: text });

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

const RpcId = Type.Union([Type.String(), Type.Number()], description('Client-chosen request correlation id.'));

const RpcResponseId = nullable(ref('RpcId'));

const RpcRequest = Type.Object({
  id: ref('RpcId'),
  method: Type.String({ minLength: 1 }),
  params: Type.Optional(Type.Unknown(description('Method-specific parameters; absent or null is treated as an empty object.'))),
}, {
  additionalProperties: true,
  description: 'One client frame. Unknown request fields are ignored by the transport.',
});

const RpcErrorBody = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
  detail: Type.Optional(Type.Unknown(description('Optional structured refusal detail.'))),
}, {
  additionalProperties: false,
  description: 'Stable code plus message. Expected refusals use a domain code; unexpected failures use "internal".',
});

const RpcSuccessResponse = Type.Object({
  id: ref('RpcResponseId'),
  ok: Type.Literal(true),
  result: Type.Unknown(description('Method result; the method map selects the concrete result definition.')),
}, { additionalProperties: false });

const RpcFailureResponse = Type.Object({
  id: ref('RpcResponseId'),
  ok: Type.Literal(false),
  error: ref('RpcErrorBody'),
}, { additionalProperties: false });

const RpcResponse = Type.Union([ref('RpcSuccessResponse'), ref('RpcFailureResponse')]);

const RpcEventEnvelope = Type.Object({
  subscription: Type.String({ minLength: 1 }),
  seq: Type.Integer({ minimum: 1, description: 'Monotonic per connection, so also monotonic within one subscription.' }),
  payload: Type.Unknown(description('Subscription-specific payload; stream events use StreamEventPayload.')),
}, { additionalProperties: false });

const RpcEventFrame = Type.Object({
  event: ref('RpcEventEnvelope'),
}, { additionalProperties: false });

const RpcServerFrame = Type.Union([ref('RpcResponse'), ref('RpcEventFrame')]);

// ---------------------------------------------------------------------------
// Tool management: one three-state model plus independent runtime facts
// ---------------------------------------------------------------------------

const ToolPermissionManagedState = Type.Union([Type.Literal('enabled'), Type.Literal('disabled')], description(
  'Explicit management state. "not managed" is the absence of an entry, not a third literal.',
));

const ToolPermissionState = Type.Union([
  Type.Literal('enabled'),
  Type.Literal('disabled'),
  Type.Literal('active'),
  Type.Literal('inactive'),
], description('Derived four-state view: managed enabled/disabled, or unmanaged active/inactive.'));

const ToolPermissionKind = Type.Union([
  Type.Literal('tool'),
  Type.Literal('mcp'),
  Type.Literal('namespace'),
  Type.Literal('prefix'),
], description('Target grammar kind; "prefix" is the config-default `foo*` form.'));

const ToolPermissionCategory = Type.Union([Type.Literal('tool'), Type.Literal('namespace')]);

const ToolPermissionTarget = Type.Object({
  target: Type.String({ minLength: 1, description: 'The user-facing target string, e.g. "read", "mcp://git", "namespace://subagent", "mcp__prod__*".' }),
  kind: ref('ToolPermissionKind'),
  name: Type.String({ minLength: 1, description: 'The parsed name after the scheme/prefix marker.' }),
  id: Type.String({ minLength: 1, description: 'Stable internal identity: `${kind}:${name}`.' }),
});

const ToolPermissionEntry = Type.Intersect([
  ref('ToolPermissionTarget'),
  Type.Object({
    state: ref('ToolPermissionManagedState'),
    scope: Type.Literal('branch'),
  }),
], { unevaluatedProperties: false, description: 'One effective management entry; no provenance is exposed.' });

const ToolPermissionInfo = Type.Object({
  name: Type.String({ minLength: 1 }),
  kind: ref('ToolPermissionKind'),
  category: ref('ToolPermissionCategory'),
  state: ref('ToolPermissionState'),
  managed: Type.Boolean(description('Whether an explicit management entry resolves for this tool.')),
  registered: Type.Boolean(),
  active: Type.Boolean(description('Live active-set membership; independent of the permission state.')),
}, { additionalProperties: false });

const ToolPermissionChange = Type.Intersect([
  ref('ToolPermissionTarget'),
  Type.Object({ affectedTools: stringArray() }),
], { unevaluatedProperties: false, description: 'One target a write applied to, with the registered tools it currently hits.' });

const ToolPermissionSkip = Type.Object({
  target: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const ToolPermissionQueryResult = Type.Object({
  scope: Type.Literal('branch'),
  expression: Type.String({ description: 'The effective expression; defaults to "enabled+active".' }),
  entries: Type.Array(ref('ToolPermissionInfo')),
  managed: Type.Array(ref('ToolPermissionEntry')),
}, { additionalProperties: false });

const ToolPermissionSetResult = Type.Object({
  state: ref('ToolPermissionManagedState'),
  changed: Type.Array(ref('ToolPermissionChange')),
  alreadySet: stringArray(),
  unresolved: stringArray(),
  skipped: Type.Array(ref('ToolPermissionSkip')),
  affectedTools: stringArray(),
  activated: stringArray(description('Tools activated by an enable.')),
  removedActive: stringArray(description('Active Codemode-only tools removed immediately by a disable.')),
  pendingCompaction: stringArray(description('Active declared tools blocked until the next successful compaction.')),
  noticed: stringArray(description('Enabled-and-used tools for which a model-facing notice was recorded.')),
  scope: Type.Literal('branch'),
  recordError: nullable(Type.String(description('Set when the permission record could not be written; effects are then not applied.'))),
}, { additionalProperties: false });

const ToolPermissionResetResult = Type.Object({
  reset: Type.Array(ref('ToolPermissionChange')),
  notManaged: stringArray(description('Targets that were not explicitly managed; a tombstone may still have been written.')),
  stillManaged: Type.Array(Type.Object({
    name: Type.String({ minLength: 1 }),
    state: ref('ToolPermissionManagedState'),
  }, { additionalProperties: false }), description('Tools still managed by another entry or the config default after the reset.')),
  scope: Type.Literal('branch'),
  recordError: nullable(Type.String()),
}, { additionalProperties: false });

const ActivationSkipReason = Type.Union([
  Type.Literal('not_registered'),
  Type.Literal('hidden'),
  Type.Literal('disabled'),
  Type.Literal('not_permitted'),
  Type.Literal('not_activated'),
  Type.Literal('unreachable'),
]);

const EnableResult = Type.Object({
  enabled: stringArray(),
  alreadyEnabled: stringArray(),
  skipped: Type.Array(Type.Object({
    name: Type.String({ minLength: 1 }),
    reason: ref('ActivationSkipReason'),
  }, { additionalProperties: false })),
  unresolved: stringArray(),
  expanded: Type.Array(Type.Object({
    target: Type.String({ minLength: 1 }),
    tools: stringArray(),
  }, { additionalProperties: false })),
  recordError: nullable(Type.String()),
}, { additionalProperties: false });

const CapabilityCategory = Type.Union([Type.Literal('tool'), Type.Literal('mcp'), Type.Literal('namespace')]);

const ToolStatus = Type.Object({
  registered: Type.Boolean(description('Registered on the host; not a guarantee that this scope may use it.')),
  eligible: Type.Boolean(description('Scope-level eligibility for the candidate catalog.')),
  active: Type.Boolean(description('Live active-set membership.')),
  permission: ref('ToolPermissionState'),
  managed: Type.Boolean(),
});

const ToolCatalogEntry = Type.Intersect([
  ref('ToolStatus'),
  Type.Object({
    name: Type.String({ minLength: 1 }),
    display: Type.String(),
    description: Type.String(),
    category: ref('CapabilityCategory'),
    group: Type.String(),
    namespace: nullable(Type.String()),
    exposure: nullable(Type.String()),
  }),
], { unevaluatedProperties: false });

const ToolCatalogResult = Type.Object({
  entries: Type.Array(ref('ToolCatalogEntry')),
  total: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

const ToolDetail = Type.Intersect([
  ref('ToolStatus'),
  Type.Object({
    name: Type.String({ minLength: 1 }),
    description: Type.String(),
    namespace: nullable(Type.String()),
    exposure: nullable(Type.String()),
    parameters: Type.Union([
      Type.Object({}, {
        additionalProperties: true,
        description: 'Opaque Pi ToolInfo.parameters TypeBox/JSON schema object.',
      }),
      Type.Null(),
    ]),
    promptGuidelines: nullable(stringArray()),
  }),
], { unevaluatedProperties: false });

// ---------------------------------------------------------------------------
// Subagent / Job views
// ---------------------------------------------------------------------------

const TerminalStatus = Type.Union([
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);

const JobStatus = Type.Union([
  Type.Literal('running'),
  Type.Literal('stopping'),
  Type.Literal('finalizing'),
  ref('TerminalStatus'),
]);

const HistoryState = Type.Union([Type.Literal('ready'), Type.Literal('error')]);

const LifecycleError = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
  detail: Type.Optional(Type.Unknown()),
}, { additionalProperties: false });

const HistoryBounds = Type.Object({
  startEntryId: nullable(Type.String()),
  endEntryId: nullable(Type.String()),
}, { additionalProperties: false });

const BudgetPhase = Type.Union([
  Type.Literal('normal'),
  Type.Literal('warning'),
  Type.Literal('exhausted'),
]);

const BudgetTermination = Type.Union([
  Type.Literal('model_final'),
  Type.Literal('cancelled'),
  Type.Literal('job_failed'),
  Type.Literal('budget_exhausted'),
  Type.Literal('lifetime_expired'),
]);

const BudgetTerminalError = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.Optional(Type.String()),
  detail: Type.Optional(Type.Unknown()),
}, { additionalProperties: false });

const BudgetTerminal = Type.Object({
  status: ref('TerminalStatus'),
  termination: ref('BudgetTermination'),
  truncated: Type.Boolean(),
  error: nullable(ref('BudgetTerminalError')),
}, { additionalProperties: false });

const BudgetSnapshot = Type.Object({
  jobId: nullable(Type.String()),
  depth: nullable(Type.Integer()),
  phase: ref('BudgetPhase'),
  modelCalls: Type.Integer({ minimum: 0 }),
  activeTimeMs: Type.Integer({ minimum: 0 }),
  rejectedProjectedModelCalls: nullable(Type.Integer()),
  running: Type.Boolean(),
  warningTaken: Type.Boolean(),
  terminal: nullable(ref('BudgetTerminal')),
}, { additionalProperties: false });

const JobView = Type.Object({
  jobId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  name: nullable(Type.String()),
  parentAgentId: nullable(Type.String()),
  depth: nullable(Type.Integer()),
  status: ref('JobStatus'),
  continuedFromJobId: nullable(Type.String()),
  stopping: Type.Optional(ref('TerminalStatus')),
  historyState: Type.Optional(ref('HistoryState')),
  historyError: Type.Optional(ref('LifecycleError')),
  error: Type.Optional(ref('LifecycleError')),
  budget: Type.Optional(ref('BudgetSnapshot')),
  warnings: Type.Optional(stringArray()),
}, { additionalProperties: false });

const JobRecordView = Type.Object({
  jobId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  name: nullable(Type.String()),
  round: Type.Integer({ minimum: 0 }),
  task: nullable(Type.String()),
  status: ref('JobStatus'),
  error: nullable(ref('LifecycleError')),
  result: Type.Unknown(description('Domain result value; deliberately opaque.')),
  history: nullable(ref('HistoryBounds')),
  historyState: Type.Optional(ref('HistoryState')),
  historyError: Type.Optional(ref('LifecycleError')),
  budget: nullable(ref('BudgetSnapshot')),
  previousJobId: nullable(Type.String()),
}, { additionalProperties: false });

const AgentKind = Type.Union([Type.Literal('fresh'), Type.Literal('inherited')]);

const DetailedAgentHistory = Type.Object({
  jobId: Type.String({ minLength: 1 }),
  summary: Type.String(),
  cleanJsonl: Type.String(),
  result: Type.Optional(Type.String()),
}, {
  additionalProperties: true,
  description: 'Job history paths; extra path keys may be present.',
});

const DetailedAgentItem = Type.Object({
  id: Type.String({ minLength: 1 }),
  status: Type.String(),
  socket: Type.String(),
  children: Type.Array(ref('DetailedAgentItem')),
  kind: Type.Optional(ref('AgentKind')),
  history: Type.Optional(ref('DetailedAgentHistory')),
  historyError: Type.Optional(ref('LifecycleError')),
  historyDir: Type.Optional(Type.String()),
}, { additionalProperties: false, description: 'Agent tree node; the Main node has no kind.' });

const CreatedAgentItem = Type.Object({
  id: Type.String({ minLength: 1 }),
  socket: Type.String(),
  role: Type.Optional(nullable(Type.String())),
  model: Type.Optional(nullable(Type.String())),
  warnings: Type.Optional(stringArray()),
}, { additionalProperties: false });

const CreatedAgents = Type.Object({
  items: Type.Array(ref('CreatedAgentItem')),
  warnings: Type.Optional(stringArray()),
}, { additionalProperties: false });

const StopResult = Type.Object({
  ok: Type.Boolean(),
  id: Type.String({ minLength: 1 }),
  status: Type.String(),
  reason: Type.Optional(Type.String()),
}, { additionalProperties: false });

const MessageReceipt = Type.Object({
  ok: Type.Literal(true),
  to: Type.String({ minLength: 1 }),
  jobId: nullable(Type.String()),
}, { additionalProperties: false });

const BroadcastReceipt = Type.Object({
  ok: Type.Boolean(),
  to: Type.Literal('all'),
  sent: Type.Array(Type.Object({
    to: Type.String({ minLength: 1 }),
    jobId: nullable(Type.String()),
  }, { additionalProperties: false })),
  errors: Type.Array(Type.Object({
    to: Type.String({ minLength: 1 }),
    code: Type.String({ minLength: 1 }),
    message: Type.String(),
  }, { additionalProperties: false })),
}, { additionalProperties: false });

const CrossSessionReceipt = Type.Object({
  ok: Type.Literal(true),
  delivered: Type.Literal('session'),
  path: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

const MessageSendResult = Type.Union([
  ref('MessageReceipt'),
  ref('BroadcastReceipt'),
  ref('CrossSessionReceipt'),
]);

// ---------------------------------------------------------------------------
// History and child execution stream
// ---------------------------------------------------------------------------

const NativeEntry = Type.Object({}, {
  additionalProperties: true,
  description: 'Opaque Pi session file entry (FileEntry).',
});

const NativeMessage = Type.Object({}, {
  additionalProperties: true,
  description: 'Opaque Pi AgentMessage (content, usage, stopReason, etc.).',
});

const NativePartial = Type.Union([
  Type.Object({}, {
    additionalProperties: true,
    description: 'Opaque cumulative Pi assistant message currently streaming.',
  }),
  Type.Null(),
]);

const NativeSessionEvent = Type.Object({
  type: Type.String({ minLength: 1 }),
}, {
  additionalProperties: true,
  description: 'Pi AgentSessionEvent from @earendil-works/pi-coding-agent@1.5.0 (dist/core/agent-session.d.ts:49). Except message_update, the native event passes through unchanged; assistant message_update drops the top-level message and assistantMessageEvent.partial, keeps usage, and toolcall_start adds id/toolName when resolvable.',
});

const HistoryReadResult = Type.Union([
  Type.Object({
    available: Type.Literal(false),
    jobId: Type.String({ minLength: 1 }),
    status: ref('JobStatus'),
    reason: Type.Literal('history_unavailable'),
  }, { additionalProperties: false }),
  Type.Object({
    available: Type.Literal(true),
    jobId: Type.String({ minLength: 1 }),
    status: ref('JobStatus'),
    live: Type.Boolean(),
    bounds: ref('HistoryBounds'),
    entries: Type.Array(ref('NativeEntry')),
  }, { additionalProperties: false }),
]);

const StreamBoundary = Type.Object({
  status: ref('JobStatus'),
  round: Type.Integer({ minimum: 0 }),
  history: nullable(ref('HistoryBounds')),
  messages: Type.Array(ref('NativeMessage'), description('Completed native messages produced since the Job started.')),
  partial: ref('NativePartial'),
}, { additionalProperties: false });

const StreamSubscribeResult = Type.Object({
  subscription: Type.String({ minLength: 1 }),
  jobId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  rootSessionId: Type.String({ minLength: 1 }),
  live: Type.Boolean(),
  boundary: ref('StreamBoundary'),
}, { additionalProperties: false });

const StreamUnsubscribeResult = Type.Object({
  removed: Type.Boolean(),
}, { additionalProperties: false });

const StreamSessionEvent = Type.Object({
  kind: Type.Literal('session'),
  rootSessionId: Type.String({ minLength: 1 }),
  jobId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  event: ref('NativeSessionEvent'),
}, { additionalProperties: false });

const StreamJobEvent = Type.Object({
  kind: Type.Literal('job'),
  rootSessionId: Type.String({ minLength: 1 }),
  jobId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  status: ref('JobStatus'),
}, { additionalProperties: false });

const StreamEventPayload = Type.Union([ref('StreamSessionEvent'), ref('StreamJobEvent')]);

// ---------------------------------------------------------------------------
// Method parameters and results
// ---------------------------------------------------------------------------

const HarnessInfoResult = Type.Object({
  protocolVersion: Type.Integer({ minimum: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  pid: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

const NoParams = Type.Object({}, {
  additionalProperties: true,
  description: 'No parameters. The transport treats absent or null params as an empty object.',
});

const ToolsCatalogParams = Type.Object({
  filter: Type.Optional(Type.String({ description: 'Case-insensitive text over name, description and group.' })),
  category: Type.Optional(ref('CapabilityCategory')),
}, { additionalProperties: true });

const ToolsDetailParams = Type.Object({
  name: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

const TargetsParams = Type.Object({
  targets: stringArray({ minItems: 1 }),
}, { additionalProperties: true });

const PermissionQueryParams = Type.Object({
  expr: Type.Optional(Type.String({ description: 'term (("+"|"-")term)*; defaults to enabled+active.' })),
}, { additionalProperties: true });

const JobsListParams = Type.Object({
  jobIds: Type.Optional(stringArray()),
}, { additionalProperties: true });

const JobIdParams = Type.Object({
  jobId: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

const SubagentTask = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  task: Type.String({ minLength: 1 }),
  inheritContext: Type.Optional(Type.Boolean()),
}, {
  additionalProperties: false,
  description: 'The domain rejects unknown task fields; the RPC adapter passes items through.',
});

const SubagentCreateParams = Type.Object({
  context: Type.Optional(Type.String()),
  tasks: Type.Array(ref('SubagentTask'), { minItems: 1 }),
}, { additionalProperties: true });

const SubagentStopParams = Type.Object({
  id: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

const MessageSendParams = Type.Object({
  path: Type.String({ minLength: 1, description: 'Managed IPC address (Unix socket or Windows Named Pipe); not a bare Actor ID.' }),
  content: Type.String(),
}, { additionalProperties: true });

const StreamUnsubscribeParams = Type.Object({
  subscription: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

const AgentsTreeResult = nullable(ref('DetailedAgentItem'));

const JobsListResult = Type.Object({
  jobs: Type.Array(ref('JobView')),
}, { additionalProperties: false });

const JobGetResult = Type.Object({
  job: ref('JobView'),
  record: nullable(ref('JobRecordView')),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Per-method request schemas (method discriminator + params)
// ---------------------------------------------------------------------------

function methodRequest(method: RpcMethod, params: TSchema, required: boolean): TSchema {
  return Type.Object({
    id: ref('RpcId'),
    method: Type.Literal(method),
    // The transport treats an absent or null params value as an empty object.
    // Required-parameter methods still reject null here because the field check
    // would fail; optional-parameter methods accept it as the empty object.
    params: required ? params : Type.Optional(Type.Union([params, Type.Null()])),
  }, { additionalProperties: true });
}

const MethodRequest = Type.Union([
  methodRequest(RPC_METHODS.info, ref('NoParams'), false),
  methodRequest(RPC_METHODS.toolsCatalog, ref('ToolsCatalogParams'), false),
  methodRequest(RPC_METHODS.toolsDetail, ref('ToolsDetailParams'), true),
  methodRequest(RPC_METHODS.toolsEnable, ref('TargetsParams'), true),
  methodRequest(RPC_METHODS.permissionQuery, ref('PermissionQueryParams'), false),
  methodRequest(RPC_METHODS.permissionEnable, ref('TargetsParams'), true),
  methodRequest(RPC_METHODS.permissionDisable, ref('TargetsParams'), true),
  methodRequest(RPC_METHODS.permissionReset, ref('TargetsParams'), true),
  methodRequest(RPC_METHODS.agentsTree, ref('NoParams'), false),
  methodRequest(RPC_METHODS.jobsList, ref('JobsListParams'), false),
  methodRequest(RPC_METHODS.jobsGet, ref('JobIdParams'), true),
  methodRequest(RPC_METHODS.jobsResult, ref('JobIdParams'), true),
  methodRequest(RPC_METHODS.subagentCreate, ref('SubagentCreateParams'), true),
  methodRequest(RPC_METHODS.subagentStop, ref('SubagentStopParams'), true),
  methodRequest(RPC_METHODS.messageSend, ref('MessageSendParams'), true),
  methodRequest(RPC_METHODS.historyRead, ref('JobIdParams'), true),
  methodRequest(RPC_METHODS.streamSubscribe, ref('JobIdParams'), true),
  methodRequest(RPC_METHODS.streamUnsubscribe, ref('StreamUnsubscribeParams'), true),
]);

// ---------------------------------------------------------------------------
// Discovery record
// ---------------------------------------------------------------------------

const HarnessRpcRecord = Type.Object({
  protocolVersion: Type.Integer({ minimum: 1 }),
  address: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  pid: Type.Integer({ minimum: 1 }),
  startedAt: Type.String({ description: 'ISO-8601 timestamp.' }),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Definitions and method map
// ---------------------------------------------------------------------------

const DEFS = {
  RpcId,
  RpcResponseId,
  RpcRequest,
  RpcErrorBody,
  RpcSuccessResponse,
  RpcFailureResponse,
  RpcResponse,
  RpcEventEnvelope,
  RpcEventFrame,
  RpcServerFrame,
  ToolPermissionManagedState,
  ToolPermissionState,
  ToolPermissionKind,
  ToolPermissionCategory,
  ToolPermissionTarget,
  ToolPermissionEntry,
  ToolPermissionInfo,
  ToolPermissionChange,
  ToolPermissionSkip,
  ToolPermissionQueryResult,
  ToolPermissionSetResult,
  ToolPermissionResetResult,
  ActivationSkipReason,
  EnableResult,
  CapabilityCategory,
  ToolStatus,
  ToolCatalogEntry,
  ToolCatalogResult,
  ToolDetail,
  TerminalStatus,
  JobStatus,
  HistoryState,
  LifecycleError,
  HistoryBounds,
  BudgetPhase,
  BudgetTermination,
  BudgetTerminalError,
  BudgetTerminal,
  BudgetSnapshot,
  JobView,
  JobRecordView,
  AgentKind,
  DetailedAgentHistory,
  DetailedAgentItem,
  CreatedAgentItem,
  CreatedAgents,
  StopResult,
  MessageReceipt,
  BroadcastReceipt,
  CrossSessionReceipt,
  MessageSendResult,
  NativeEntry,
  NativeMessage,
  NativePartial,
  NativeSessionEvent,
  HistoryReadResult,
  StreamBoundary,
  StreamSubscribeResult,
  StreamUnsubscribeResult,
  StreamSessionEvent,
  StreamJobEvent,
  StreamEventPayload,
  HarnessInfoResult,
  NoParams,
  ToolsCatalogParams,
  ToolsDetailParams,
  TargetsParams,
  PermissionQueryParams,
  JobsListParams,
  JobIdParams,
  SubagentTask,
  SubagentCreateParams,
  SubagentStopParams,
  MessageSendParams,
  StreamUnsubscribeParams,
  AgentsTreeResult,
  JobsListResult,
  JobGetResult,
  MethodRequest,
  HarnessRpcRecord,
} as const;

export type RpcMethodSchema = {
  /** `$defs` name (without the `#/$defs/` prefix) for the method parameters. */
  readonly params: string;
  /** `$defs` name (without the `#/$defs/` prefix) for the method result. */
  readonly result: string;
  /** Whether the method requires `params`; optional methods accept absent or null. */
  readonly paramsRequired: boolean;
};

/** Method -> shared definition names. The keys are the implemented method names. */
export const HARNESS_RPC_METHOD_SCHEMAS = {
  [RPC_METHODS.info]: { params: 'NoParams', result: 'HarnessInfoResult', paramsRequired: false },
  [RPC_METHODS.toolsCatalog]: { params: 'ToolsCatalogParams', result: 'ToolCatalogResult', paramsRequired: false },
  [RPC_METHODS.toolsDetail]: { params: 'ToolsDetailParams', result: 'ToolDetail', paramsRequired: true },
  [RPC_METHODS.toolsEnable]: { params: 'TargetsParams', result: 'EnableResult', paramsRequired: true },
  [RPC_METHODS.permissionQuery]: { params: 'PermissionQueryParams', result: 'ToolPermissionQueryResult', paramsRequired: false },
  [RPC_METHODS.permissionEnable]: { params: 'TargetsParams', result: 'ToolPermissionSetResult', paramsRequired: true },
  [RPC_METHODS.permissionDisable]: { params: 'TargetsParams', result: 'ToolPermissionSetResult', paramsRequired: true },
  [RPC_METHODS.permissionReset]: { params: 'TargetsParams', result: 'ToolPermissionResetResult', paramsRequired: true },
  [RPC_METHODS.agentsTree]: { params: 'NoParams', result: 'AgentsTreeResult', paramsRequired: false },
  [RPC_METHODS.jobsList]: { params: 'JobsListParams', result: 'JobsListResult', paramsRequired: false },
  [RPC_METHODS.jobsGet]: { params: 'JobIdParams', result: 'JobGetResult', paramsRequired: true },
  [RPC_METHODS.jobsResult]: { params: 'JobIdParams', result: 'JobRecordView', paramsRequired: true },
  [RPC_METHODS.subagentCreate]: { params: 'SubagentCreateParams', result: 'CreatedAgents', paramsRequired: true },
  [RPC_METHODS.subagentStop]: { params: 'SubagentStopParams', result: 'StopResult', paramsRequired: true },
  [RPC_METHODS.messageSend]: { params: 'MessageSendParams', result: 'MessageSendResult', paramsRequired: true },
  [RPC_METHODS.historyRead]: { params: 'JobIdParams', result: 'HistoryReadResult', paramsRequired: true },
  [RPC_METHODS.streamSubscribe]: { params: 'JobIdParams', result: 'StreamSubscribeResult', paramsRequired: true },
  [RPC_METHODS.streamUnsubscribe]: { params: 'StreamUnsubscribeParams', result: 'StreamUnsubscribeResult', paramsRequired: true },
} as const satisfies Record<RpcMethod, RpcMethodSchema>;

/**
 * Pinned upstream types used by the opaque payloads. These are the installed
 * versions the protocol was tested against; the paths are package-relative and
 * the line numbers are for the installed 1.5.0 artifacts.
 */
export const HARNESS_RPC_UPSTREAM = {
  packages: {
    '@earendil-works/pi-coding-agent': '1.5.0',
    '@earendil-works/pi-agent-core': '1.5.0',
    '@earendil-works/pi-ai': '1.5.0',
  },
  types: {
    AgentSessionEvent: {
      package: '@earendil-works/pi-coding-agent', version: '1.5.0',
      definition: 'dist/core/agent-session.d.ts:49', export: 'dist/index.d.ts:3',
    },
    AgentMessage: { package: '@earendil-works/pi-agent-core', version: '1.5.0', definition: 'dist/types.d.ts:322' },
    AssistantMessage: { package: '@earendil-works/pi-ai', version: '1.5.0', definition: 'dist/types.d.ts:375' },
    AssistantMessageEvent: { package: '@earendil-works/pi-ai', version: '1.5.0', definition: 'dist/types.d.ts:585' },
    Usage: { package: '@earendil-works/pi-ai', version: '1.5.0', definition: 'dist/types.d.ts:285' },
    ToolInfo: {
      package: '@earendil-works/pi-coding-agent', version: '1.5.0',
      definition: 'dist/core/extensions/types.d.ts:1600', export: 'dist/index.d.ts:8',
    },
    FileEntry: {
      package: '@earendil-works/pi-coding-agent', version: '1.5.0',
      definition: 'dist/core/session-manager.d.ts:130', export: 'dist/index.d.ts:21',
    },
  },
  messageUpdate: {
    native: '{ type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }',
    projected: '{ type: "message_update"; usage: Usage; assistantMessageEvent: ProjectedAssistantMessageEvent }',
    drops: ['message', 'assistantMessageEvent.partial'],
    toolcallStart: 'adds id and toolName when partial.content[contentIndex] is a toolCall; omitted otherwise',
    nonAssistant: 'passes through unchanged; the projection only applies to message.role === "assistant"',
    projectedEvents: {
      start: '{ type }',
      text_start: '{ type, contentIndex }',
      text_delta: '{ type, contentIndex, delta }',
      text_end: '{ type, contentIndex, content }',
      thinking_start: '{ type, contentIndex }',
      thinking_delta: '{ type, contentIndex, delta }',
      thinking_end: '{ type, contentIndex, content }',
      toolcall_start: '{ type, contentIndex, id?, toolName? }',
      toolcall_delta: '{ type, contentIndex, delta }',
      toolcall_end: '{ type, contentIndex, toolCall }',
      done: '{ type, reason, message }',
      error: '{ type, reason, error }',
    },
  },
} as const;

/** The generated JSON Schema document. `scripts/check-rpc-schema.mjs` writes it. */
export const HARNESS_RPC_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:pi-harness:harness-rpc:1',
  title: 'Harness RPC protocol',
  description: 'Frames of the Harness independent structured endpoint. Method parameters and results live in $defs and are mapped by x-methods.',
  oneOf: [
    { $ref: '#/$defs/RpcRequest' },
    { $ref: '#/$defs/RpcResponse' },
    { $ref: '#/$defs/RpcEventFrame' },
  ],
  $defs: DEFS,
  'x-methods': HARNESS_RPC_METHOD_SCHEMAS,
} as const;

/** Wrap a shared definition in a root schema so `$ref` resolution sees `$defs`. */
export function harnessRpcSchemaRef(name: string): TSchema {
  return { $defs: DEFS, $ref: `#/$defs/${name}` } as TSchema;
}

/** The strict client-request schema (method discriminator + params). */
export function harnessRpcMethodRequestSchema(): TSchema {
  return harnessRpcSchemaRef('MethodRequest');
}
