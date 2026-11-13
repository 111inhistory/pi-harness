/**
 * Machine-readable schema projection for the Harness RPC endpoint.
 *
 * Derived directly from `HARNESS_RPC_CONTRACT` and `SHARED_CONTRACT_DEFS` in
 * `contract.ts` — never maintains a second copy of method definitions or
 * schemas. `scripts/check-rpc-schema.mjs` serializes `HARNESS_RPC_SCHEMA` into
 * `schemas/harness-rpc.schema.json`.
 */

import { Type, type TSchema } from 'typebox';

import { HARNESS_RPC_CONTRACT, SHARED_CONTRACT_DEFS } from './contract.ts';
import type { RpcMethod } from './protocol.ts';

const ref = (name: string): TSchema => Type.Ref(`#/$defs/${name}`);

export type RpcMethodSchema = {
  /** `$defs` name (without the `#/$defs/` prefix) for the method parameters. */
  readonly params: string;
  /** `$defs` name (without the `#/$defs/` prefix) for the method result. */
  readonly result: string;
  /** Whether the method requires `params`; optional methods accept absent or null. */
  readonly paramsRequired: boolean;
};

/** Method -> shared definition names, derived directly from `HARNESS_RPC_CONTRACT`. */
export const HARNESS_RPC_METHOD_SCHEMAS = Object.fromEntries(
  Object.entries(HARNESS_RPC_CONTRACT).map(([method, contract]) => [
    method,
    {
      params: contract.defNames.params,
      result: contract.defNames.result,
      paramsRequired: contract.paramsRequired,
    },
  ]),
) as Record<RpcMethod, RpcMethodSchema>;

/** Discriminated union of valid client method requests, derived from `HARNESS_RPC_CONTRACT`. */
const MethodRequest = Type.Union(
  Object.entries(HARNESS_RPC_CONTRACT).map(([method, contract]) =>
    Type.Object({
      id: ref('RpcId'),
      method: Type.Literal(method as RpcMethod),
      params: contract.paramsRequired
        ? ref(contract.defNames.params)
        : Type.Optional(Type.Union([ref(contract.defNames.params), Type.Null()])),
    }, { additionalProperties: true, description: contract.description }),
  ),
  { description: 'Discriminated union of valid client method requests.' },
);

const DEFS = {
  ...SHARED_CONTRACT_DEFS,
  MethodRequest,
} as const;

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
