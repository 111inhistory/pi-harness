/**
 * Real-SDK offline acceptance scenario for parent Job survival.
 *
 * Topology: Main -> Depth 1 (parent) -> two Depth 2 children. The parent starts
 * both children, ends its model turn with interim text, and must keep its
 * ORIGINAL Job running while the children's scripted providers are held. No
 * terminal notification may reach Main and no continuation Job/Budget may be
 * allocated. Releasing the children one at a time must be handled by the same
 * Job, whose single final answer is the only terminal notification Main sees.
 *
 * A later explicit `msg_write` still revives the fully stopped parent as round
 * 2. Assertions describe behavior (published state, Job events, notice rounds),
 * not prompt prose.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import {
  fauxProvider, InMemoryCredentialStore,
  type AssistantMessage, type ToolCall,
} from '@earendil-works/pi-ai';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';

import subagentExtension from '../../src/subagent/extension.ts';
import { deferred, waitFor } from '../../test-support/async.ts';
import { treeNodes } from './support/agent-tree.ts';

const PARENT_ID = 'sub_01';
const CHILD_A_ID = 'sub_01_01';
const CHILD_B_ID = 'sub_01_02';

const ROOT_TASK = 'ROOT_HOLD: delegate the parent-hold fixture to one depth-1 parent.';
const PARENT_TASK = 'PARENT_HOLD: dispatch two depth-2 children, then wait for both of them.';
const CHILD_A_TASK = 'CHILD_A_TASK: produce the first depth-2 result.';
const CHILD_B_TASK = 'CHILD_B_TASK: produce the second depth-2 result.';
const CHILD_A_RESULT = 'CHILD_A_RESULT: first depth-2 answer.';
const CHILD_B_RESULT = 'CHILD_B_RESULT: second depth-2 answer.';
const PARENT_FINAL = `PARENT_FINAL: combined ${CHILD_A_RESULT} ${CHILD_B_RESULT}`;
const MAIN_ACK = 'MAIN_ACK: the root observed the parent event.';
const REVIVE_MARKER = 'REVIVE_AFTER_HOLD: report one explicit continuation.';
const REVIVE_RESULT = 'REVIVE_RESULT: explicit continuation completed.';

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : null;

interface PublishedNode {
  id: string;
  status?: string;
  socket?: string;
  children?: PublishedNode[];
  history?: { jobId: string; summary: string; cleanJsonl: string; result?: string };
}

function nodeById(tree: PublishedNode, id: string): PublishedNode {
  const node = treeNodes(tree).find((candidate) => candidate['id'] === id);
  assert.ok(node, `published subagent_list must contain ${id}`);
  return node as unknown as PublishedNode;
}

function usage(): AssistantMessage['usage'] {
  return {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test('a held Depth-1 parent keeps one running Job and delivers one combined round-1 completion', { timeout: 60000 }, async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'parent-hold-sdk-'));
  const agentDir = path.join(cwd, 'agent');
  await mkdir(agentDir, { recursive: true });
  const oldAgentDir = process.env['PI_CODING_AGENT_DIR'];
  const oldSocketDir = process.env['PI_SUBAGENT_SOCKET_DIR'];
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_SUBAGENT_SOCKET_DIR'] = path.join(cwd, 'uds');

  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
  });
  const faux = fauxProvider({ models: [{ id: 'parent-hold-fixture', reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const model = faux.models[0];
  assert.ok(model);
  assert.ok(faux.provider.id);
  runtime.getAuth = async () => ({ auth: { apiKey: 'offline-fixture' }, env: {} });
  runtime.hasConfiguredAuth = () => true;

  // Local routing config only: the classifier is bundled catalog metadata and
  // every classifier/chat request below is scripted in-process.
  await writeFile(path.join(agentDir, 'subagent-routing.json'), JSON.stringify({
    version: 2,
    classifier: { provider: 'openrouter', id: '~typesafe/jev-latest' },
    instructions: { role: 'Select the executor role.', model: 'Select the only configured model.' },
    roles: [{
      id: 'executor',
      excludeTools: [],
      instructions: 'Complete the delegated assignment.',
      candidates: [{ model: 'fixture', thinking: 'low' }],
    }],
    models: [{
      id: 'fixture', provider: faux.provider.id, model: model.id,
      preference: 'The only offline fixture candidate.',
    }],
  }));

  runtime.classify = async (classifier, context) => {
    const key = Object.keys(context.questions)[0];
    assert.ok(key, 'routing must ask a question');
    const question = context.questions[key];
    assert.ok(question?.type === 'choice', 'fixture routing asks a choice question');
    const selected = Object.keys(question.criteria)[0];
    assert.ok(selected, 'the fixture role/model has one criterion');
    const probabilities = Object.fromEntries(
      Object.keys(question.criteria).map((name) => [name, name === selected ? 1 : 0]),
    );
    return {
      api: classifier.api, provider: classifier.provider, model: classifier.id,
      answers: { [key]: { type: 'choice' as const, choice: selected, probabilities, confidence: 1 } },
      usage: usage(), stopReason: 'stop' as const, timestamp: Date.now(),
    };
  };

  const childA = deferred();
  const childB = deferred();
  const gates = { childA, childB };

  // The session manager is created before the session so its id is known to the
  // scripted dispatcher from the very first request.
  const sessionManager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
  const rootSessionId = sessionManager.getSessionId();

  const mainTurns: string[] = [];
  const parentTurns: string[] = [];
  const parentReplies: string[] = [];
  const childTurns: string[] = [];
  const scriptErrors: unknown[] = [];
  const roles = new Map<string, 'Main' | 'parent' | 'childA' | 'childB'>();

  function roleOf(sessionId: string | undefined, text: string): 'Main' | 'parent' | 'childA' | 'childB' {
    if (sessionId === rootSessionId) return 'Main';
    const known = sessionId === undefined ? undefined : roles.get(sessionId);
    if (known !== undefined) return known;
    const role = text.includes(ROOT_TASK) ? 'Main'
      : text.includes(PARENT_TASK) ? 'parent'
        : text.includes(CHILD_A_TASK) ? 'childA' : 'childB';
    if (sessionId !== undefined) roles.set(sessionId, role);
    return role;
  }

  function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
    return {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content, stopReason, timestamp: Date.now(), usage: usage(),
    };
  }
  const textAnswer = (text: string) => response([{ type: 'text', text }], 'stop');
  const toolAnswer = (name: string, args: ToolCall['arguments']) =>
    response([{ type: 'toolCall', id: `fixture-${name}-${parentTurns.length}-${childTurns.length}`, name, arguments: args }], 'toolUse');

  async function scriptedReply(role: 'Main' | 'parent' | 'childA' | 'childB', text: string): Promise<AssistantMessage> {
    if (role === 'Main') {
      mainTurns.push(text);
      if (mainTurns.length === 1) {
        return toolAnswer('subagent_create', { tasks: [{ name: 'HoldParent', task: PARENT_TASK }] });
      }
      return textAnswer(MAIN_ACK);
    }
    if (role === 'parent') {
      parentTurns.push(text);
      if (parentTurns.length === 1) {
        return toolAnswer('subagent_create', { tasks: [
          { name: 'ChildA', task: CHILD_A_TASK },
          { name: 'ChildB', task: CHILD_B_TASK },
        ] });
      }
      if (text.includes(REVIVE_MARKER)) {
        parentReplies.push(REVIVE_RESULT);
        return textAnswer(REVIVE_RESULT);
      }
      if (text.includes(CHILD_A_RESULT) && text.includes(CHILD_B_RESULT)) {
        parentReplies.push(PARENT_FINAL);
        return textAnswer(PARENT_FINAL);
      }
      const interim = text.includes(CHILD_A_RESULT)
        ? 'Parent observed the first child result; still waiting for the second child.'
        : 'Parent dispatched both children; waiting for their completion.';
      parentReplies.push(interim);
      return textAnswer(interim);
    }
    childTurns.push(`${role}:${text}`);
    await gates[role].promise;
    return textAnswer(role === 'childA' ? CHILD_A_RESULT : CHILD_B_RESULT);
  }

  runtime.streamSimple = (requestModel, context, options) => {
    assert.equal(requestModel.id, model.id);
    const stream = new AssistantMessageEventStream();
    void (async () => {
      try {
        const text = JSON.stringify(context);
        const message = await scriptedReply(roleOf(options?.sessionId, text), text);
        const reason = message.stopReason === 'toolUse' || message.stopReason === 'length' || message.stopReason === 'deferred'
          ? message.stopReason : 'stop';
        stream.push({ type: 'done', reason, message });
        stream.end();
      } catch (error) {
        scriptErrors.push(error);
        const failure: AssistantMessage = {
          ...response([], 'error'),
          errorMessage: error instanceof Error ? error.message : String(error),
        };
        stream.push({ type: 'error', reason: 'error', error: failure });
        stream.end();
      }
    })();
    return stream;
  };

  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: 'off',
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [{ name: 'parent-hold-sdk', factory: subagentExtension }],
  });

  let session: AgentSession | undefined;
  let toolCall = 0;
  try {
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    const created = await createAgentSession({
      cwd, agentDir, modelRuntime: runtime, model, sessionManager,
      settingsManager, resourceLoader,
    });
    session = created.session;
    const extensionErrors: unknown[] = [];
    await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
    session.setActiveToolsByName([
      ...session.getActiveToolNames(), 'subagent_create', 'subagent_list', 'subagent_stop',
    ]);

    const branchEntries = (): JsonRecord[] =>
      session!.sessionManager.getBranch().map((entry) => entry as unknown as JsonRecord);
    const harnessJobs = (agentId: string): JsonRecord[] => branchEntries().filter((entry) => {
      if (entry['type'] !== 'custom' || entry['customType'] !== 'subagent-job') return false;
      return asRecord(entry['data'])?.['agentId'] === agentId;
    });
    const harnessJobEnds = (agentId: string): JsonRecord[] => branchEntries().filter((entry) => {
      if (entry['type'] !== 'custom' || entry['customType'] !== 'subagent-job-end') return false;
      const jobId = asRecord(entry['data'])?.['jobId'];
      return typeof jobId === 'string' && (jobId === agentId || jobId.startsWith(`${agentId}#r`));
    });
    const hostNotices = (): JsonRecord[] => branchEntries().filter((entry) => {
      const details = asRecord(entry['details']);
      return entry['type'] === 'custom_message' && details?.['source'] === 'host';
    });
    const parentNotices = (): JsonRecord[] => hostNotices().filter((entry) =>
      asRecord(entry['details'])?.['sourceId'] === PARENT_ID);

    const execute = async (name: string, params: Record<string, unknown>) => {
      const tool = session!.getToolDefinition(name);
      assert.ok(tool, `missing native tool ${name}`);
      return tool.execute(`parent-hold-${++toolCall}`, params, undefined, undefined,
        session!.extensionRunner.createToolContext(`parent-hold-${toolCall}`, undefined));
    };
    const publishedTree = async (): Promise<PublishedNode> => {
      const result = await execute('subagent_list', { all: true });
      return result.details as PublishedNode;
    };

    await session.prompt(ROOT_TASK);

    // The children's providers stay gated here. The parent has already ended
    // its model turn with interim text, so this is exactly the old false
    // terminal window: a correct runtime keeps the original Job running.
    const held = await waitFor(async () => {
      if (parentTurns.length < 2 || parentReplies.length < 1) return null;
      const tree = await publishedTree();
      const parent = nodeById(tree, PARENT_ID);
      const first = nodeById(tree, CHILD_A_ID);
      const second = nodeById(tree, CHILD_B_ID);
      const terminal = harnessJobEnds(PARENT_ID).length > 0 || parentNotices().length > 0;
      return parent.status === 'running' && first.status === 'running' && second.status === 'running' && !terminal
        ? { tree }
        : null;
    }, {
      label: 'Depth-1 to stay running with both Depth-2 providers held, with no terminal notice or continuation Job/Budget',
      timeoutMs: 10000,
    });
    assert.equal(nodeById(held.tree, PARENT_ID).status, 'running');
    assert.equal(nodeById(held.tree, CHILD_A_ID).status, 'running');
    assert.equal(nodeById(held.tree, CHILD_B_ID).status, 'running');
    assert.equal(nodeById(held.tree, PARENT_ID).history, undefined, 'a running parent has no finalized history yet');

    const parentJobsHeld = harnessJobs(PARENT_ID);
    assert.equal(parentJobsHeld.length, 1, 'the held parent owns exactly one original Job');
    const heldJobData = asRecord(parentJobsHeld[0]?.['data']);
    assert.equal(heldJobData?.['jobId'], PARENT_ID);
    assert.equal(heldJobData?.['continuedFromJobId'], null);
    assert.equal(harnessJobEnds(PARENT_ID).length, 0, 'no Job end (and therefore no budget snapshot) is published while held');
    assert.equal(parentNotices().length, 0, 'the interim text must not reach Main as a terminal notification');
    assert.deepEqual(hostNotices(), [], 'no child or parent terminal notice may be published while both children run');
    assert.equal(parentReplies.filter((reply) => reply === PARENT_FINAL).length, 0, 'the final combined text cannot exist before the children finish');

    // Release the first child only. The parent must process its completion in
    // the same original Job and merely keep waiting for the second child.
    childA.resolve();
    await waitFor(() => parentTurns.length >= 3 && parentReplies.length >= 2, {
      label: 'Depth-1 to handle the first child completion inside its original Job',
      timeoutMs: 10000,
    });
    const firstCompletionTurn = parentTurns[2] ?? '';
    assert.ok(firstCompletionTurn.includes(CHILD_A_RESULT), 'the parent model receives the first child result');
    assert.ok(!firstCompletionTurn.includes(CHILD_B_RESULT), 'the second child has not completed yet');
    assert.equal(harnessJobs(PARENT_ID).length, 1, 'the first child completion must not allocate a continuation Job');
    assert.equal(harnessJobEnds(PARENT_ID).length, 0, 'the first child completion must not end the original Job');
    assert.equal(parentNotices().length, 0, 'the first child completion must not notify Main about the parent');
    assert.equal(parentReplies.filter((reply) => reply === PARENT_FINAL).length, 0, 'the parent still cannot answer before the second child finishes');

    // Release the second child. With both results present the parent gives its
    // one combined final answer and the original Job ends exactly once.
    childB.resolve();
    await waitFor(() => parentNotices().length === 1 && harnessJobEnds(PARENT_ID).length === 1, {
      label: 'one parent terminal notification and one Job end after the original Job completes',
      timeoutMs: 15000,
    });
    await session.waitForIdle();

    assert.equal(scriptErrors.length, 0, JSON.stringify(scriptErrors));
    assert.equal(parentReplies.filter((reply) => reply === PARENT_FINAL).length, 1, 'the parent returns the final combined text exactly once');
    assert.equal(parentTurns.at(-1)?.includes(CHILD_A_RESULT), true);
    assert.equal(parentTurns.at(-1)?.includes(CHILD_B_RESULT), true);

    const jobsAfterCompletion = harnessJobs(PARENT_ID);
    assert.equal(jobsAfterCompletion.length, 1, 'the original Job is the only parent Job (no rounds 2 or 3)');
    assert.equal(asRecord(jobsAfterCompletion[0]?.['data'])?.['jobId'], PARENT_ID);
    const ends = harnessJobEnds(PARENT_ID);
    assert.equal(ends.length, 1);
    const endData = asRecord(ends[0]?.['data']);
    assert.equal(endData?.['jobId'], PARENT_ID);
    assert.equal(endData?.['status'], 'completed');
    assert.ok(asRecord(endData?.['budget']) !== null, 'the one completed round owns the one budget snapshot');

    const notices = parentNotices();
    assert.equal(notices.length, 1, 'Main receives exactly one parent terminal notification');
    const notice = asRecord(notices[0]?.['details']);
    assert.equal(notice?.['sourceId'], PARENT_ID);
    assert.equal(notice?.['round'], 1, 'the notification stays on round 1');
    assert.equal(notice?.['jobId'], PARENT_ID);
    assert.equal(notice?.['status'], 'completed');
    const noticeContent = notices[0]?.['content'];
    assert.equal(typeof noticeContent, 'string');
    assert.ok((noticeContent as string).includes(PARENT_FINAL), 'the terminal notice carries the combined final answer');
    assert.equal((noticeContent as string).split(PARENT_FINAL).length - 1, 1);
    assert.match(noticeContent as string, /\[Subagent sub_01 completed \(round 1\)\]/);
    assert.doesNotMatch(noticeContent as string, /round (?:2|3)\)/);
    assert.equal((noticeContent as string).includes(parentReplies[1] ?? '\u0000'), false,
      'the earlier interim reply is not republished as terminal content');

    const publishedFinal = nodeById(await publishedTree(), PARENT_ID);
    assert.equal(publishedFinal.status, 'stopped');
    assert.equal(publishedFinal.history?.jobId, PARENT_ID, 'the completed parent Job is still the original round-1 Job');
    assert.ok(publishedFinal.history?.result);
    assert.equal(await readFile(publishedFinal.history.result, 'utf8'), PARENT_FINAL);

    const parentRows = branchEntries().filter((entry) => {
      if (entry['type'] !== 'custom') return false;
      const jobId = asRecord(entry['data'])?.['jobId'];
      return typeof jobId === 'string' && (jobId === PARENT_ID || jobId.startsWith(`${PARENT_ID}#`));
    });
    assert.equal(parentRows.length, 3, 'the original Job writes exactly one registration/start/end triple');
    assert.deepEqual(
      parentRows.map((entry) => entry['customType']).sort(),
      ['subagent-job', 'subagent-job-end', 'subagent-job-start'],
    );
    assert.equal(hostNotices().map((entry) => asRecord(entry['details'])?.['sourceId']).join(','), PARENT_ID,
      'no Depth-2 terminal notice is routed to Main');
    assert.ok(mainTurns.some((turn) => turn.includes('[Subagent sub_01 completed (round 1)]')),
      'Main is woken for the parent round-1 terminal notice');
    assert.ok(!mainTurns.some((turn) => /\[Subagent sub_01 completed \(round (?:2|3)\)\]/.test(turn)),
      'Main is never woken by an automatic parent Round 2/3');
    assert.deepEqual(extensionErrors, []);

    // Only a fully stopped parent can be revived, and that explicit write is
    // the sole source of round 2.
    const stoppedParent = nodeById(await publishedTree(), PARENT_ID);
    assert.equal(stoppedParent.status, 'stopped');
    assert.ok(stoppedParent.socket);
    await execute('msg_write', { path: stoppedParent.socket, content: REVIVE_MARKER });
    const revived = await waitFor(async () => {
      const node = nodeById(await publishedTree(), PARENT_ID);
      return node.status === 'stopped' && node.history?.jobId === `${PARENT_ID}#r2` ? node : null;
    }, { label: 'explicit msg_write revives the stopped parent as round 2', timeoutMs: 15000 });
    await session.waitForIdle();

    assert.equal(parentReplies.at(-1), REVIVE_RESULT);
    const reviveTurn = parentTurns.at(-1) ?? '';
    assert.ok(reviveTurn.includes(REVIVE_MARKER), 'the explicit continuation reaches the parent conversation');
    assert.equal(reviveTurn.split(PARENT_TASK).length - 1, 1, 'the original assignment is history, not re-injected');
    assert.equal(await readFile(revived.history!.result!, 'utf8'), REVIVE_RESULT);

    const revivedJobs = harnessJobs(PARENT_ID).map((entry) => asRecord(entry['data']));
    assert.deepEqual(revivedJobs.map((data) => data?.['jobId']), [PARENT_ID, `${PARENT_ID}#r2`],
      'the explicit revival allocates exactly one continuation Job');
    assert.equal(revivedJobs[1]?.['continuedFromJobId'], PARENT_ID);
    const revivedNotices = parentNotices();
    assert.deepEqual(revivedNotices.map((entry) => asRecord(entry['details'])?.['round']), [1, 2]);
    assert.equal(asRecord(revivedNotices[1]?.['details'])?.['jobId'], `${PARENT_ID}#r2`);
    const revivedContent = revivedNotices[1]?.['content'];
    assert.equal(typeof revivedContent, 'string');
    assert.ok((revivedContent as string).includes(REVIVE_RESULT));
    assert.equal((revivedContent as string).includes(PARENT_FINAL), false, 'round 2 publishes only its own final answer');
    assert.deepEqual(extensionErrors, []);
  } finally {
    childA.resolve();
    childB.resolve();
    try {
      await session?.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    } finally {
      session?.dispose();
      if (oldAgentDir === undefined) delete process.env['PI_CODING_AGENT_DIR'];
      else process.env['PI_CODING_AGENT_DIR'] = oldAgentDir;
      if (oldSocketDir === undefined) delete process.env['PI_SUBAGENT_SOCKET_DIR'];
      else process.env['PI_SUBAGENT_SOCKET_DIR'] = oldSocketDir;
      await rm(cwd, { recursive: true, force: true });
    }
  }
});
