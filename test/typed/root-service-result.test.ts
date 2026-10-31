import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { SessionManager, DEFAULT_MAX_LINES } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { RootService } from '../../src/subagent/root-service.ts';
import type { DeliveryCustomMessage } from '../../src/subagent/delivery.ts';

for (const durable of [false, true]) {
  test(`direct results preserve rounds and raw artifacts (${durable ? 'durable' : 'memory'})`, async (t) => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'pi-direct-result-'));
    const sent: DeliveryCustomMessage[] = [];
    const manager = durable ? SessionManager.create(cwd, path.join(cwd, 'sessions')) : SessionManager.inMemory(cwd);
    const context = { cwd, sessionManager: manager, modelRegistry: { find: () => undefined }, isIdle: () => true } as unknown as ExtensionContext;
    const api = { appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], registerTool() {},
      sendMessage: (message: DeliveryCustomMessage) => { sent.push(message); } } as unknown as ExtensionAPI;
    const service = new RootService({ api, context, agentDir: path.join(cwd, 'agent'), allocatedIds: new Set(), ownsContext: () => true });
    const short = '  FIRST_ROUND_ONLY\n$&\n';
    const long = `SECOND_ROUND_ONLY\n${'line\n'.repeat(DEFAULT_MAX_LINES + 3)}  END_WITHOUT_TRIMMING  `;
    const outputs = [short, long];
    service.runner.start = (request) => {
      request.recordStart(null);
      return { ready: Promise.resolve(), done: Promise.resolve({ status: 'completed', result: outputs.shift() ?? '' }), cancel() {} };
    };
    t.after(async () => { await service.retire(); await rm(cwd, { recursive: true, force: true }); });
    await service.initialize();
    const actor = service.runtime.create({ tasks: [{ task: 'ASSIGNMENT_NOT_RESULT' }] }).items[0]!;
    await service.runtime.jobDone(actor.id);
    const first = sent[0]!;
    assert.ok(first.content.startsWith(short));
    assert.equal(first.content.split('FIRST_ROUND_ONLY').length - 1, 1, 'result is not duplicated in metadata');
    assert.ok(!first.content.includes('ASSIGNMENT_NOT_RESULT'));
    const wake = await service.runtime.sendMessage({ from: 'Main', to: actor.id, content: 'CONTINUE_INPUT_NOT_RESULT' });
    assert.ok('jobId' in wake && wake.jobId);
    await service.runtime.jobDone(wake.jobId);
    const second = sent[1]!;
    assert.ok(second.content.startsWith('SECOND_ROUND_ONLY'));
    assert.ok(!second.content.includes('FIRST_ROUND_ONLY'));
    assert.ok(!second.content.includes('CONTINUE_INPUT_NOT_RESULT'));
    assert.equal(second.details.round, 2);
    assert.equal(second.details.jobId, wake.jobId);
    const file = /Full result: (.+)\]/.exec(second.content)?.[1];
    assert.ok(file, 'truncated delivery points to an existing raw current-round result');
    assert.equal(await readFile(file, 'utf8'), long);
    if (durable) {
      const tree = await service.list({ id: actor.id }, 'Main');
      assert.equal(tree?.history?.result, file);
      await rm(file);
      await service.list({ id: actor.id }, 'Main');
      assert.equal(await readFile(file, 'utf8'), long, 'missing raw result rebuilds from stored Job output');
    } else {
      assert.equal((await service.list({}, 'Main'))?.historyDir, undefined);
      await service.retire();
      assert.equal(await readFile(file, 'utf8'), long, 'root retirement does not invalidate delivered paths');
      t.after(() => rm(path.dirname(file), { recursive: true, force: true }));
    }
  });
}

test('artifact failure keeps bounded delivery and the completed status', async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'pi-result-write-failure-'));
  const sent: DeliveryCustomMessage[] = [];
  const manager = SessionManager.create(cwd, path.join(cwd, 'sessions'));
  const context = { cwd, sessionManager: manager, modelRegistry: { find: () => undefined }, isIdle: () => true } as unknown as ExtensionContext;
  const api = { appendEntry() {}, getAllTools: () => [], getActiveTools: () => [], registerTool() {},
    sendMessage: (message: DeliveryCustomMessage) => { sent.push(message); } } as unknown as ExtensionAPI;
  const service = new RootService({ api, context, agentDir: path.join(cwd, 'agent'), allocatedIds: new Set(), ownsContext: () => true });
  t.after(async () => { await service.retire(); await rm(cwd, { recursive: true, force: true }); });
  await service.initialize();
  const dir = (await service.list({}, 'Main'))?.historyDir;
  assert.ok(dir);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'sub_01'), 'BLOCK_DIRECTORY');
  service.runner.start = () => ({ ready: Promise.resolve(), done: Promise.resolve({ status: 'completed', result: 'line\n'.repeat(DEFAULT_MAX_LINES + 3) }), cancel() {} });
  const actor = service.runtime.create({ tasks: [{ task: 'complete despite artifact failure' }] }).items[0]!;
  const ended = await service.runtime.jobDone(actor.id);
  assert.equal(ended.status, 'completed');
  assert.equal(ended.historyState, 'error');
  const notice = sent[0]!;
  assert.equal(notice.details.status, 'completed');
  assert.ok(notice.content.includes('Full result file unavailable'));
  assert.ok(!notice.content.includes('Full result: '));
});
