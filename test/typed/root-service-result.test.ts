import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { SessionManager, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { RootService } from '../../src/subagent/root-service.ts';
import { SUBAGENT_SESSIONS_DIR } from '../../src/subagent/storage.ts';
import type { DeliveryCustomMessage } from '../../src/subagent/delivery.ts';

for (const durable of [false, true]) {
  test(`a finished Job stores its full raw result without synthesizing a message (${durable ? 'durable' : 'memory'})`, async (t) => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'pi-direct-result-'));
    const sent: DeliveryCustomMessage[] = [];
    const manager = durable ? SessionManager.create(cwd, path.join(cwd, 'sessions')) : SessionManager.inMemory(cwd);
    const context = { cwd, sessionManager: manager, modelRegistry: { find: () => undefined }, isIdle: () => true } as unknown as ExtensionContext;
    const api = { appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], registerTool() {},
      sendMessage: (message: DeliveryCustomMessage) => { sent.push(message); } } as unknown as ExtensionAPI;
    const service = new RootService({ api, context, agentDir: path.join(cwd, 'agent'), allocatedIds: new Set(), ownsContext: () => true });
    const first = '  FIRST_ROUND_ONLY\n$&\n';
    const second = `SECOND_ROUND_ONLY\n${'line\n'.repeat(DEFAULT_MAX_LINES + 3)}  END_WITHOUT_TRIMMING  `;
    const outputs = [first, second];
    service.runner.start = (request) => {
      request.recordStart(null);
      return { ready: Promise.resolve(), done: Promise.resolve({ status: 'completed', result: outputs.shift() ?? '' }), cancel() {} };
    };
    t.after(async () => { await service.retire(); await rm(cwd, { recursive: true, force: true }); });
    await service.initialize();
    const actor = service.runtime.create({ agents: [{ goal: 'PERSISTENT_GOAL' }] }).items[0]!;
    await service.runtime.jobDone(actor.id);
    assert.equal(service.runtime.jobRecord(actor.id)?.result, first, 'the Job record keeps the raw text, untrimmed');
    assert.equal(sent.length, 0, 'a normal finish never becomes a collaborator message');

    const wake = await service.runtime.sendMessage({ from: 'main', to: actor.address, content: 'CONTINUE_INPUT_NOT_RESULT' });
    assert.ok('jobId' in wake && wake.jobId);
    await service.runtime.jobDone(wake.jobId);
    assert.equal(service.runtime.jobRecord(wake.jobId)?.result, second);
    assert.equal(sent.length, 0, 'a continuation finish is an internal state change only');

    if (durable) {
      const tree = await service.list({ id: actor.id }, 'main');
      const resultPath = tree?.history?.result;
      assert.ok(resultPath, 'the durable view exposes its raw result path');
      assert.equal(await readFile(resultPath, 'utf8'), second);
      await rm(resultPath);
      await service.list({ id: actor.id }, 'main');
      assert.equal(await readFile(resultPath, 'utf8'), second, 'a missing view is rebuilt from stored Job output');
    } else {
      const root = await service.list({}, 'main');
      assert.ok(root);
      assert.equal("historyDir" in root, false, 'memory-only list never advertises durable history');
      assert.equal(sent.length, 0);
    }
  });
}

test('a failed view write keeps the completed status and is reported as history state', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-result-write-failure-'));
  const sent: DeliveryCustomMessage[] = [];
  const manager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
  const context = { cwd, sessionManager: manager, modelRegistry: { find: () => undefined }, isIdle: () => true } as unknown as ExtensionContext;
  const api = { appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], registerTool() {},
    sendMessage: (message: DeliveryCustomMessage) => { sent.push(message); } } as unknown as ExtensionAPI;
  const agentDir = path.join(cwd, 'agent');
  const service = new RootService({ api, context, agentDir, allocatedIds: new Set(), ownsContext: () => true });
  t.after(async () => { await service.retire(); await rm(cwd, { recursive: true, force: true }); });
  await service.initialize();
  // The views directory is internal storage, not a public list field.
  const views = path.join(agentDir, SUBAGENT_SESSIONS_DIR, manager.getSessionId(), 'views');
  // A file at the views directory makes every view write fail without touching
  // the Job's own record.
  await mkdir(path.dirname(views), { recursive: true });
  await writeFile(views, 'BLOCK_DIRECTORY');
  service.runner.start = () => ({ ready: Promise.resolve(),
    done: Promise.resolve({ status: 'completed', result: 'line\n'.repeat(DEFAULT_MAX_LINES + 3) }), cancel() {} });
  const actor = service.runtime.create({ agents: [{ goal: 'complete despite view failure' }] }).items[0]!;
  const ended = await service.runtime.jobDone(actor.id);
  assert.equal(ended.status, 'completed');
  assert.equal(ended.historyState, 'error');
  assert.equal(sent.length, 0, 'the view failure never fabricates a delivery');
});
