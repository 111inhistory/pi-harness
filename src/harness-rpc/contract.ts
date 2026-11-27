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
// Tool management: base members, dynamic activation and blacklist
// ---------------------------------------------------------------------------

export const CapabilityCategorySchema = Type.Union([
  Type.Literal('tool'),
  Type.Literal('mcp'),
  Type.Literal('namespace'),
]);

export const ToolTargetKindSchema = Type.Union([
  Type.Literal('tool'),
  Type.Literal('mcp'),
  Type.Literal('namespace'),
  Type.Literal('prefix'),
], description('Target grammar kind; "prefix" is the config-default `foo*` form.'));

const toolTargetFields = {
  target: Type.String({ minLength: 1, description: 'The user-facing target string, e.g. "read", "mcp://git", "namespace://subagent", "mcp__prod__*".' }),
  kind: ToolTargetKindSchema,
  name: Type.String({ minLength: 1, description: 'The parsed name after the scheme/prefix marker.' }),
  id: Type.String({ minLength: 1, description: 'Stable internal identity: `${kind}:${name}`.' }),
};

export const ToolTargetSchema = Type.Object(toolTargetFields);

export const ToolTargetChangeSchema = Type.Object({
  ...toolTargetFields,
  affectedTools: stringArray(),
}, { additionalProperties: false, description: 'One target a write applied to, with the registered tools it currently hits.' });

export const ToolWriteSkipSchema = Type.Object({
  target: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const ToolWriteContainerSchema = Type.Object({
  target: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal('namespace'), Type.Literal('mcp')]),
  name: Type.String({ minLength: 1 }),
  id: Type.String({ minLength: 1 }),
  explicit: Type.Boolean(description('True for a [ns] selection marker: the container was loaded without default expansion.')),
  members: stringArray(description('Concrete members this write selected under the container.')),
}, { additionalProperties: false, description: 'One namespace or MCP container selected by a write, kept separate from concrete tool targets.' });

export const ToolBatchRejectionCodeSchema = Type.Union([
  Type.Literal('selection_not_supported'),
  Type.Literal('no_schema_unsupported'),
  Type.Literal('conflicting_schema_modes'),
  Type.Literal('invalid_selection'),
  Type.Literal('container_without_members'),
  Type.Literal('foreign_member'),
  Type.Literal('blocked_selection'),
  Type.Literal('empty_selection'),
]);

export const ToolBatchRejectionSchema = Type.Object({
  code: ToolBatchRejectionCodeSchema,
  targets: stringArray(description('Container or selection tokens that caused the whole-batch refusal.')),
  members: stringArray(description('Currently registered members considered for the refused selection.')),
  reason: Type.Optional(Type.Union([
    Type.Literal('codemode_unavailable'),
    Type.Literal('mode_not_only'),
    Type.Literal('tool_not_codemode_callable'),
  ], { description: 'Concise reason for a no_schema_unsupported refusal; no separate error channel.' })),
}, { additionalProperties: false, description: 'Whole-batch refusal; null means the write was considered normally. Nothing is written or applied when this is set.' });

export const ToolBlacklistSourceSchema = Type.Union([
  Type.Literal('startup'),
  Type.Literal('preset'),
  Type.Literal('branch'),
], description('Where a blacklist contribution comes from. A branch blacklist remove clears branch and startup/config contributions at the current branch position; a current preset contribution remains until switch/clear and SDK hard limits are unchanged.'));

export const ToolBaseSourceSchema = Type.Union([
  Type.Literal('baseline'),
  Type.Literal('preset'),
  Type.Literal('branch'),
], description('Where a base membership currently comes from.'));

export const ToolCollectionTargetSchema = Type.Object({
  target: ToolTargetSchema,
  sources: Type.Array(ToolBaseSourceSchema, description('Base sources that currently contribute this target.')),
  affectedTools: stringArray(),
}, { additionalProperties: false });

export const ToolWriteActionSchema = Type.Union([
  Type.Literal('base-add'),
  Type.Literal('base-remove'),
  Type.Literal('activate'),
  Type.Literal('deactivate'),
  Type.Literal('blacklist-add'),
  Type.Literal('blacklist-remove'),
], description('The membership write that produced this result.'));

export const ToolWriteResultSchema = Type.Object({
  action: ToolWriteActionSchema,
  changed: Type.Array(ToolTargetChangeSchema),
  alreadySet: stringArray(description('Targets already in the requested membership state.')),
  unresolved: stringArray(),
  skipped: Type.Array(ToolWriteSkipSchema),
  affectedTools: stringArray(),
  selected: stringArray(description('Concrete positive members resolved by this batch, including snapshot-expanded container members.')),
  noSchema: stringArray(description('Selected names whose latest explicit modifier requests schema on demand (lazy).')),
  schema: stringArray(description('Selected names whose latest explicit modifier requests schema-backed (no-lazy).')),
  schemaWithheld: stringArray(description('Selected names whose schema is actually withheld now by the live only-mode projection.')),
  containers: Type.Array(ToolWriteContainerSchema, description('Containers loaded or selected by this batch; never represented as fake tools.')),
  excluded: stringArray(description('Exact -name exclusions applied to this selection only; they are neither blacklist writes nor membership removals.')),
  rejected: nullable(ToolBatchRejectionSchema),
  activated: stringArray(description('Tools activated by a base add or activation.')),
  alreadyActive: stringArray(),
  removedActive: stringArray(description('Codemode-only members removed from the active set immediately.')),
  pendingCompaction: stringArray(description('Declared members whose declaration survives until the next successful compaction.')),
  noticed: stringArray(description('Used tools that received one model-facing notice for this change.')),
  notRequested: stringArray(description('Targets with no preserved base/dynamic membership after a deactivation or blacklist removal.')),
  stillBlacklisted: stringArray(description('Affected tools still covered by a raw blacklist source after the write; preset contributions and SDK hard limits are not lifted.')),
  banOverridden: stringArray(description('Affected tools whose raw startup/preset ban is retained but overridden by an explicit selection; a manual branch ban is never overridden.')),
  remainingSources: Type.Array(ToolBlacklistSourceSchema, description('Blacklist sources still effective for the affected targets after the write.')),
  recordError: nullable(Type.String(description('Set when the membership record could not be written; effects are then not applied.'))),
  effectError: nullable(Type.String(description('Set when the membership record was written but applying an SDK/active-set effect failed; nothing is rolled back.'))),
}, { additionalProperties: false, description: 'Shared result for base, dynamic and blacklist membership writes.' });

export const ToolBaseListResultSchema = Type.Object({
  targets: Type.Array(ToolCollectionTargetSchema),
}, { additionalProperties: false, description: 'Recorded base targets with their current registered members.' });

export const ToolBlacklistTargetSchema = Type.Object({
  target: ToolTargetSchema,
  affectedTools: stringArray(),
  sources: Type.Array(ToolBlacklistSourceSchema),
}, { additionalProperties: false, description: 'One effective blacklist target and every source currently contributing it.' });

export const ToolBlacklistListResultSchema = Type.Object({
  entries: Type.Array(ToolBlacklistTargetSchema),
}, { additionalProperties: false });

const toolStatusFields = {
  registered: Type.Boolean(description('Registered on the host; not a guarantee that this scope may use it.')),
  eligible: Type.Boolean(description('Scope-level eligibility for the candidate catalog.')),
  base: Type.Boolean(description('An effective base target currently covers this tool.')),
  dynamic: Type.Boolean(description('Recorded dynamic activation currently covers this tool.')),
  active: Type.Boolean(description('Live SDK active-set membership; independent of base/dynamic/blacklist.')),
  blacklisted: Type.Boolean(description('Raw local blacklist fact; a base member does not delete it.')),
  blocked: Type.Boolean(description('Effective blacklist prohibition after an explicit-selection override of a startup/preset ban; manual branch bans and outer ancestor bans always block.')),
  banOverridden: Type.Boolean(description('A raw startup/preset ban is retained but currently overridden by an explicit selection; a manual branch ban is never overridden.')),
  activatable: Type.Boolean(description('Registered and scope-eligible, not blacklisted, and available for self-loading.')),
  usable: Type.Boolean(description('Actually callable now after base/dynamic/blacklist and registration/scope/SDK constraints.')),
  blacklistSources: Type.Array(ToolBlacklistSourceSchema, description('Every source contributing to the blacklist for this tool.')),
  schemaMode: Type.Union([Type.Literal('no-schema'), Type.Literal('schema'), Type.Null()], description('Latest explicit branch schema override; null means none.')),
  configLazy: Type.Boolean(description('Configured lazy default explicitly matches this tool or group; independent of the branch override and actual projection.')),
  schemaWithheld: Type.Boolean(description('The schema is actually withheld now by the live only-mode projection.')),
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
  address: Type.String({ minLength: 1, description: 'The Agent logical address of this Job.' }),
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
  address: Type.String({ minLength: 1 }),
  name: nullable(Type.String()),
  round: Type.Integer({ minimum: 0 }),
  goal: Type.String({ description: "The Agent's persistent goal; continuations repeat it." }),
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
  summary: Type.String(),
  cleanJsonl: Type.String(),
  result: Type.Optional(Type.String()),
}, {
  additionalProperties: true,
  description: 'Job history paths; extra path keys may be present.',
});

/**
 * One live activity snapshot of an Agent. `thinking`, `output` and `tool_call`
 * are SDK-event phases; the remaining states are runtime-owned. No phase is
 * inferred from text and nothing here is persisted per token.
 */

export const DetailedAgentItemSchema = Type.Cyclic({
  DetailedAgentItem: Type.Object({
    id: Type.String({ minLength: 1 }),
    address: Type.String({ minLength: 1, description: 'Logical address <sessionHex>:<key>; Main is <sessionHex>:main.' }),
    name: nullable(Type.String()),
    status: Type.String({ minLength: 1, description: 'Lifecycle status: running, idle, stopped(failed), stopped(cancelled) or stopped(unknown); a streaming run may add a phase such as running(thinking) or running(tool-12s).' }),
    role: Type.Optional(nullable(Type.String())),
    children: Type.Array(Type.Ref('DetailedAgentItem')),
    kind: Type.Optional(AgentKindSchema),
    history: Type.Optional(DetailedAgentHistorySchema),
    historyError: Type.Optional(LifecycleErrorSchema),
  }, { additionalProperties: false, description: 'Agent tree node; the Main node has no kind.' }),
}, 'DetailedAgentItem');

export const CreatedAgentItemSchema = Type.Object({
  id: Type.String({ minLength: 1, description: 'Local actor key; its full address is the messaging and signal target.' }),
  address: Type.String({ minLength: 1 }),
  name: nullable(Type.String()),
}, { additionalProperties: false });

export const CreatedBatchSchema = Type.Object({
  address: Type.String({ minLength: 1, description: 'Logical batch address <sessionHex>:batch_<n>.' }),
  items: Type.Array(CreatedAgentItemSchema),
  warnings: Type.Optional(stringArray()),
}, { additionalProperties: false });

export const SignalTargetSchema = Type.Object({
  address: Type.String({ minLength: 1 }),
  ok: Type.Boolean(),
  status: Type.String(),
  reason: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const SignalResultSchema = Type.Object({
  ok: Type.Boolean(),
  action: Type.Union([Type.Literal('interrupt'), Type.Literal('stop')]),
  to: Type.String({ minLength: 1 }),
  targets: Type.Array(SignalTargetSchema),
}, { additionalProperties: false });

export const MessageReceiptSchema = Type.Object({
  ok: Type.Literal(true),
  to: Type.String({ minLength: 1 }),
  jobId: nullable(Type.String()),
}, { additionalProperties: false });

export const BroadcastReceiptSchema = Type.Object({
  ok: Type.Boolean(),
  to: Type.String({ minLength: 1, description: 'The group or children address the broadcast was sent to.' }),
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
  to: Type.String({ minLength: 1 }),
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
  description: 'Pi AgentSessionEvent from @earendil-works/pi-coding-agent@1.6.1 (dist/core/agent-session.d.ts:49). Except message_update, the native event passes through unchanged; assistant message_update drops the top-level message and assistantMessageEvent.partial, keeps usage, and toolcall_start adds id/toolName when resolvable.',
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
  includeActivatable: Type.Optional(Type.Boolean({ description: 'Expand the requested membership with registered, scope-eligible tools available for self-loading.' })),
  includeUsable: Type.Optional(Type.Boolean({ description: 'Filter to currently usable tools (requested, eligible, registered, active, not blacklisted). With includeActivatable, list the union of both populations.' })),
}, { additionalProperties: true });

export const ToolsDetailParamsSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

export const TargetsParamsSchema = Type.Object({
  targets: stringArray({ minItems: 1 }),
}, { additionalProperties: true });

export const JobsListParamsSchema = Type.Object({
  jobIds: Type.Optional(stringArray()),
}, { additionalProperties: true });

export const JobIdParamsSchema = Type.Object({
  jobId: Type.String({ minLength: 1 }),
}, { additionalProperties: true });

export const SubagentAgentSchema = Type.Object({
  name: Type.Optional(Type.String()),
  goal: Type.String({ minLength: 1 }),
  inheritContext: Type.Optional(Type.Boolean()),
}, {
  additionalProperties: false,
  description: 'One declared batch member; the domain rejects unknown fields.',
});

export const SubagentCreateParamsSchema = Type.Object({
  context: Type.Optional(Type.String()),
  agents: Type.Array(SubagentAgentSchema, { minItems: 1 }),
}, { additionalProperties: true });

export const SubagentSignalParamsSchema = Type.Object({
  target: Type.String({ minLength: 1, description: 'One full logical address; a group or children address signals every other member of it.' }),
  action: Type.Union([Type.Literal('interrupt'), Type.Literal('stop')]),
}, { additionalProperties: true });

export const MessageSendParamsSchema = Type.Object({
  to: Type.String({ minLength: 1, description: 'One logical Agent address: <sessionHex>:main, <sessionHex>:sub_<batch>[-<member>], <sessionHex>:batch_<batch>, or <sessionHex>:<agent>/children. Never a socket path.' }),
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

/**
 * Normalized tool intent recorded with a snapshot. `none` is an undeclared
 * selection; `modifiers` keeps the literal +/- operations; `replace` is a plain
 * name replacement. The resolved projection travels separately in `tools`.
 */
export const PresetToolSelectionSchema = Type.Union([
  Type.Object({
    kind: Type.Literal('none'),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('modifiers'),
    add: stringArray(),
    remove: stringArray(),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('replace'),
    names: stringArray(),
  }, { additionalProperties: false }),
]);

export const PresetVersionStatusSchema = Type.Union([
  Type.Literal('current'),
  Type.Literal('outdated'),
  Type.Literal('missing'),
  Type.Literal('unresolvable'),
]);

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
  tools: Type.Optional(stringArray(description('Resolved tool-name projection against the nominal candidate baseline.'))),
  disabledTools: Type.Optional(stringArray(description('Current-preset blacklist projection: the explicit final minus names.'))),
  codemode: Type.Optional(PresetCodemodeSchema),
  instructions: nullable(Type.String()),
  contentHash: Type.String(description('Deterministic hash of the semantic preset content; equal hashes are interchangeable versions.')),
  toolSelection: PresetToolSelectionSchema,
}, { additionalProperties: false });

export const PresetsCurrentResultSchema = Type.Object({
  preset: nullable(PresetSnapshotSchema),
  status: nullable(PresetVersionStatusSchema),
  currentVersion: nullable(Type.String(description('Candidate contentHash from the current catalog; null for missing or unresolvable candidates.'))),
  changes: stringArray(description('One short summary per differing field or tool-name delta; empty when current, missing or unresolvable.')),
}, { additionalProperties: false });

const hookId = Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' });
const hookSource = Type.Union([Type.Literal('global'), Type.Literal('preset'), Type.Literal('project')]);
const hookAction = Type.Union([Type.Literal('injectHint'), Type.Literal('injectSection'), Type.Literal('activate'), Type.Literal('discoverCapability')]);
const hookRuleSummary = Type.Object({
  id: hookId, source: hookSource,
  on: Type.Union([Type.Literal('before_agent_start'), Type.Literal('tool_result')]),
  hasWhen: Type.Boolean(),
  classifyKind: nullable(Type.Union([Type.Literal('bool'), Type.Literal('score'), Type.Literal('choice')])),
  actionTypes: Type.Array(hookAction, { uniqueItems: true }),
  hasRepeat: Type.Boolean(), observeOnly: Type.Boolean(), muted: Type.Boolean(), active: Type.Boolean(),
}, { additionalProperties: false });
const hookWarning = Type.Object({
  scope: hookSource, id: Type.Optional(hookId),
  code: Type.Union([Type.Literal('version_invalid'), Type.Literal('layer_invalid'), Type.Literal('when_invalid'), Type.Literal('classifier_unconfigured')]),
}, { additionalProperties: false });
export const HooksCurrentResultSchema = Type.Object({
  valid: Type.Boolean(), preset: nullable(Type.String()), classifierConfigured: Type.Boolean(),
  rules: Type.Array(hookRuleSummary), disabled: Type.Array(hookId), muted: Type.Array(hookId), warnings: Type.Array(hookWarning),
}, { additionalProperties: false });

const hookCount = Type.Integer({ minimum: 0 });
const hookCounters = {
  matched: hookCount, committed: hookCount, observed: hookCount, suppressed: hookCount,
  timeout: hookCount, stale: hookCount, failed: hookCount,
};
const hookToolStats = Type.Object({
  category: Type.Union([Type.Literal('shell'), Type.Literal('file'), Type.Literal('search'), Type.Literal('codemode'), Type.Literal('mcp'), Type.Literal('other')]),
  calls: hookCount, failures: hookCount, nested: hookCount, truncated: hookCount,
}, { additionalProperties: false });
export const HooksStatsResultSchema = Type.Object({
  rules: Type.Array(Type.Object({ id: hookId, ...hookCounters }, { additionalProperties: false }), { maxItems: 64 }),
  otherHooks: Type.Object(hookCounters, { additionalProperties: false }),
  tools: Type.Array(hookToolStats, { minItems: 6, maxItems: 6 }),
  classifier: Type.Object({
    attempts: hookCount, durationMs: hookCount, inputTokens: Type.Number({ minimum: 0 }), outputTokens: Type.Number({ minimum: 0 }),
    outcomes: Type.Object({ not_in_catalog: hookCount, answered: hookCount, unavailable: hookCount,
      transient: hookCount, failed: hookCount, aborted: hookCount }, { additionalProperties: false }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const PresetApplyParamsSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  expectedVersion: Type.Optional(Type.String({
    minLength: 1,
    description: 'ContentHash the client read from presets.current; a mismatch is refused before any write.',
  })),
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
    kind: Type.Literal('tool_sync_failed'),
    detail: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    severity: Type.Literal('warning'),
    kind: Type.Literal('tool_retained_by_branch'),
    retainedTools: stringArray(description('Tools a preset tried to exclude but the manual /capability base layer keeps available.')),
    detail: Type.String(),
  }, { additionalProperties: false }),
]);

export const PresetApplyOutcomeSchema = Type.Object({
  applied: Type.Boolean(),
  unchanged: Type.Boolean(description('True when the recorded version and live state already matched; no branch entry was appended.')),
  snapshot: nullable(PresetSnapshotSchema),
  contentHash: nullable(Type.String(description('Actual contentHash in force after the apply; null when nothing was applied.'))),
  issues: Type.Array(PresetIssueSchema),
  problems: Type.Array(PresetApplyProblemSchema),
}, { additionalProperties: false });

export const PresetClearOutcomeSchema = Type.Object({
  cleared: Type.Literal(true),
  snapshot: Type.Null(),
  toolSyncError: nullable(Type.String(description('Set when the clear is durable but the blacklist-withdrawal loadout sync failed; nothing is rolled back.'))),
}, { additionalProperties: false });

// ---------------------------------------------------------------------------
// Shell approvals
// ---------------------------------------------------------------------------

export const ShellApprovalDecisionSchema = Type.Union([Type.Literal('allow'), Type.Literal('deny')]);

const shellPermissionMode = Type.Union([Type.Literal('ask'), Type.Literal('auto'), Type.Literal('yolo')]);
const approvalModeGetResult = Type.Object({
  enabled: Type.Boolean(), mode: shellPermissionMode, source: Type.Union([Type.Literal('config'), Type.Literal('branch')]),
  defaultMode: shellPermissionMode, autoFallbackToManual: Type.Boolean(),
}, { additionalProperties: false });
const approvalModeSetParams = Type.Object({ mode: shellPermissionMode }, { additionalProperties: true });
const approvalModeSetResult = Type.Object({ mode: shellPermissionMode, previousMode: shellPermissionMode,
  changed: Type.Boolean(), source: Type.Literal('branch'),
}, { additionalProperties: false });

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
  ToolTargetKind: ToolTargetKindSchema,
  ToolTarget: ToolTargetSchema,
  ToolTargetChange: ToolTargetChangeSchema,
  ToolWriteSkip: ToolWriteSkipSchema,
  ToolWriteContainer: ToolWriteContainerSchema,
  ToolBatchRejectionCode: ToolBatchRejectionCodeSchema,
  ToolBatchRejection: ToolBatchRejectionSchema,
  ToolWriteAction: ToolWriteActionSchema,
  ToolWriteResult: ToolWriteResultSchema,
  ToolBaseListResult: ToolBaseListResultSchema,
  ToolBaseSource: ToolBaseSourceSchema,
  ToolCollectionTarget: ToolCollectionTargetSchema,
  ToolBlacklistSource: ToolBlacklistSourceSchema,
  ToolBlacklistTarget: ToolBlacklistTargetSchema,
  ToolBlacklistListResult: ToolBlacklistListResultSchema,
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
  CreatedBatch: CreatedBatchSchema,
  SignalTarget: SignalTargetSchema,
  SignalResult: SignalResultSchema,
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
  JobsListParams: JobsListParamsSchema,
  JobIdParams: JobIdParamsSchema,
  SubagentAgent: SubagentAgentSchema,
  SubagentCreateParams: SubagentCreateParamsSchema,
  SubagentSignalParams: SubagentSignalParamsSchema,
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
  PresetToolSelection: PresetToolSelectionSchema,
  PresetVersionStatus: PresetVersionStatusSchema,
  PresetConfig: PresetConfigSchema,
  PresetCatalogItem: PresetCatalogItemSchema,
  PresetsCatalogResult: PresetsCatalogResultSchema,
  PresetSnapshot: PresetSnapshotSchema,
  PresetsCurrentResult: PresetsCurrentResultSchema,
  HooksCurrentResult: HooksCurrentResultSchema,
  HooksStatsResult: HooksStatsResultSchema,
  PresetApplyParams: PresetApplyParamsSchema,
  PresetIssueSeverity: PresetIssueSeveritySchema,
  PresetIssueKind: PresetIssueKindSchema,
  PresetIssue: PresetIssueSchema,
  PresetApplyProblem: PresetApplyProblemSchema,
  PresetApplyOutcome: PresetApplyOutcomeSchema,
  PresetClearOutcome: PresetClearOutcomeSchema,
  ShellApprovalDecision: ShellApprovalDecisionSchema,
  ApprovalModeGetResult: approvalModeGetResult,
  ApprovalModeSetParams: approvalModeSetParams,
  ApprovalModeSetResult: approvalModeSetResult,
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
    description: 'List tool facts and current effective members, optionally expanding to activatable and usable tools.',
    params: 'ToolsCatalogParams', result: 'ToolCatalogResult', paramsRequired: false,
  }),
  [RPC_METHODS.toolsDetail]: defineMethod({
    description: 'Return runtime, membership and blacklist facts plus the parameter schema for one registered tool.',
    params: 'ToolsDetailParams', result: 'ToolDetail', paramsRequired: true,
  }),
  [RPC_METHODS.toolsBaseAdd]: defineMethod({
    description: 'Add targets to the session base tool collection.',
    params: 'TargetsParams', result: 'ToolWriteResult', paramsRequired: true,
  }),
  [RPC_METHODS.toolsBaseRemove]: defineMethod({
    description: 'Remove targets from the session base tool collection without touching dynamic membership.',
    params: 'TargetsParams', result: 'ToolWriteResult', paramsRequired: true,
  }),
  [RPC_METHODS.toolsBaseList]: defineMethod({
    description: 'List recorded base targets with their current registered members.',
    params: 'NoParams', result: 'ToolBaseListResult', paramsRequired: false,
  }),
  [RPC_METHODS.toolsActivate]: defineMethod({
    description: 'Activate targets as dynamic session members within scope and SDK constraints.',
    params: 'TargetsParams', result: 'ToolWriteResult', paramsRequired: true,
  }),
  [RPC_METHODS.toolsDeactivate]: defineMethod({
    description: 'Remove targets from dynamic session membership without touching base membership.',
    params: 'TargetsParams', result: 'ToolWriteResult', paramsRequired: true,
  }),
  [RPC_METHODS.toolsBlacklistAdd]: defineMethod({
    description: 'Add manual branch blacklist targets as a hard fence; only blacklist remove reopens them, and neither base nor preset membership overrides them.',
    params: 'TargetsParams', result: 'ToolWriteResult', paramsRequired: true,
  }),
  [RPC_METHODS.toolsBlacklistRemove]: defineMethod({
    description: 'Remove branch and matching startup/config blacklist contributions for the targets; the current preset contribution and SDK hard limits remain.',
    params: 'TargetsParams', result: 'ToolWriteResult', paramsRequired: true,
  }),
  [RPC_METHODS.toolsBlacklistList]: defineMethod({
    description: 'List effective blacklist targets and every source contributing them.',
    params: 'NoParams', result: 'ToolBlacklistListResult', paramsRequired: false,
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
    description: 'Start one batch of background collaborators for a shared goal with host-bound origin.',
    params: 'SubagentCreateParams', result: 'CreatedBatch', paramsRequired: true,
  }),
  [RPC_METHODS.subagentSignal]: defineMethod({
    description: 'Interrupt or stop the current work of an agent by local actor key.',
    params: 'SubagentSignalParams', result: 'SignalResult', paramsRequired: true,
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
    description: 'Read the active branch preset snapshot and compare it with the current catalog candidate without writing branch state.',
    params: 'NoParams', result: 'PresetsCurrentResult', paramsRequired: false,
  }),
  [RPC_METHODS.hooksCurrent]: defineMethod({
    description: 'Inspect the effective Hook rules and branch mute state without exposing configuration text.',
    params: 'NoParams', result: 'HooksCurrentResult', paramsRequired: false,
  }),
  [RPC_METHODS.hooksStats]: defineMethod({
    description: 'Read bounded in-memory Hook, tool and classifier counters for the active session.',
    params: 'NoParams', result: 'HooksStatsResult', paramsRequired: false,
  }),
  [RPC_METHODS.presetsApply]: defineMethod({
    description: 'Resolve and apply a named preset as one atomic version, optionally refusing a stale expectedVersion before any write.',
    params: 'PresetApplyParams', result: 'PresetApplyOutcome', paramsRequired: true,
  }),
  [RPC_METHODS.presetsClear]: defineMethod({
    description: 'Clear the active preset from branch management without rolling back model/thinking/tools.',
    params: 'NoParams', result: 'PresetClearOutcome', paramsRequired: false,
  }),
  [RPC_METHODS.approvalsModeGet]: defineMethod({
    description: 'Read the configured and branch-selected Shell approval mode.',
    params: 'NoParams', result: 'ApprovalModeGetResult', paramsRequired: false,
  }),
  [RPC_METHODS.approvalsModeSet]: defineMethod({
    description: 'Pin the Shell approval mode to the active branch for subsequent requests.',
    params: 'ApprovalModeSetParams', result: 'ApprovalModeSetResult', paramsRequired: true,
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
export type ToolTargetKind = DeepReadonly<Static<typeof ToolTargetKindSchema>>;
export type ToolTarget = DeepReadonly<Static<typeof ToolTargetSchema>>;
export type ToolTargetChange = DeepReadonly<Static<typeof ToolTargetChangeSchema>>;
export type ToolWriteSkip = DeepReadonly<Static<typeof ToolWriteSkipSchema>>;
export type ToolWriteAction = DeepReadonly<Static<typeof ToolWriteActionSchema>>;
export type ToolWriteResult = DeepReadonly<Static<typeof ToolWriteResultSchema>>;
export type ToolBaseListResult = DeepReadonly<Static<typeof ToolBaseListResultSchema>>;
export type ToolBaseSource = DeepReadonly<Static<typeof ToolBaseSourceSchema>>;
export type ToolCollectionTarget = DeepReadonly<Static<typeof ToolCollectionTargetSchema>>;
export type ToolBlacklistSource = DeepReadonly<Static<typeof ToolBlacklistSourceSchema>>;
export type ToolBlacklistTarget = DeepReadonly<Static<typeof ToolBlacklistTargetSchema>>;
export type ToolBlacklistListResult = DeepReadonly<Static<typeof ToolBlacklistListResultSchema>>;
export type DetailedAgentItem = DeepReadonly<Static<typeof DetailedAgentItemSchema>>;
export type JobView = DeepReadonly<Static<typeof JobViewSchema>>;
export type JobRecordView = DeepReadonly<Static<typeof JobRecordViewSchema>>;
export type CreatedBatch = DeepReadonly<Static<typeof CreatedBatchSchema>>;
export type SignalResult = DeepReadonly<Static<typeof SignalResultSchema>>;
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
export type PresetToolSelection = DeepReadonly<Static<typeof PresetToolSelectionSchema>>;
export type PresetVersionStatus = DeepReadonly<Static<typeof PresetVersionStatusSchema>>;
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
export type JobsListParams = Static<typeof JobsListParamsSchema>;
export type JobIdParams = Static<typeof JobIdParamsSchema>;
export type SubagentAgent = Static<typeof SubagentAgentSchema>;
export type SubagentCreateParams = Static<typeof SubagentCreateParamsSchema>;
export type SubagentSignalParams = Static<typeof SubagentSignalParamsSchema>;
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
