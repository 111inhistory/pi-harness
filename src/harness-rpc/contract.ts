/**
 * Single-source contract for the Harness RPC endpoint.
 *
 * One contract map drives:
 * - concrete `Static` parameter and result TypeScript types,
 * - startup-JIT TypeBox validation (`typebox/compile`),
 * - `MethodRequest` discriminated request union,
 * - JSON Schema `$defs` / `x-methods` and manifest metadata,
 * - typed router dispatch and typed client calls.
 *
 * Payloads owned by Pi stay opaque at this boundary:
 * - `NativeSessionEvent` is Pi's `AgentSessionEvent` (projected by `stream-projection.ts`),
 * - `NativeMessage` is Pi's `AgentMessage`, `NativePartial` is the streaming partial,
 * - `NativeEntry` is Pi's `FileEntry`,
 * - `ToolDetail.parameters` is Pi's `ToolInfo.parameters`,
 * - `JobRecordView.result` is the domain result value.
 */

import { Type, type Static, type TProperties, type TSchema } from 'typebox';
import { Compile, type Validator } from 'typebox/compile';

import { RPC_ERROR, RPC_METHODS, type RpcId, type RpcMethod } from './protocol.ts';
import { RpcRequestError } from './error.ts';

const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

const stringArray = (options: { readonly minItems?: number; readonly description?: string } = {}) =>
  Type.Array(Type.String(), {
    ...(options.minItems === undefined ? {} : { minItems: options.minItems }),
    ...(options.description === undefined ? {} : { description: options.description }),
  });

const description = (text: string): { readonly description: string } => ({ description: text });

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export const RpcIdSchema = Type.Union(
  [Type.String(), Type.Number()],
  description('Client-chosen request correlation id.'),
);

export const RpcResponseIdSchema = nullable(RpcIdSchema);

export const RpcRequestSchema = Type.Object({
  id: RpcIdSchema,
  method: Type.String({ minLength: 1 }),
  params: Type.Optional(Type.Unknown(description('Method-specific parameters; absent or null is treated as an empty object.'))),
}, {
  additionalProperties: true,
  description: 'One client frame. Unknown request fields are ignored by the transport.',
});

export const RpcErrorBodySchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
  detail: Type.Optional(Type.Unknown(description('Optional structured refusal detail.'))),
}, {
  additionalProperties: false,
  description: 'Stable code plus message. Expected refusals use a domain code; unexpected failures use "internal".',
});

export const RpcSuccessResponseSchema = Type.Object({
  id: RpcResponseIdSchema,
  ok: Type.Literal(true),
  result: Type.Unknown(description('Method result; the method map selects the concrete result definition.')),
}, { additionalProperties: false });

export const RpcFailureResponseSchema = Type.Object({
  id: RpcResponseIdSchema,
  ok: Type.Literal(false),
  error: RpcErrorBodySchema,
}, { additionalProperties: false });

export const RpcResponseSchema = Type.Union([RpcSuccessResponseSchema, RpcFailureResponseSchema]);

export const RpcEventEnvelopeSchema = Type.Object({
  subscription: Type.String({ minLength: 1 }),
  seq: Type.Integer({ minimum: 1, description: 'Monotonic per connection, so also monotonic within one subscription.' }),
  payload: Type.Unknown(description('Subscription-specific payload; stream events use StreamEventPayload.')),
}, { additionalProperties: false });

export const RpcEventFrameSchema = Type.Object({
  event: RpcEventEnvelopeSchema,
}, { additionalProperties: false });

export const RpcServerFrameSchema = Type.Union([RpcResponseSchema, RpcEventFrameSchema]);

// ---------------------------------------------------------------------------
// Tool management: one three-state model plus independent runtime facts
// ---------------------------------------------------------------------------

export const ToolPermissionManagedStateSchema = Type.Union(
  [Type.Literal('enabled'), Type.Literal('disabled')],
  description('Explicit management state. "not managed" is the absence of an entry, not a third literal.'),
);

export const ToolPermissionStateSchema = Type.Union([
  Type.Literal('enabled'),
  Type.Literal('disabled'),
  Type.Literal('active'),
  Type.Literal('inactive'),
], description('Derived four-state view: managed enabled/disabled, or unmanaged active/inactive.'));

export const ToolPermissionKindSchema = Type.Union([
  Type.Literal('tool'),
  Type.Literal('mcp'),
  Type.Literal('namespace'),
  Type.Literal('prefix'),
], description('Target grammar kind; "prefix" is the config-default `foo*` form.'));

export const ToolPermissionCategorySchema = Type.Union([Type.Literal('tool'), Type.Literal('namespace')]);

const toolPermissionTargetFields = {
  target: Type.String({ minLength: 1, description: 'The user-facing target string, e.g. "read", "mcp://git", "namespace://subagent", "mcp__prod__*".' }),
  kind: ToolPermissionKindSchema,
  name: Type.String({ minLength: 1, description: 'The parsed name after the scheme/prefix marker.' }),
  id: Type.String({ minLength: 1, description: 'Stable internal identity: `${kind}:${name}`.' }),
};

export const ToolPermissionTargetSchema = Type.Object(toolPermissionTargetFields);

export const ToolPermissionEntrySchema = Type.Object({
  ...toolPermissionTargetFields,
  state: ToolPermissionManagedStateSchema,
  scope: Type.Literal('branch'),
}, { additionalProperties: false, description: 'One effective management entry; no provenance is exposed.' });

export const ToolPermissionInfoSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  kind: ToolPermissionKindSchema,
  category: ToolPermissionCategorySchema,
  state: ToolPermissionStateSchema,
  managed: Type.Boolean(description('Whether an explicit management entry resolves for this tool.')),
  registered: Type.Boolean(),
  active: Type.Boolean(description('Live active-set membership; independent of the permission state.')),
}, { additionalProperties: false });

export const ToolPermissionChangeSchema = Type.Object({
  ...toolPermissionTargetFields,
  affectedTools: stringArray(),
}, { additionalProperties: false, description: 'One target a write applied to, with the registered tools it currently hits.' });

export const ToolPermissionSkipSchema = Type.Object({
  target: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const ToolPermissionQueryResultSchema = Type.Object({
  scope: Type.Literal('branch'),
  expression: Type.String({ description: 'The effective expression; defaults to "enabled+active".' }),
  entries: Type.Array(ToolPermissionInfoSchema),
  managed: Type.Array(ToolPermissionEntrySchema),
}, { additionalProperties: false });

export const ToolPermissionSetResultSchema = Type.Object({
  state: ToolPermissionManagedStateSchema,
  changed: Type.Array(ToolPermissionChangeSchema),
  alreadySet: stringArray(),
  unresolved: stringArray(),
  skipped: Type.Array(ToolPermissionSkipSchema),
  affectedTools: stringArray(),
  activated: stringArray(description('Tools activated by an enable.')),
  removedActive: stringArray(description('Active Codemode-only tools removed immediately by a disable.')),
  pendingCompaction: stringArray(description('Active declared tools blocked until the next successful compaction.')),
  noticed: stringArray(description('Enabled-and-used tools for which a model-facing notice was recorded.')),
  scope: Type.Literal('branch'),
  recordError: nullable(Type.String(description('Set when the permission record could not be written; effects are then not applied.'))),
}, { additionalProperties: false });

export const ToolPermissionResetResultSchema = Type.Object({
  reset: Type.Array(ToolPermissionChangeSchema),
  notManaged: stringArray(description('Targets that were not explicitly managed; a tombstone may still have been written.')),
  stillManaged: Type.Array(Type.Object({
    name: Type.String({ minLength: 1 }),
    state: ToolPermissionManagedStateSchema,
  }, { additionalProperties: false }), description('Tools still managed by another entry or the config default after the reset.')),
  scope: Type.Literal('branch'),
  recordError: nullable(Type.String()),
}, { additionalProperties: false });

export const ActivationSkipReasonSchema = Type.Union([
  Type.Literal('not_registered'),
  Type.Literal('hidden'),
  Type.Literal('disabled'),
  Type.Literal('not_permitted'),
  Type.Literal('not_activated'),
  Type.Literal('unreachable'),
]);

export const EnableResultSchema = Type.Object({
  enabled: stringArray(),
  alreadyEnabled: stringArray(),
  skipped: Type.Array(Type.Object({
    name: Type.String({ minLength: 1 }),
    reason: ActivationSkipReasonSchema,
  }, { additionalProperties: false })),
  unresolved: stringArray(),
  expanded: Type.Array(Type.Object({
    target: Type.String({ minLength: 1 }),
    tools: stringArray(),
  }, { additionalProperties: false })),
  recordError: nullable(Type.String()),
}, { additionalProperties: false });

export const CapabilityCategorySchema = Type.Union([
  Type.Literal('tool'),
  Type.Literal('mcp'),
  Type.Literal('namespace'),
]);

const toolStatusFields = {
  registered: Type.Boolean(description('Registered on the host; not a guarantee that this scope may use it.')),
  eligible: Type.Boolean(description('Scope-level eligibility for the candidate catalog.')),
  active: Type.Boolean(description('Live active-set membership.')),
  permission: ToolPermissionStateSchema,
  managed: Type.Boolean(),
};

export const ToolStatusSchema = Type.Object(toolStatusFields);

export const ToolCatalogEntrySchema = Type.Object({
  ...toolStatusFields,
  name: Type.String({ minLength: 1 }),
  display: Type.String(),
  description: Type.String(),
  category: CapabilityCategorySchema,
  group: Type.String(),
  namespace: nullable(Type.String()),
  exposure: nullable(Type.String()),
}, { additionalProperties: false });

export const ToolCatalogResultSchema = Type.Object({
  entries: Type.Array(ToolCatalogEntrySchema),
  total: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const NativeToolParametersSchema = nullable(Type.Unsafe<unknown>({
  type: 'object',
  additionalProperties: true,
  description: 'Opaque Pi ToolInfo.parameters TypeBox/JSON schema object.',
}));

export const ToolDetailSchema = Type.Object({
  ...toolStatusFields,
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  namespace: nullable(Type.String()),
  exposure: nullable(Type.String()),
  parameters: NativeToolParametersSchema,
  promptGuidelines: nullable(stringArray()),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Subagent / Job views
// ---------------------------------------------------------------------------

export const TerminalStatusSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
]);

export const JobStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('stopping'),
  Type.Literal('finalizing'),
  TerminalStatusSchema,
]);

export const HistoryStateSchema = Type.Union([Type.Literal('ready'), Type.Literal('error')]);

export const LifecycleErrorSchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
  detail: Type.Optional(Type.Unknown()),
}, { additionalProperties: false });

export const HistoryBoundsSchema = Type.Object({
  startEntryId: nullable(Type.String()),
  endEntryId: nullable(Type.String()),
}, { additionalProperties: false });

export const BudgetPhaseSchema = Type.Union([
  Type.Literal('normal'),
  Type.Literal('warning'),
  Type.Literal('exhausted'),
]);

export const BudgetTerminationSchema = Type.Union([
  Type.Literal('model_final'),
  Type.Literal('cancelled'),
  Type.Literal('job_failed'),
  Type.Literal('budget_exhausted'),
  Type.Literal('lifetime_expired'),
]);

export const BudgetTerminalErrorSchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  message: Type.Optional(Type.String()),
  detail: Type.Optional(Type.Unknown()),
}, { additionalProperties: false });

export const BudgetTerminalSchema = Type.Object({
  status: TerminalStatusSchema,
  termination: BudgetTerminationSchema,
  truncated: Type.Boolean(),
  error: nullable(BudgetTerminalErrorSchema),
}, { additionalProperties: false });

export const BudgetSnapshotSchema = Type.Object({
  jobId: nullable(Type.String()),
  depth: nullable(Type.Integer()),
  phase: BudgetPhaseSchema,
  modelCalls: Type.Integer({ minimum: 0 }),
  activeTimeMs: Type.Integer({ minimum: 0 }),
  rejectedProjectedModelCalls: nullable(Type.Integer()),
  running: Type.Boolean(),
  warningTaken: Type.Boolean(),
  terminal: nullable(BudgetTerminalSchema),
}, { additionalProperties: false });

export const JobViewSchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  name: nullable(Type.String()),
  parentAgentId: nullable(Type.String()),
  depth: nullable(Type.Integer()),
  status: JobStatusSchema,
  continuedFromJobId: nullable(Type.String()),
  stopping: Type.Optional(TerminalStatusSchema),
  historyState: Type.Optional(HistoryStateSchema),
  historyError: Type.Optional(LifecycleErrorSchema),
  error: Type.Optional(LifecycleErrorSchema),
  budget: Type.Optional(BudgetSnapshotSchema),
  warnings: Type.Optional(stringArray()),
}, { additionalProperties: false });

export const JobRecordViewSchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  name: nullable(Type.String()),
  round: Type.Integer({ minimum: 0 }),
  task: nullable(Type.String()),
  status: JobStatusSchema,
  error: nullable(LifecycleErrorSchema),
  result: Type.Unknown(description('Domain result value; deliberately opaque.')),
  history: nullable(HistoryBoundsSchema),
  historyState: Type.Optional(HistoryStateSchema),
  historyError: Type.Optional(LifecycleErrorSchema),
  budget: nullable(BudgetSnapshotSchema),
  previousJobId: nullable(Type.String()),
}, { additionalProperties: false });

export const AgentKindSchema = Type.Union([Type.Literal('fresh'), Type.Literal('inherited')]);

export const DetailedAgentHistorySchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
  summary: Type.String(),
  cleanJsonl: Type.String(),
  result: Type.Optional(Type.String()),
}, {
  additionalProperties: true,
  description: 'Job history paths; extra path keys may be present.',
});

export const DetailedAgentItemSchema = Type.Cyclic({
  DetailedAgentItem: Type.Object({
    id: Type.String({ minLength: 1 }),
    status: Type.String(),
    socket: Type.String(),
    children: Type.Array(Type.Ref('DetailedAgentItem')),
    kind: Type.Optional(AgentKindSchema),
    history: Type.Optional(DetailedAgentHistorySchema),
    historyError: Type.Optional(LifecycleErrorSchema),
    historyDir: Type.Optional(Type.String()),
  }, { additionalProperties: false, description: 'Agent tree node; the Main node has no kind.' }),
}, 'DetailedAgentItem');

export const CreatedAgentItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  socket: Type.String(),
  role: Type.Optional(nullable(Type.String())),
  model: Type.Optional(nullable(Type.String())),
  warnings: Type.Optional(stringArray()),
}, { additionalProperties: false });

export const CreatedAgentsSchema = Type.Object({
  items: Type.Array(CreatedAgentItemSchema),
  warnings: Type.Optional(stringArray()),
}, { additionalProperties: false });

export const StopResultSchema = Type.Object({
  ok: Type.Boolean(),
  id: Type.String({ minLength: 1 }),
  status: Type.String(),
  reason: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const MessageReceiptSchema = Type.Object({
  ok: Type.Literal(true),
  to: Type.String({ minLength: 1 }),
  jobId: nullable(Type.String()),
}, { additionalProperties: false });

export const BroadcastReceiptSchema = Type.Object({
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

export const CrossSessionReceiptSchema = Type.Object({
  ok: Type.Literal(true),
  delivered: Type.Literal('session'),
  path: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const MessageSendResultSchema = Type.Union([
  MessageReceiptSchema,
  BroadcastReceiptSchema,
  CrossSessionReceiptSchema,
]);

// ---------------------------------------------------------------------------
// History and child execution stream
// ---------------------------------------------------------------------------

export const NativeEntrySchema = Type.Object({}, {
  additionalProperties: true,
  description: 'Opaque Pi session file entry (FileEntry).',
});

export const NativeMessageSchema = Type.Unsafe<unknown>({
  type: 'object',
  additionalProperties: true,
  description: 'Opaque Pi AgentMessage (content, usage, stopReason, etc.).',
});

export const NativePartialSchema = nullable(Type.Unsafe<unknown>({
  type: 'object',
  additionalProperties: true,
  description: 'Opaque cumulative Pi assistant message currently streaming.',
}));

export const NativeSessionEventSchema = Type.Object({
  type: Type.String({ minLength: 1 }),
}, {
  additionalProperties: true,
  description: 'Pi AgentSessionEvent from @earendil-works/pi-coding-agent@1.5.0 (dist/core/agent-session.d.ts:49). Except message_update, the native event passes through unchanged; assistant message_update drops the top-level message and assistantMessageEvent.partial, keeps usage, and toolcall_start adds id/toolName when resolvable.',
});

export const HistoryReadResultSchema = Type.Union([
  Type.Object({
    available: Type.Literal(false),
    jobId: Type.String({ minLength: 1 }),
    status: JobStatusSchema,
    reason: Type.Literal('history_unavailable'),
  }, { additionalProperties: false }),
  Type.Object({
    available: Type.Literal(true),
    jobId: Type.String({ minLength: 1 }),
    status: JobStatusSchema,
    live: Type.Boolean(),
    bounds: HistoryBoundsSchema,
    entries: Type.Array(NativeEntrySchema),
  }, { additionalProperties: false }),
]);

export const StreamBoundarySchema = Type.Object({
  status: JobStatusSchema,
  round: Type.Integer({ minimum: 0 }),
  history: nullable(HistoryBoundsSchema),
  messages: Type.Array(NativeMessageSchema, description('Completed native messages produced since the Job started.')),
  partial: NativePartialSchema,
}, { additionalProperties: false });

export const StreamSubscribeResultSchema = Type.Object({
  subscription: Type.String({ minLength: 1 }),
  jobId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  rootSessionId: Type.String({ minLength: 1 }),
  live: Type.Boolean(),
  boundary: StreamBoundarySchema,
}, { additionalProperties: false });

export const StreamUnsubscribeResultSchema = Type.Object({
  removed: Type.Boolean(),
}, { additionalProperties: false });

export const StreamSessionEventSchema = Type.Object({
  kind: Type.Literal('session'),
  rootSessionId: Type.String({ minLength: 1 }),
  jobId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  event: NativeSessionEventSchema,
}, { additionalProperties: false });

export const StreamJobEventSchema = Type.Object({
  kind: Type.Literal('job'),
  rootSessionId: Type.String({ minLength: 1 }),
  jobId: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  status: JobStatusSchema,
}, { additionalProperties: false });

export const StreamEventPayloadSchema = Type.Union([StreamSessionEventSchema, StreamJobEventSchema]);

// ---------------------------------------------------------------------------
// Method parameters and results
// ---------------------------------------------------------------------------

export const HarnessInfoResultSchema = Type.Object({
  protocolVersion: Type.Integer({ minimum: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  pid: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export const NoParamsSchema = Type.Object({}, {
  additionalProperties: true,
  description: 'No parameters. The transport treats absent or null params as an empty object.',
});

export const ToolsCatalogParamsSchema = Type.Object({
  filter: Type.Optional(Type.String({ description: 'Case-insensitive text over name, description and group.' })),
  category: Type.Optional(CapabilityCategorySchema),
}, { additionalProperties: true });

export const ToolsDetailParamsSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

export const TargetsParamsSchema = Type.Object({
  targets: stringArray({ minItems: 1 }),
}, { additionalProperties: true });

export const PermissionQueryParamsSchema = Type.Object({
  expr: Type.Optional(Type.String({ description: 'term (("+"|"-")term)*; defaults to enabled+active.' })),
}, { additionalProperties: true });

export const JobsListParamsSchema = Type.Object({
  jobIds: Type.Optional(stringArray()),
}, { additionalProperties: true });

export const JobIdParamsSchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

export const SubagentTaskSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  task: Type.String({ minLength: 1 }),
  inheritContext: Type.Optional(Type.Boolean()),
}, {
  additionalProperties: false,
  description: 'The domain rejects unknown task fields; the RPC adapter passes items through.',
});

export const SubagentCreateParamsSchema = Type.Object({
  context: Type.Optional(Type.String()),
  tasks: Type.Array(SubagentTaskSchema, { minItems: 1 }),
}, { additionalProperties: true });

export const SubagentStopParamsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

export const MessageSendParamsSchema = Type.Object({
  path: Type.String({ minLength: 1, description: 'Managed IPC address (Unix socket or Windows Named Pipe); not a bare Actor ID.' }),
  content: Type.String(),
}, { additionalProperties: true });

export const StreamUnsubscribeParamsSchema = Type.Object({
  subscription: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

export const AgentsTreeResultSchema = nullable(DetailedAgentItemSchema);

export const JobsListResultSchema = Type.Object({
  jobs: Type.Array(JobViewSchema),
}, { additionalProperties: false });

export const JobGetResultSchema = Type.Object({
  job: JobViewSchema,
  record: nullable(JobRecordViewSchema),
}, { additionalProperties: false });

export const HarnessRpcRecordSchema = Type.Object({
  protocolVersion: Type.Integer({ minimum: 1 }),
  address: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  pid: Type.Integer({ minimum: 1 }),
  startedAt: Type.String({ description: 'ISO-8601 timestamp.' }),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const ThinkingLevelNameSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
]);

export const CodemodeModeSchema = Type.Union([Type.Literal('on'), Type.Literal('only')]);

export const PresetModelSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const PresetCodemodeSchema = Type.Object({
  mode: CodemodeModeSchema,
}, { additionalProperties: false });

export const PresetConfigSchema = Type.Object({
  description: Type.Optional(Type.String()),
  model: Type.Optional(PresetModelSchema),
  thinkingLevel: Type.Optional(ThinkingLevelNameSchema),
  tools: Type.Optional(stringArray()),
  codemode: Type.Optional(PresetCodemodeSchema),
  instructions: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const PresetCatalogItemSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  config: PresetConfigSchema,
}, { additionalProperties: false });

export const PresetsCatalogResultSchema = Type.Object({
  presets: Type.Array(PresetCatalogItemSchema),
  warnings: stringArray(),
}, { additionalProperties: false });

export const PresetSnapshotSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  model: Type.Optional(PresetModelSchema),
  thinkingLevel: Type.Optional(ThinkingLevelNameSchema),
  tools: Type.Optional(stringArray()),
  codemode: Type.Optional(PresetCodemodeSchema),
  instructions: nullable(Type.String()),
}, { additionalProperties: false });

export const PresetsCurrentResultSchema = Type.Object({
  preset: nullable(PresetSnapshotSchema),
}, { additionalProperties: false });

export const PresetApplyParamsSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

export const PresetIssueSeveritySchema = Type.Union([Type.Literal('error'), Type.Literal('warning')]);

export const PresetIssueKindSchema = Type.Union([
  Type.Literal('unknown_model'),
  Type.Literal('invalid_tool_modifier'),
  Type.Literal('unknown_tool'),
  Type.Literal('invalid_codemode_mode'),
]);

export const PresetIssueSchema = Type.Object({
  severity: PresetIssueSeveritySchema,
  kind: PresetIssueKindSchema,
  detail: Type.String(),
}, { additionalProperties: false });

export const PresetApplyProblemSchema = Type.Union([
  Type.Object({
    severity: Type.Literal('error'),
    kind: Type.Literal('model_unauthenticated'),
    model: PresetModelSchema,
    detail: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    severity: Type.Literal('warning'),
    kind: Type.Literal('codemode_not_applied'),
    codemode: PresetCodemodeSchema,
    detail: Type.String(),
  }, { additionalProperties: false }),
]);

export const PresetApplyOutcomeSchema = Type.Object({
  applied: Type.Boolean(),
  snapshot: nullable(PresetSnapshotSchema),
  issues: Type.Array(PresetIssueSchema),
  problems: Type.Array(PresetApplyProblemSchema),
  codemodeNotApplied: Type.Boolean(),
}, { additionalProperties: false });

export const PresetClearOutcomeSchema = Type.Object({
  cleared: Type.Literal(true),
  snapshot: Type.Null(),
  codemodeCleared: Type.Boolean(),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Shell approvals
// ---------------------------------------------------------------------------

export const ShellApprovalDecisionSchema = Type.Union([Type.Literal('allow'), Type.Literal('deny')]);

export const ShellApprovalPendingStateSchema = Type.Union([Type.Literal('queued'), Type.Literal('active')]);

export const ShellApprovalPendingSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  sourceAgent: Type.String({ minLength: 1 }),
  shell: Type.String({ minLength: 1 }),
  cwd: Type.String(),
  command: Type.String(),
  reason: nullable(Type.String()),
  state: ShellApprovalPendingStateSchema,
  timeoutSeconds: Type.Number(),
  requestedAt: Type.Number(),
  expiresAt: nullable(Type.Number()),
}, { additionalProperties: false });

export const ApprovalsListResultSchema = Type.Object({
  items: Type.Array(ShellApprovalPendingSchema),
}, { additionalProperties: false });

export const ApprovalIdParamsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

export const ApprovalsGetResultSchema = Type.Object({
  item: nullable(ShellApprovalPendingSchema),
}, { additionalProperties: false });

export const ApprovalRespondParamsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  decision: ShellApprovalDecisionSchema,
}, { additionalProperties: true });

export const ShellApprovalRespondResultSchema = Type.Union([
  Type.Object({
    accepted: Type.Literal(true),
    decision: ShellApprovalDecisionSchema,
  }, { additionalProperties: false }),
  Type.Object({
    accepted: Type.Literal(false),
    reason: Type.Union([
      Type.Literal('not_pending'),
      Type.Literal('invalid_decision'),
      Type.Literal('disposed'),
    ]),
  }, { additionalProperties: false }),
]);

export const ApprovalsSubscribeResultSchema = Type.Object({
  subscription: Type.String({ minLength: 1 }),
  items: Type.Array(ShellApprovalPendingSchema),
}, { additionalProperties: false });

export const ApprovalsEventSchema = Type.Object({
  kind: Type.Literal('approvals'),
  rootSessionId: Type.String({ minLength: 1 }),
  items: Type.Array(ShellApprovalPendingSchema),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Session peers
// ---------------------------------------------------------------------------

export const LiveSessionSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  uid: Type.String({ minLength: 1 }),
  socketDir: Type.String({ minLength: 1 }),
  pid: Type.Integer({ minimum: 1 }),
  cwd: Type.String(),
  name: nullable(Type.String()),
  startedAt: Type.Number(),
}, { additionalProperties: false });

export const SessionsListResultSchema = Type.Object({
  sessions: Type.Array(LiveSessionSchema),
}, { additionalProperties: false });

export const SessionsConnectParamsSchema = Type.Object({
  target: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

export const SessionConnectSchema = Type.Object({
  session: LiveSessionSchema,
  address: Type.String({ minLength: 1 }),
  enabled: stringArray(),
  alreadyEnabled: stringArray(),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Main session controls
// ---------------------------------------------------------------------------

export const MainCapabilitiesSchema = Type.Object({
  input: Type.Boolean(),
  interrupt: Type.Boolean(),
  compact: Type.Boolean(),
  events: Type.Boolean(),
  navigateTree: Type.Boolean(),
  reload: Type.Boolean(),
  newSession: Type.Boolean(),
  switchSession: Type.Boolean(),
  fork: Type.Boolean(),
  inputAdmission: Type.Boolean(),
}, { additionalProperties: false });

export const MainSessionStateSchema = Type.Object({
  sessionId: Type.String({ minLength: 1 }),
  sessionFile: nullable(Type.String()),
  name: nullable(Type.String()),
  leafId: nullable(Type.String()),
  model: nullable(PresetModelSchema),
  thinkingLevel: Type.String(),
  idle: Type.Boolean(),
  streaming: nullable(Type.Boolean()),
  compacting: nullable(Type.Boolean()),
  retrying: nullable(Type.Boolean()),
  pendingMessageCount: nullable(Type.Integer({ minimum: 0 })),
  activeTools: stringArray(),
  capabilities: MainCapabilitiesSchema,
}, { additionalProperties: false });

export const MainStateResultSchema = Type.Object({
  generation: Type.Integer({ minimum: 0 }),
  session: MainSessionStateSchema,
}, { additionalProperties: false });

export const MainImageContentSchema = Type.Object({
  type: Type.Literal('image'),
  data: Type.String(),
  mimeType: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const MainInputParamsSchema = Type.Object({
  text: Type.String(),
  images: Type.Optional(Type.Array(MainImageContentSchema)),
  streamingBehavior: Type.Optional(Type.Union([Type.Literal('steer'), Type.Literal('followUp')])),
  expandPromptTemplates: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

export const MainInputDispositionSchema = Type.Union([
  Type.Literal('handled'),
  Type.Literal('queued'),
  Type.Literal('started'),
  Type.Literal('submitted'),
]);

export const MainInputResultSchema = Type.Object({
  generation: Type.Integer({ minimum: 0 }),
  sessionId: Type.String({ minLength: 1 }),
  disposition: MainInputDispositionSchema,
}, { additionalProperties: false });

export const MainRequestedResultSchema = Type.Object({
  requested: Type.Literal(true),
}, { additionalProperties: false });

export const MainCompactParamsSchema = Type.Object({
  instructions: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const MainCompactResultSchema = Type.Object({
  completed: Type.Boolean(),
  result: nullable(Type.Unsafe<unknown>({
    type: 'object',
    additionalProperties: true,
    description: 'Opaque Pi SDK CompactionResult, or null when compaction did not complete.',
  })),
}, { additionalProperties: false });

export const MainNavigateParamsSchema = Type.Object({
  targetId: Type.String({ minLength: 1 }),
  summarize: Type.Optional(Type.Boolean()),
  customInstructions: Type.Optional(Type.String()),
  replaceInstructions: Type.Optional(Type.Boolean()),
  label: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const MainNewParamsSchema = Type.Object({
  parentSession: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: true });

export const MainSwitchParamsSchema = Type.Object({
  sessionPath: Type.String({ minLength: 1 }),
  cwdOverride: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: true });

export const MainForkParamsSchema = Type.Object({
  entryId: Type.String({ minLength: 1 }),
  position: Type.Optional(Type.Union([Type.Literal('before'), Type.Literal('at')])),
}, { additionalProperties: true });

export const MainOutcomeResultSchema = Type.Object({
  cancelled: Type.Boolean(),
  selectedText: Type.Optional(Type.String()),
  editorText: Type.Optional(Type.String()),
}, {
  additionalProperties: true,
  description: 'Upstream SDK navigation/replacement outcome; additional SDK fields are preserved.',
});

export const MainSubscribeResultSchema = Type.Object({
  subscription: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const MainEventSourceSchema = Type.Union([Type.Literal('sdk'), Type.Literal('extension')]);

export const MainEventPayloadSchema = Type.Object({
  kind: Type.Literal('main'),
  generation: Type.Integer({ minimum: 0 }),
  rootSessionId: Type.String({ minLength: 1 }),
  source: MainEventSourceSchema,
  event: Type.Unsafe<unknown>({
    type: 'object',
    additionalProperties: true,
    description: 'Opaque Pi SDK AgentSessionEvent or Main event object.',
  }),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Named shared definitions (also used by JSON Schema generation)
// ---------------------------------------------------------------------------

export const SHARED_CONTRACT_DEFS = {
  RpcId: RpcIdSchema,
  RpcResponseId: RpcResponseIdSchema,
  RpcRequest: RpcRequestSchema,
  RpcErrorBody: RpcErrorBodySchema,
  RpcSuccessResponse: RpcSuccessResponseSchema,
  RpcFailureResponse: RpcFailureResponseSchema,
  RpcResponse: RpcResponseSchema,
  RpcEventEnvelope: RpcEventEnvelopeSchema,
  RpcEventFrame: RpcEventFrameSchema,
  RpcServerFrame: RpcServerFrameSchema,
  ToolPermissionManagedState: ToolPermissionManagedStateSchema,
  ToolPermissionState: ToolPermissionStateSchema,
  ToolPermissionKind: ToolPermissionKindSchema,
  ToolPermissionCategory: ToolPermissionCategorySchema,
  ToolPermissionTarget: ToolPermissionTargetSchema,
  ToolPermissionEntry: ToolPermissionEntrySchema,
  ToolPermissionInfo: ToolPermissionInfoSchema,
  ToolPermissionChange: ToolPermissionChangeSchema,
  ToolPermissionSkip: ToolPermissionSkipSchema,
  ToolPermissionQueryResult: ToolPermissionQueryResultSchema,
  ToolPermissionSetResult: ToolPermissionSetResultSchema,
  ToolPermissionResetResult: ToolPermissionResetResultSchema,
  ActivationSkipReason: ActivationSkipReasonSchema,
  EnableResult: EnableResultSchema,
  CapabilityCategory: CapabilityCategorySchema,
  ToolStatus: ToolStatusSchema,
  ToolCatalogEntry: ToolCatalogEntrySchema,
  ToolCatalogResult: ToolCatalogResultSchema,
  ToolDetail: ToolDetailSchema,
  TerminalStatus: TerminalStatusSchema,
  JobStatus: JobStatusSchema,
  HistoryState: HistoryStateSchema,
  LifecycleError: LifecycleErrorSchema,
  HistoryBounds: HistoryBoundsSchema,
  BudgetPhase: BudgetPhaseSchema,
  BudgetTermination: BudgetTerminationSchema,
  BudgetTerminalError: BudgetTerminalErrorSchema,
  BudgetTerminal: BudgetTerminalSchema,
  BudgetSnapshot: BudgetSnapshotSchema,
  JobView: JobViewSchema,
  JobRecordView: JobRecordViewSchema,
  AgentKind: AgentKindSchema,
  DetailedAgentHistory: DetailedAgentHistorySchema,
  DetailedAgentItem: DetailedAgentItemSchema,
  CreatedAgentItem: CreatedAgentItemSchema,
  CreatedAgents: CreatedAgentsSchema,
  StopResult: StopResultSchema,
  MessageReceipt: MessageReceiptSchema,
  BroadcastReceipt: BroadcastReceiptSchema,
  CrossSessionReceipt: CrossSessionReceiptSchema,
  MessageSendResult: MessageSendResultSchema,
  NativeEntry: NativeEntrySchema,
  NativeMessage: NativeMessageSchema,
  NativePartial: NativePartialSchema,
  NativeSessionEvent: NativeSessionEventSchema,
  HistoryReadResult: HistoryReadResultSchema,
  StreamBoundary: StreamBoundarySchema,
  StreamSubscribeResult: StreamSubscribeResultSchema,
  StreamUnsubscribeResult: StreamUnsubscribeResultSchema,
  StreamSessionEvent: StreamSessionEventSchema,
  StreamJobEvent: StreamJobEventSchema,
  StreamEventPayload: StreamEventPayloadSchema,
  HarnessInfoResult: HarnessInfoResultSchema,
  NoParams: NoParamsSchema,
  ToolsCatalogParams: ToolsCatalogParamsSchema,
  ToolsDetailParams: ToolsDetailParamsSchema,
  TargetsParams: TargetsParamsSchema,
  PermissionQueryParams: PermissionQueryParamsSchema,
  JobsListParams: JobsListParamsSchema,
  JobIdParams: JobIdParamsSchema,
  SubagentTask: SubagentTaskSchema,
  SubagentCreateParams: SubagentCreateParamsSchema,
  SubagentStopParams: SubagentStopParamsSchema,
  MessageSendParams: MessageSendParamsSchema,
  StreamUnsubscribeParams: StreamUnsubscribeParamsSchema,
  AgentsTreeResult: AgentsTreeResultSchema,
  JobsListResult: JobsListResultSchema,
  JobGetResult: JobGetResultSchema,
  HarnessRpcRecord: HarnessRpcRecordSchema,
  ThinkingLevelName: ThinkingLevelNameSchema,
  CodemodeMode: CodemodeModeSchema,
  PresetModel: PresetModelSchema,
  PresetCodemode: PresetCodemodeSchema,
  PresetConfig: PresetConfigSchema,
  PresetCatalogItem: PresetCatalogItemSchema,
  PresetsCatalogResult: PresetsCatalogResultSchema,
  PresetSnapshot: PresetSnapshotSchema,
  PresetsCurrentResult: PresetsCurrentResultSchema,
  PresetApplyParams: PresetApplyParamsSchema,
  PresetIssueSeverity: PresetIssueSeveritySchema,
  PresetIssueKind: PresetIssueKindSchema,
  PresetIssue: PresetIssueSchema,
  PresetApplyProblem: PresetApplyProblemSchema,
  PresetApplyOutcome: PresetApplyOutcomeSchema,
  PresetClearOutcome: PresetClearOutcomeSchema,
  ShellApprovalDecision: ShellApprovalDecisionSchema,
  ShellApprovalPendingState: ShellApprovalPendingStateSchema,
  ShellApprovalPending: ShellApprovalPendingSchema,
  ApprovalsListResult: ApprovalsListResultSchema,
  ApprovalIdParams: ApprovalIdParamsSchema,
  ApprovalsGetResult: ApprovalsGetResultSchema,
  ApprovalRespondParams: ApprovalRespondParamsSchema,
  ShellApprovalRespondResult: ShellApprovalRespondResultSchema,
  ApprovalsSubscribeResult: ApprovalsSubscribeResultSchema,
  ApprovalsEvent: ApprovalsEventSchema,
  LiveSession: LiveSessionSchema,
  SessionsListResult: SessionsListResultSchema,
  SessionsConnectParams: SessionsConnectParamsSchema,
  SessionConnect: SessionConnectSchema,
  MainCapabilities: MainCapabilitiesSchema,
  MainSessionState: MainSessionStateSchema,
  MainStateResult: MainStateResultSchema,
  MainImageContent: MainImageContentSchema,
  MainInputParams: MainInputParamsSchema,
  MainInputDisposition: MainInputDispositionSchema,
  MainInputResult: MainInputResultSchema,
  MainRequestedResult: MainRequestedResultSchema,
  MainCompactParams: MainCompactParamsSchema,
  MainCompactResult: MainCompactResultSchema,
  MainNavigateParams: MainNavigateParamsSchema,
  MainNewParams: MainNewParamsSchema,
  MainSwitchParams: MainSwitchParamsSchema,
  MainForkParams: MainForkParamsSchema,
  MainOutcomeResult: MainOutcomeResultSchema,
  MainSubscribeResult: MainSubscribeResultSchema,
  MainEventSource: MainEventSourceSchema,
  MainEventPayload: MainEventPayloadSchema,
} as const;

export type ContractDefName = keyof typeof SHARED_CONTRACT_DEFS;

// ---------------------------------------------------------------------------
// Single-source contract definition map
// ---------------------------------------------------------------------------

interface MethodContractEntry<
  TParams extends TSchema = TSchema,
  TResult extends TSchema = TSchema,
  TRequired extends boolean = boolean,
> {
  readonly description: string;
  readonly params: TParams;
  readonly result: TResult;
  readonly paramsRequired: TRequired;
  readonly defNames: {
    readonly params: ContractDefName;
    readonly result: ContractDefName;
  };
}

/**
 * The single contract map for all Harness RPC methods.
 * Adding or updating a method here drives method lookup, Static types,
 * runtime JIT parameter/result validation, JSON Schema generation, and the
 * typed client.
 */
function defineMethod<const P extends ContractDefName, const R extends ContractDefName, const Required extends boolean>(entry: {
  readonly description: string; readonly params: P; readonly result: R; readonly paramsRequired: Required;
}) {
  return { ...entry, params: SHARED_CONTRACT_DEFS[entry.params], result: SHARED_CONTRACT_DEFS[entry.result],
    defNames: { params: entry.params, result: entry.result } };
}

export const HARNESS_RPC_CONTRACT = {
  [RPC_METHODS.info]: defineMethod({
    description: 'Return protocol version, root session ID and host PID.',
    params: 'NoParams', result: 'HarnessInfoResult', paramsRequired: false,
  }),
  [RPC_METHODS.toolsCatalog]: defineMethod({
    description: 'Query registered tools and capabilities with independent runtime and permission facts.',
    params: 'ToolsCatalogParams', result: 'ToolCatalogResult', paramsRequired: false,
  }),
  [RPC_METHODS.toolsDetail]: defineMethod({
    description: 'Return runtime status, permission state and parameter schema for one registered tool.',
    params: 'ToolsDetailParams', result: 'ToolDetail', paramsRequired: true,
  }),
  [RPC_METHODS.toolsEnable]: defineMethod({
    description: 'User control-plane enable and activation of capability targets.',
    params: 'TargetsParams', result: 'EnableResult', paramsRequired: true,
  }),
  [RPC_METHODS.permissionQuery]: defineMethod({
    description: 'Query effective branch tool permissions matching an expression.',
    params: 'PermissionQueryParams', result: 'ToolPermissionQueryResult', paramsRequired: false,
  }),
  [RPC_METHODS.permissionEnable]: defineMethod({
    description: 'Set explicit branch permission state to enabled for the given targets.',
    params: 'TargetsParams', result: 'ToolPermissionSetResult', paramsRequired: true,
  }),
  [RPC_METHODS.permissionDisable]: defineMethod({
    description: 'Set explicit branch permission state to disabled for the given targets.',
    params: 'TargetsParams', result: 'ToolPermissionSetResult', paramsRequired: true,
  }),
  [RPC_METHODS.permissionReset]: defineMethod({
    description: 'Clear explicit branch management for the given targets.',
    params: 'TargetsParams', result: 'ToolPermissionResetResult', paramsRequired: true,
  }),
  [RPC_METHODS.agentsTree]: defineMethod({
    description: 'Return the full agent tree and history directories for the root session.',
    params: 'NoParams', result: 'AgentsTreeResult', paramsRequired: false,
  }),
  [RPC_METHODS.jobsList]: defineMethod({
    description: 'List Job runtime views, optionally filtered by jobIds.',
    params: 'JobsListParams', result: 'JobsListResult', paramsRequired: false,
  }),
  [RPC_METHODS.jobsGet]: defineMethod({
    description: 'Return one Job view and its settled record (or null while running).',
    params: 'JobIdParams', result: 'JobGetResult', paramsRequired: true,
  }),
  [RPC_METHODS.jobsResult]: defineMethod({
    description: 'Return the settled Job record, or fail with not_found / not_ready.',
    params: 'JobIdParams', result: 'JobRecordView', paramsRequired: true,
  }),
  [RPC_METHODS.subagentCreate]: defineMethod({
    description: 'Create background subagents for a batch of tasks with host-bound origin.',
    params: 'SubagentCreateParams', result: 'CreatedAgents', paramsRequired: true,
  }),
  [RPC_METHODS.subagentStop]: defineMethod({
    description: 'Request cancellation of a subagent by ID.',
    params: 'SubagentStopParams', result: 'StopResult', paramsRequired: true,
  }),
  [RPC_METHODS.messageSend]: defineMethod({
    description: 'Send a managed message to an agent, child broadcast endpoint or another session Main.',
    params: 'MessageSendParams', result: 'MessageSendResult', paramsRequired: true,
  }),
  [RPC_METHODS.historyRead]: defineMethod({
    description: 'Read a Job native entry interval from recorded storage and live bounds.',
    params: 'JobIdParams', result: 'HistoryReadResult', paramsRequired: true,
  }),
  [RPC_METHODS.streamSubscribe]: defineMethod({
    description: 'Subscribe to a Job live event stream and capture a consistent boundary snapshot.',
    params: 'JobIdParams', result: 'StreamSubscribeResult', paramsRequired: true,
  }),
  [RPC_METHODS.streamUnsubscribe]: defineMethod({
    description: 'Detach a subscription from the current RPC connection.',
    params: 'StreamUnsubscribeParams', result: 'StreamUnsubscribeResult', paramsRequired: true,
  }),
  [RPC_METHODS.presetsCatalog]: defineMethod({
    description: 'Load and return the merged global/project preset catalog and parse warnings.',
    params: 'NoParams', result: 'PresetsCatalogResult', paramsRequired: false,
  }),
  [RPC_METHODS.presetsCurrent]: defineMethod({
    description: 'Return the currently active branch preset snapshot, or null.',
    params: 'NoParams', result: 'PresetsCurrentResult', paramsRequired: false,
  }),
  [RPC_METHODS.presetsApply]: defineMethod({
    description: 'Resolve and apply a named preset to the current session.',
    params: 'PresetApplyParams', result: 'PresetApplyOutcome', paramsRequired: true,
  }),
  [RPC_METHODS.presetsClear]: defineMethod({
    description: 'Clear the active preset from branch management without rolling back model/thinking/tools.',
    params: 'NoParams', result: 'PresetClearOutcome', paramsRequired: false,
  }),
  [RPC_METHODS.approvalsList]: defineMethod({
    description: 'List pending shell approval requests on the root approval controller.',
    params: 'NoParams', result: 'ApprovalsListResult', paramsRequired: false,
  }),
  [RPC_METHODS.approvalsGet]: defineMethod({
    description: 'Return one pending shell approval request by id, or null.',
    params: 'ApprovalIdParams', result: 'ApprovalsGetResult', paramsRequired: true,
  }),
  [RPC_METHODS.approvalsRespond]: defineMethod({
    description: 'Respond to a pending shell approval request with allow or deny.',
    params: 'ApprovalRespondParams', result: 'ShellApprovalRespondResult', paramsRequired: true,
  }),
  [RPC_METHODS.approvalsSubscribe]: defineMethod({
    description: 'Subscribe to pending shell approval snapshot updates and return the current snapshot.',
    params: 'NoParams', result: 'ApprovalsSubscribeResult', paramsRequired: false,
  }),
  [RPC_METHODS.sessionsList]: defineMethod({
    description: 'List live peer sessions published in the shared socket directory.',
    params: 'NoParams', result: 'SessionsListResult', paramsRequired: false,
  }),
  [RPC_METHODS.sessionsConnect]: defineMethod({
    description: 'Make one live peer session reachable from this session through the shared enable path.',
    params: 'SessionsConnectParams', result: 'SessionConnect', paramsRequired: true,
  }),
  [RPC_METHODS.mainState]: defineMethod({
    description: 'Return the current Main binding generation, session state and capability flags.',
    params: 'NoParams', result: 'MainStateResult', paramsRequired: false,
  }),
  [RPC_METHODS.mainInput]: defineMethod({
    description: 'Submit input to Main and report admission disposition for the current binding generation.',
    params: 'MainInputParams', result: 'MainInputResult', paramsRequired: true,
  }),
  [RPC_METHODS.mainInterrupt]: defineMethod({
    description: 'Request interruption of the current Main run.',
    params: 'NoParams', result: 'MainRequestedResult', paramsRequired: false,
  }),
  [RPC_METHODS.mainCompact]: defineMethod({
    description: 'Run compaction on Main and report whether compaction completed plus the opaque SDK result.',
    params: 'MainCompactParams', result: 'MainCompactResult', paramsRequired: false,
  }),
  [RPC_METHODS.mainNavigate]: defineMethod({
    description: 'Navigate the Main session tree to targetId.',
    params: 'MainNavigateParams', result: 'MainOutcomeResult', paramsRequired: true,
  }),
  [RPC_METHODS.mainReload]: defineMethod({
    description: 'Request reload of the Main session.',
    params: 'NoParams', result: 'MainRequestedResult', paramsRequired: false,
  }),
  [RPC_METHODS.mainNew]: defineMethod({
    description: 'Create a new Main session via the bound session runtime.',
    params: 'MainNewParams', result: 'MainOutcomeResult', paramsRequired: false,
  }),
  [RPC_METHODS.mainSwitch]: defineMethod({
    description: 'Switch the Main session to another session file via the bound session runtime.',
    params: 'MainSwitchParams', result: 'MainOutcomeResult', paramsRequired: true,
  }),
  [RPC_METHODS.mainFork]: defineMethod({
    description: 'Fork the Main session from entryId via the bound session runtime.',
    params: 'MainForkParams', result: 'MainOutcomeResult', paramsRequired: true,
  }),
  [RPC_METHODS.mainSubscribe]: defineMethod({
    description: 'Subscribe to Main session events for the current RPC connection.',
    params: 'NoParams', result: 'MainSubscribeResult', paramsRequired: false,
  }),
} as const satisfies Record<RpcMethod, MethodContractEntry>;

// ---------------------------------------------------------------------------
// Inferred TypeScript contract types
// ---------------------------------------------------------------------------

export type RpcContract = typeof HARNESS_RPC_CONTRACT;

export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T :
  T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } :
  T;

export type MethodParams<M extends RpcMethod> = Static<RpcContract[M]['params']>;
export type MethodResult<M extends RpcMethod> = DeepReadonly<Static<RpcContract[M]['result']>>;

export type MethodCallArgs<M extends RpcMethod> =
  RpcContract[M]['paramsRequired'] extends false
    ? [params?: MethodParams<M> | null]
    : [params: MethodParams<M>];

export type ToolStatus = DeepReadonly<Static<typeof ToolStatusSchema>>;
export type ToolCatalogEntry = DeepReadonly<Static<typeof ToolCatalogEntrySchema>>;
export type ToolCatalogResult = DeepReadonly<Static<typeof ToolCatalogResultSchema>>;
export type ToolDetail = DeepReadonly<Static<typeof ToolDetailSchema>>;
export type EnableResult = DeepReadonly<Static<typeof EnableResultSchema>>;
export type ToolPermissionQueryResult = DeepReadonly<Static<typeof ToolPermissionQueryResultSchema>>;
export type ToolPermissionSetResult = DeepReadonly<Static<typeof ToolPermissionSetResultSchema>>;
export type ToolPermissionResetResult = DeepReadonly<Static<typeof ToolPermissionResetResultSchema>>;
export type DetailedAgentItem = DeepReadonly<Static<typeof DetailedAgentItemSchema>>;
export type JobView = DeepReadonly<Static<typeof JobViewSchema>>;
export type JobRecordView = DeepReadonly<Static<typeof JobRecordViewSchema>>;
export type CreatedAgents = DeepReadonly<Static<typeof CreatedAgentsSchema>>;
export type StopResult = DeepReadonly<Static<typeof StopResultSchema>>;
export type MessageSendResult = DeepReadonly<Static<typeof MessageSendResultSchema>>;
export type HistoryReadResult = DeepReadonly<Static<typeof HistoryReadResultSchema>>;
export type StreamBoundary = DeepReadonly<Static<typeof StreamBoundarySchema>>;
export type StreamSubscribeResult = DeepReadonly<Static<typeof StreamSubscribeResultSchema>>;
export type StreamUnsubscribeResult = DeepReadonly<Static<typeof StreamUnsubscribeResultSchema>>;
export type StreamEventPayload = DeepReadonly<Static<typeof StreamEventPayloadSchema>>;
export type HarnessInfoResult = DeepReadonly<Static<typeof HarnessInfoResultSchema>>;
export type HarnessRpcRecord = DeepReadonly<Static<typeof HarnessRpcRecordSchema>>;
export type ThinkingLevelName = DeepReadonly<Static<typeof ThinkingLevelNameSchema>>;
export type CodemodeMode = DeepReadonly<Static<typeof CodemodeModeSchema>>;
export type PresetModel = DeepReadonly<Static<typeof PresetModelSchema>>;
export type PresetConfig = DeepReadonly<Static<typeof PresetConfigSchema>>;
export type PresetCatalogItem = DeepReadonly<Static<typeof PresetCatalogItemSchema>>;
export type PresetsCatalogResult = DeepReadonly<Static<typeof PresetsCatalogResultSchema>>;
export type PresetSnapshot = DeepReadonly<Static<typeof PresetSnapshotSchema>>;
export type PresetsCurrentResult = DeepReadonly<Static<typeof PresetsCurrentResultSchema>>;
export type PresetIssue = DeepReadonly<Static<typeof PresetIssueSchema>>;
export type PresetApplyProblem = DeepReadonly<Static<typeof PresetApplyProblemSchema>>;
export type PresetApplyOutcome = DeepReadonly<Static<typeof PresetApplyOutcomeSchema>>;
export type PresetClearOutcome = DeepReadonly<Static<typeof PresetClearOutcomeSchema>>;
export type ShellApprovalDecision = DeepReadonly<Static<typeof ShellApprovalDecisionSchema>>;
export type ShellApprovalPending = DeepReadonly<Static<typeof ShellApprovalPendingSchema>>;
export type ApprovalsListResult = DeepReadonly<Static<typeof ApprovalsListResultSchema>>;
export type ApprovalsGetResult = DeepReadonly<Static<typeof ApprovalsGetResultSchema>>;
export type ShellApprovalRespondResult = DeepReadonly<Static<typeof ShellApprovalRespondResultSchema>>;
export type ApprovalsSubscribeResult = DeepReadonly<Static<typeof ApprovalsSubscribeResultSchema>>;
export type ApprovalsEvent = DeepReadonly<Static<typeof ApprovalsEventSchema>>;
export type LiveSession = DeepReadonly<Static<typeof LiveSessionSchema>>;
export type SessionsListResult = DeepReadonly<Static<typeof SessionsListResultSchema>>;
export type SessionConnect = DeepReadonly<Static<typeof SessionConnectSchema>>;
export type MainCapabilities = DeepReadonly<Static<typeof MainCapabilitiesSchema>>;
export type MainSessionState = DeepReadonly<Static<typeof MainSessionStateSchema>>;
export type MainStateResult = DeepReadonly<Static<typeof MainStateResultSchema>>;
export type MainImageContent = DeepReadonly<Static<typeof MainImageContentSchema>>;
export type MainInputDisposition = DeepReadonly<Static<typeof MainInputDispositionSchema>>;
export type MainInputResult = DeepReadonly<Static<typeof MainInputResultSchema>>;
export type MainRequestedResult = DeepReadonly<Static<typeof MainRequestedResultSchema>>;
export type MainCompactResult = DeepReadonly<Static<typeof MainCompactResultSchema>>;
export type MainOutcomeResult = DeepReadonly<Static<typeof MainOutcomeResultSchema>>;
export type MainSubscribeResult = DeepReadonly<Static<typeof MainSubscribeResultSchema>>;
export type MainEventSource = DeepReadonly<Static<typeof MainEventSourceSchema>>;
export type MainEventPayload = DeepReadonly<Static<typeof MainEventPayloadSchema>>;

export type NoParams = Static<typeof NoParamsSchema>;
export type ToolsCatalogParams = Static<typeof ToolsCatalogParamsSchema>;
export type ToolsDetailParams = Static<typeof ToolsDetailParamsSchema>;
export type TargetsParams = Static<typeof TargetsParamsSchema>;
export type PermissionQueryParams = Static<typeof PermissionQueryParamsSchema>;
export type JobsListParams = Static<typeof JobsListParamsSchema>;
export type JobIdParams = Static<typeof JobIdParamsSchema>;
export type SubagentTask = Static<typeof SubagentTaskSchema>;
export type SubagentCreateParams = Static<typeof SubagentCreateParamsSchema>;
export type SubagentStopParams = Static<typeof SubagentStopParamsSchema>;
export type MessageSendParams = Static<typeof MessageSendParamsSchema>;
export type StreamUnsubscribeParams = Static<typeof StreamUnsubscribeParamsSchema>;
export type PresetApplyParams = Static<typeof PresetApplyParamsSchema>;
export type ApprovalIdParams = Static<typeof ApprovalIdParamsSchema>;
export type ApprovalRespondParams = Static<typeof ApprovalRespondParamsSchema>;
export type SessionsConnectParams = Static<typeof SessionsConnectParamsSchema>;
export type MainInputParams = Static<typeof MainInputParamsSchema>;
export type MainCompactParams = Static<typeof MainCompactParamsSchema>;
export type MainNavigateParams = Static<typeof MainNavigateParamsSchema>;
export type MainNewParams = Static<typeof MainNewParamsSchema>;
export type MainSwitchParams = Static<typeof MainSwitchParamsSchema>;
export type MainForkParams = Static<typeof MainForkParamsSchema>;

// ---------------------------------------------------------------------------
// Startup-JIT compiled validation
// ---------------------------------------------------------------------------

export type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

interface CompiledMethodValidator {
  readonly params: Validator<TProperties, TSchema>;
  readonly result: Validator<TProperties, TSchema>;
  readonly paramsRequired: boolean;
}

const idValidator = Compile(RpcIdSchema);

const compiledValidators = new Map<RpcMethod, CompiledMethodValidator>();
for (const [method, contract] of Object.entries(HARNESS_RPC_CONTRACT) as Array<[RpcMethod, MethodContractEntry]>) {
  compiledValidators.set(method, {
    params: Compile(contract.params),
    result: Compile(contract.result),
    paramsRequired: contract.paramsRequired,
  });
}

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === 'string' && compiledValidators.has(value as RpcMethod);
}

export function validateRpcId(id: unknown): id is RpcId {
  return idValidator.Check(id);
}

function formatErrors(errors: Iterable<{ readonly instancePath: string; readonly message: string }>): string[] {
  const formatted: string[] = [];
  for (const error of errors) {
    formatted.push(`${error.instancePath || '/'}: ${error.message}`);
  }
  return formatted;
}

export function validateMethodParams<M extends RpcMethod>(
  method: M,
  params: unknown,
): ValidationOutcome<MethodParams<M>> {
  const validator = compiledValidators.get(method);
  if (validator === undefined) {
    return { ok: false, errors: [`Unknown method "${method}".`] };
  }
  if (params === undefined || params === null) {
    if (!validator.paramsRequired) {
      return { ok: true, value: {} as MethodParams<M> };
    }
    return { ok: false, errors: [`Method "${method}" requires a JSON object "params".`] };
  }
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, errors: ['Request params must be a JSON object.'] };
  }
  if (validator.params.Check(params)) {
    return { ok: true, value: params as MethodParams<M> };
  }
  return { ok: false, errors: formatErrors(validator.params.Errors(params)) };
}

export function parseMethodParams<M extends RpcMethod>(method: M, params: unknown): MethodParams<M> {
  const outcome = validateMethodParams(method, params);
  if (outcome.ok) return outcome.value;
  throw new RpcRequestError(
    RPC_ERROR.invalidRequest,
    `Invalid parameters for "${method}": ${outcome.errors.join('; ')}`,
    outcome.errors,
  );
}

export function validateMethodResult<M extends RpcMethod>(
  method: M,
  result: unknown,
): ValidationOutcome<MethodResult<M>> {
  const validator = compiledValidators.get(method);
  if (validator === undefined) {
    return { ok: false, errors: [`Unknown method "${method}".`] };
  }
  if (validator.result.Check(result)) {
    return { ok: true, value: result as MethodResult<M> };
  }
  return { ok: false, errors: formatErrors(validator.result.Errors(result)) };
}
