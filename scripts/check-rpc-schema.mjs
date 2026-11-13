#!/usr/bin/env node
/**
 * Keep the language-neutral Harness RPC artifacts honest.
 *
 * The normative artifacts are:
 * - `schemas/harness-rpc.schema.json` (JSON Schema 2020-12)
 * - `schemas/harness-rpc.manifest.json` (transport, envelopes, method map)
 * - `schemas/fixtures/harness-rpc/` (valid/invalid frames and streams)
 *
 * checks fixture validity and the tracked SHA256SUMS before writing the two
 * ignored JSON documents from `src/harness-rpc/schema.ts`. `--write` also
 * updates SHA256SUMS after intentional schema changes. This script is not a
 * runtime dependency for a parser in another language.
 *
 * Usage:
 *   node --import tsx scripts/check-rpc-schema.mjs          # check
 *   node --import tsx scripts/check-rpc-schema.mjs --write  # regenerate
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Value } from 'typebox/value';

import { isRpcMethod, validateMethodParams, validateRpcId } from '../src/harness-rpc/contract.ts';
import { HARNESS_RPC_PROTOCOL_VERSION, RPC_METHODS } from '../src/harness-rpc/protocol.ts';
import {
  HARNESS_RPC_METHOD_SCHEMAS,
  HARNESS_RPC_SCHEMA,
  HARNESS_RPC_UPSTREAM,
  harnessRpcSchemaRef,
} from '../src/harness-rpc/schema.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schemaTarget = path.join(root, 'schemas', 'harness-rpc.schema.json');
const manifestTarget = path.join(root, 'schemas', 'harness-rpc.manifest.json');
const hashesTarget = path.join(root, 'schemas', 'SHA256SUMS');
const fixturesRoot = path.join(root, 'schemas', 'fixtures', 'harness-rpc');
const fixtureManifest = path.join(fixturesRoot, 'manifest.json');
const write = process.argv.includes('--write');

const failures = [];
const fail = (message) => failures.push(message);
const CONFORMANCE = new Set(['framing', 'envelope', 'payload', 'stateful']);
const NATIVE_VALIDITY = new Set(['strict', 'illustrative', 'opaque']);

const methods = Object.values(RPC_METHODS);
const defs = HARNESS_RPC_SCHEMA.$defs;

// 1) Method map covers every implemented method exactly once, with resolvable refs.
for (const method of methods) {
  if (!(method in HARNESS_RPC_METHOD_SCHEMAS)) fail(`method "${method}" has no schema entry.`);
}
for (const method of Object.keys(HARNESS_RPC_METHOD_SCHEMAS)) {
  if (!methods.includes(method)) fail(`schema entry "${method}" has no implemented method.`);
}
for (const [method, entry] of Object.entries(HARNESS_RPC_METHOD_SCHEMAS)) {
  for (const slot of ['params', 'result']) {
    const name = entry[slot];
    if (!(name in defs)) fail(`${method}.${slot} references missing $defs/${name}.`);
  }
}

// 2) The method-discriminated request union covers every method exactly once.
const requestUnion = defs.MethodRequest;
const unionMethods = (requestUnion?.anyOf ?? []).map((item) => item?.properties?.method?.const);
for (const method of methods) {
  const count = unionMethods.filter((value) => value === method).length;
  if (count !== 1) fail(`MethodRequest must contain "${method}" exactly once; found ${count}.`);
}
if (unionMethods.length !== methods.length) {
  fail(`MethodRequest has ${unionMethods.length} branches for ${methods.length} methods.`);
}

// 3) Representative frames validate with the shared definitions.
function check(label, schemaName, value, expected) {
  const actual = Value.Check(harnessRpcSchemaRef(schemaName), value);
  if (actual !== expected) fail(`${label}: expected ${expected ? 'valid' : 'invalid'}, got ${actual ? 'valid' : 'invalid'}.`);
}

check('request', 'MethodRequest', { id: 'r1', method: 'harness.info' }, true);
check('request params', 'MethodRequest', { id: 1, method: 'tools.detail', params: { name: 'read' } }, true);
check('request params null', 'MethodRequest', { id: 1, method: 'tools.catalog', params: null }, true);
check('request missing params', 'MethodRequest', { id: 1, method: 'tools.detail' }, false);
check('unknown method', 'MethodRequest', { id: 1, method: 'nope' }, false);
check('success response', 'RpcResponse', { id: 'r1', ok: true, result: {} }, true);
check('failure response', 'RpcResponse', { id: null, ok: false, error: { code: 'invalid_request', message: 'bad frame' } }, true);
check('event frame', 'RpcEventFrame', {
  event: {
    subscription: 'sub-1', seq: 1, payload: {
      kind: 'job', rootSessionId: 's', jobId: 'j', agentId: 'a', status: 'completed',
    },
  },
}, true);
check('stream event payload', 'StreamEventPayload', {
  kind: 'session', rootSessionId: 's', jobId: 'j', agentId: 'a', event: { type: 'message_start' },
}, true);
check('approvals event payload', 'ApprovalsEvent', {
  kind: 'approvals', rootSessionId: 's', items: [],
}, true);
check('main event payload', 'MainEventPayload', {
  kind: 'main', generation: 1, rootSessionId: 's', source: 'sdk', event: { type: 'agent_start' },
}, true);
check('discovery record', 'HarnessRpcRecord', {
  protocolVersion: 1, address: '/tmp/x/harness-rpc.sock', sessionId: 's', pid: 1, startedAt: new Date(0).toISOString(),
}, true);

// 4) Fixtures: every listed fixture exists, every fixture file is listed, and
// each one matches its declared outcome.
function readText(relative) {
  return fs.readFileSync(path.join(fixturesRoot, relative), 'utf8');
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function linesOf(text, lineEnding = 'lf') {
  const normalized = lineEnding === 'crlf' ? text.replace(/\r\n/g, '\n') : text.replace(/\r\n/g, '\n');
  return normalized.split('\n').filter((line) => line.trim() !== '');
}

function assertUsage(usage, label) {
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    if (typeof usage?.[key] !== 'number') fail(`${label}: usage.${key} must be a number.`);
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
    if (typeof usage?.cost?.[key] !== 'number') fail(`${label}: usage.cost.${key} must be a number.`);
  }
}

function assertAssistant(message, label) {
  if (!message || message.role !== 'assistant') {
    fail(`${label}: expected an assistant message.`);
    return;
  }
  for (const key of ['api', 'provider', 'model', 'stopReason']) {
    if (typeof message[key] !== 'string') fail(`${label}: ${key} must be a string.`);
  }
  if (typeof message.timestamp !== 'number') fail(`${label}: timestamp must be a number.`);
  assertUsage(message.usage, label);
  for (const part of Array.isArray(message.content) ? message.content : []) {
    if (part?.type === 'toolCall'
        && (typeof part.id !== 'string' || typeof part.name !== 'string' || typeof part.arguments !== 'object')) {
      fail(`${label}: toolCall needs id, name and arguments.`);
    }
  }
}

function validateFixture(fixture) {
  const relative = fixture.path;
  const file = path.join(fixturesRoot, relative);
  if (!fs.existsSync(file)) {
    fail(`missing fixture: ${relative}`);
    return;
  }
  if (fixture.kind === 'raw') {
    const parsed = parseJson(readText(relative));
    if (fixture.valid !== parsed.ok) fail(`${relative}: expected ${fixture.valid ? 'valid' : 'invalid'} JSON.`);
    return;
  }
  if (fixture.kind === 'frame') {
    const parsed = parseJson(readText(relative));
    if (!parsed.ok) {
      fail(`${relative}: fixture is not JSON.`);
      return;
    }
    const actual = Value.Check(harnessRpcSchemaRef(fixture.schema), parsed.value);
    if (actual !== fixture.valid) fail(`${relative}: expected ${fixture.valid ? 'valid' : 'invalid'} against ${fixture.schema}.`);
    if (fixture.schema === 'MethodRequest') {
      const frame = parsed.value;
      const runtimeValid = typeof frame === 'object' && frame !== null && !Array.isArray(frame)
        && validateRpcId(frame.id) && isRpcMethod(frame.method)
        && validateMethodParams(frame.method, frame.params).ok;
      if (runtimeValid !== fixture.valid) {
        fail(`${relative}: runtime contract validator returned ${runtimeValid}, expected ${fixture.valid}.`);
      }
    }
    if (fixture.dispatch !== undefined) {
      if (fixture.dispatch?.outcome !== 'error' || typeof fixture.dispatch?.code !== 'string') {
        fail(`${relative}: dispatch must be {outcome:"error",code:string}.`);
      }
    }
    if (fixture.methodRequestValid !== undefined) {
      const strict = Value.Check(harnessRpcSchemaRef('MethodRequest'), parsed.value);
      if (strict !== fixture.methodRequestValid) {
        fail(`${relative}: methodRequestValid expected ${fixture.methodRequestValid}, got ${strict}.`);
      }
    }
    return;
  }
  if (fixture.kind === 'stream') {
    const lines = linesOf(readText(relative), fixture.lineEnding);
    if (fixture.frameCount !== undefined && lines.length !== fixture.frameCount) {
      fail(`${relative}: expected ${fixture.frameCount} frames, found ${lines.length}.`);
    }
    lines.forEach((line, index) => {
      const parsed = parseJson(line);
      if (!parsed.ok) {
        fail(`${relative}[${index}]: frame is not JSON.`);
        return;
      }
      const actual = Value.Check(harnessRpcSchemaRef(fixture.schema), parsed.value);
      const expected = fixture.valid ? true : index !== fixture.invalidFrameIndex;
      if (actual !== expected) {
        fail(`${relative}[${index}]: expected ${expected ? 'valid' : 'invalid'} against ${fixture.schema}.`);
      }
    });
    return;
  }
  if (fixture.kind === 'transport') {
    const vector = parseJson(readText(relative));
    if (!vector.ok) {
      fail(`${relative}: transport vector is not JSON.`);
      return;
    }
    const { text, splitByteOffsets, expectedFrames } = vector.value;
    if (typeof text !== 'string' || !Array.isArray(splitByteOffsets) || !Array.isArray(expectedFrames)) {
      fail(`${relative}: transport vector needs text, splitByteOffsets and expectedFrames.`);
      return;
    }
    const bytes = Buffer.from(text, 'utf8');
    const chunks = [];
    let last = 0;
    for (const offset of splitByteOffsets) {
      if (!Number.isInteger(offset) || offset <= last || offset >= bytes.length) {
        fail(`${relative}: invalid split offset ${offset}.`);
        return;
      }
      chunks.push(bytes.subarray(last, offset));
      last = offset;
    }
    chunks.push(bytes.subarray(last));
    const frames = linesOf(Buffer.concat(chunks).toString('utf8')).map((line) => {
      const parsed = parseJson(line);
      if (!parsed.ok) {
        fail(`${relative}: assembled chunk is not JSON.`);
        return undefined;
      }
      return parsed.value;
    });
    if (JSON.stringify(frames) !== JSON.stringify(expectedFrames)) {
      fail(`${relative}: assembled frames do not match expectedFrames.`);
    }
    for (const frame of frames) {
      if (frame !== undefined && !Value.Check(harnessRpcSchemaRef('MethodRequest'), frame)) {
        fail(`${relative}: expected frame does not validate against MethodRequest.`);
      }
    }
    const splitInsideMultibyte = splitByteOffsets.some((offset) => (bytes[offset] & 0xc0) === 0x80);
    if (vector.value.utf8Split === true && !splitInsideMultibyte) {
      fail(`${relative}: no split lands inside a multi-byte UTF-8 sequence.`);
    }
    return;
  }
  if (fixture.kind === 'conversation') {
    const lines = linesOf(readText(relative));
    if (!Array.isArray(fixture.schemas) || lines.length !== fixture.schemas.length) {
      fail(`${relative}: expected ${fixture.schemas?.length ?? 0} frames, found ${lines.length}.`);
      return;
    }
    const frames = [];
    lines.forEach((line, index) => {
      const parsed = parseJson(line);
      if (!parsed.ok) {
        fail(`${relative}[${index}]: frame is not JSON.`);
        return;
      }
      if (!Value.Check(harnessRpcSchemaRef(fixture.schemas[index]), parsed.value)) {
        fail(`${relative}[${index}]: does not match ${fixture.schemas[index]}.`);
      }
      frames.push(parsed.value);
    });
    if (frames.length !== lines.length) return;
    const expectedParsed = parseJson(readText(fixture.expected));
    if (!expectedParsed.ok) {
      fail(`${relative}: expected file is not JSON.`);
      return;
    }
    const expected = expectedParsed.value;
    const request = frames[0];
    if (request?.method !== 'stream.subscribe') {
      fail(`${relative}: first frame must be stream.subscribe.`);
      return;
    }
    const responseIndex = frames.findIndex((frame) => frame && typeof frame === 'object' && 'ok' in frame);
    if (responseIndex <= 0) {
      fail(`${relative}: needs at least one event before the response.`);
      return;
    }
    const response = frames[responseIndex];
    if (response.id !== request.id) fail(`${relative}: response id does not match request.`);
    const result = response.result;
    if (result?.subscription !== expected.subscription) fail(`${relative}: subscription mismatch.`);
    if (!Value.Check(harnessRpcSchemaRef('StreamSubscribeResult'), result)) fail(`${relative}: result is not StreamSubscribeResult.`);
    const before = frames.slice(1, responseIndex).filter((frame) => frame?.event);
    if (before.length !== expected.ordering?.eventsBeforeResponse) fail(`${relative}: eventsBeforeResponse mismatch.`);
    if (JSON.stringify(before.map((frame) => frame.event.seq)) !== JSON.stringify(expected.ordering?.bufferedSeq)) {
      fail(`${relative}: bufferedSeq mismatch.`);
    }
    const allEvents = frames.slice(1).filter((frame) => frame?.event).map((frame) => frame.event);
    if (JSON.stringify(allEvents.map((event) => event.seq)) !== JSON.stringify(expected.seq)) fail(`${relative}: seq mismatch.`);
    if (allEvents.some((event) => event.subscription !== expected.subscription)) fail(`${relative}: event subscription mismatch.`);
    for (const event of allEvents) {
      if (!Value.Check(harnessRpcSchemaRef('StreamEventPayload'), event.payload)) {
        fail(`${relative}: event payload does not match StreamEventPayload.`);
      }
    }
    const boundary = result.boundary;
    if (boundary?.partial?.content?.[0]?.text !== expected.boundary?.partialText) fail(`${relative}: boundary.partial mismatch.`);
    if (boundary?.messages?.[0]?.content?.[0]?.text !== expected.boundary?.messageText) fail(`${relative}: boundary.messages mismatch.`);
    assertAssistant(boundary?.messages?.[0], `${relative} boundary.messages[0]`);
    assertAssistant(boundary?.partial, `${relative} boundary.partial`);
    for (const event of allEvents) {
      if (event.payload?.kind === 'session' && event.payload.event?.type === 'message_update') {
        assertUsage(event.payload.event.usage, `${relative} seq ${event.seq} usage`);
      }
      if (event.payload?.kind === 'session' && event.payload.event?.type === 'message_end') {
        assertAssistant(event.payload.event.message, `${relative} seq ${event.seq} message_end`);
      }
    }
    const deltas = allEvents
      .filter((event) => event.payload?.kind === 'session' && event.payload.event?.type === 'message_update'
        && event.payload.event.assistantMessageEvent?.type === 'text_delta')
      .map((event) => event.payload.event.assistantMessageEvent.delta);
    if (`${expected.boundary?.partialText ?? ''}${deltas.join('')}` !== expected.assembled?.text) fail(`${relative}: assembled text mismatch.`);
    const messageEnd = allEvents.find((event) => event.payload?.kind === 'session' && event.payload.event?.type === 'message_end')?.payload.event.message;
    if (messageEnd?.content?.[0]?.text !== expected.assembled?.text) fail(`${relative}: message_end text mismatch.`);
    if (messageEnd?.stopReason !== expected.assembled?.stopReason) fail(`${relative}: stopReason mismatch.`);
    const toolStart = allEvents.find((event) => event.payload?.kind === 'session' && event.payload.event?.type === 'message_update'
      && event.payload.event.assistantMessageEvent?.type === 'toolcall_start')?.payload.event.assistantMessageEvent;
    const toolEnd = allEvents.find((event) => event.payload?.kind === 'session' && event.payload.event?.type === 'message_update'
      && event.payload.event.assistantMessageEvent?.type === 'toolcall_end')?.payload.event.assistantMessageEvent;
    const toolCall = expected.assembled?.toolCalls?.[0];
    if (toolStart?.id !== toolCall?.id || toolStart?.toolName !== toolCall?.name) fail(`${relative}: toolcall_start mismatch.`);
    if (toolEnd?.toolCall?.type !== 'toolCall') fail(`${relative}: toolcall_end.toolCall.type must be "toolCall".`);
    if (JSON.stringify(toolEnd?.toolCall) !== JSON.stringify(toolCall)) fail(`${relative}: toolcall_end mismatch.`);
    const job = allEvents.find((event) => event.payload?.kind === 'job');
    if (job?.payload?.status !== expected.assembled?.terminal) fail(`${relative}: terminal status mismatch.`);
    return;
  }
  fail(`${relative}: unknown fixture kind "${fixture.kind}".`);
}

if (!fs.existsSync(fixtureManifest)) {
  fail(`missing fixture manifest: ${path.relative(root, fixtureManifest)}`);
} else {
  const manifest = parseJson(fs.readFileSync(fixtureManifest, 'utf8'));
  if (!manifest.ok || !Array.isArray(manifest.value?.fixtures)) {
    fail('fixture manifest must contain a fixtures array.');
  } else {
    const listed = new Set();
    for (const fixture of manifest.value.fixtures) {
      if (typeof fixture.path !== 'string' || listed.has(fixture.path)) {
        fail(`fixture manifest has a missing or duplicate path: ${JSON.stringify(fixture.path)}`);
        continue;
      }
      if (!Array.isArray(fixture.conformance) || fixture.conformance.length === 0
          || fixture.conformance.some((level) => !CONFORMANCE.has(level))) {
        fail(`fixture ${fixture.path} needs a non-empty conformance list from ${[...CONFORMANCE].join(', ')}.`);
      }
      if (fixture.nativeValidity !== undefined && !NATIVE_VALIDITY.has(fixture.nativeValidity)) {
        fail(`fixture ${fixture.path}: nativeValidity must be one of ${[...NATIVE_VALIDITY].join(', ')}.`);
      }
      listed.add(fixture.path);
      validateFixture(fixture);
    }

    // Stateful sequence scenarios: each step is an ordinary fixture; the
    // expectations cover correlation and ordering, not full message assembly.
    for (const scenario of manifest.value.scenarios ?? []) {
      if (typeof scenario.name !== 'string' || !Array.isArray(scenario.steps) || scenario.steps.length === 0) {
        fail('scenario needs a name and a non-empty steps array.');
        continue;
      }
      if (scenario.conformance !== 'stateful') {
        fail(`scenario ${scenario.name}: conformance must be "stateful".`);
      }
      const values = [];
      for (const step of scenario.steps) {
        if (typeof step.path !== 'string' || typeof step.schema !== 'string') {
          fail(`scenario ${scenario.name}: each step needs path and schema.`);
          continue;
        }
        const file = path.join(fixturesRoot, step.path);
        if (!fs.existsSync(file)) {
          fail(`scenario ${scenario.name}: missing step ${step.path}.`);
          continue;
        }
        const parsed = parseJson(readText(step.path));
        if (!parsed.ok) {
          fail(`scenario ${scenario.name}: step ${step.path} is not JSON.`);
          continue;
        }
        if (!Value.Check(harnessRpcSchemaRef(step.schema), parsed.value)) {
          fail(`scenario ${scenario.name}: step ${step.path} does not match ${step.schema}.`);
          continue;
        }
        values.push(parsed.value);
      }
      if (values.length !== scenario.steps.length) continue;
      const subscribe = values[0];
      const events = values.slice(1).map((value) => value.event);
      const expect = scenario.expect ?? {};
      if (subscribe.subscription !== expect.subscription) {
        fail(`scenario ${scenario.name}: subscribe subscription mismatch.`);
      }
      if (events.some((event) => event.subscription !== expect.subscription)) {
        fail(`scenario ${scenario.name}: event subscription mismatch.`);
      }
      if (JSON.stringify(events.map((event) => event.seq)) !== JSON.stringify(expect.seq)) {
        fail(`scenario ${scenario.name}: event seq mismatch.`);
      }
      if (expect.jobStatus !== undefined && events.at(-1)?.payload?.status !== expect.jobStatus) {
        fail(`scenario ${scenario.name}: job terminal status mismatch.`);
      }
    }
    const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(full);
      return [path.relative(fixturesRoot, full).split(path.sep).join('/')];
    });
    for (const relative of walk(fixturesRoot)) {
      if (relative === 'manifest.json' || relative === 'README.md' || relative.endsWith('.expected.json')) continue;
      if (!listed.has(relative)) fail(`fixture is not listed in manifest.json: ${relative}`);
    }
  }
}

// 5) Deterministic generated bytes must match the tracked checksum manifest.
const schemaDocument = `${JSON.stringify(HARNESS_RPC_SCHEMA, null, 2)}\n`;
const manifestDocument = `${JSON.stringify({
  protocolVersion: HARNESS_RPC_PROTOCOL_VERSION,
  spec: 'docs/harness-rpc-wire-spec.md',
  schema: 'schemas/harness-rpc.schema.json',
  transport: {
    framing: 'newline-delimited-json',
    encoding: 'utf-8',
    terminator: '\n',
    lineEndings: 'LF; CRLF is accepted by trimming the CR; empty lines are ignored',
    maxInputFrameBytes: null,
    maxUnsentBacklogBytes: 4194304,
  },
  envelopes: {
    request: { ref: '#/$defs/RpcRequest', required: ['id', 'method'], optional: ['params'] },
    strictRequest: { ref: '#/$defs/MethodRequest' },
    response: { ref: '#/$defs/RpcResponse', discriminator: 'ok' },
    event: { ref: '#/$defs/RpcEventFrame', discriminator: 'event' },
  },
  methods: HARNESS_RPC_METHOD_SCHEMAS,
  subscriptions: {
    'stream.subscribe': { result: 'StreamSubscribeResult', eventPayload: 'StreamEventPayload', eventKinds: ['session', 'job'] },
    'stream.unsubscribe': { result: 'StreamUnsubscribeResult' },
    'approvals.subscribe': { result: 'ApprovalsSubscribeResult', eventPayload: 'ApprovalsEvent', eventKinds: ['approvals'] },
    'main.subscribe': { result: 'MainSubscribeResult', eventPayload: 'MainEventPayload', eventKinds: ['main'] },
  },
  conformance: {
    levels: [
      { id: 'framing', description: 'UTF-8 decoding, NDJSON framing, CRLF/empty lines, split reads.' },
      { id: 'envelope', description: 'Request/response/event discrimination, id/method, method params and error envelope.' },
      { id: 'payload', description: 'Method result shapes, tool management, history/stream boundary, partial results.' },
      { id: 'stateful', description: 'Request correlation and subscription sequencing; needs a harness beyond static frames.' },
    ],
    fixtures: 'schemas/fixtures/harness-rpc/manifest.json',
    scenarios: 'stateful sequences in the fixture manifest',
  },
  upstream: HARNESS_RPC_UPSTREAM,
  fixtures: {
    root: 'schemas/fixtures/harness-rpc',
    manifest: 'schemas/fixtures/harness-rpc/manifest.json',
  },
}, null, 2)}\n`;

const generatedArtifacts = [[schemaTarget, schemaDocument], [manifestTarget, manifestDocument]];
const checksumDocument = generatedArtifacts.map(([target, document]) =>
  `${createHash('sha256').update(document, 'utf8').digest('hex')}  ${path.relative(root, target).split(path.sep).join('/')}`,
).join('\n') + '\n';

if (!write) {
  let recorded = null;
  try {
    recorded = fs.readFileSync(hashesTarget, 'utf8');
  } catch {
    fail('schemas/SHA256SUMS is missing; run "npm run schema:rpc".');
  }
  if (recorded !== null && recorded !== checksumDocument) {
    fail('schemas/SHA256SUMS does not match generated artifacts; review the protocol changes and run "npm run schema:rpc".');
  }
}

if (failures.length > 0) {
  console.error('Harness RPC schema check failed:');
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}

// Materialize validated artifacts on every successful invocation, including a
// clean checkout. They are ignored by Git; only --write updates the tracked hash.
fs.mkdirSync(path.dirname(schemaTarget), { recursive: true });
for (const [target, document] of generatedArtifacts) fs.writeFileSync(target, document);
if (write) {
  fs.writeFileSync(hashesTarget, checksumDocument);
  console.log('updated schemas/SHA256SUMS');
}
console.log(`Harness RPC schema OK: ${methods.length} methods, ${Object.keys(defs).length} definitions, fixtures validated; generated artifacts match SHA256SUMS.`);
