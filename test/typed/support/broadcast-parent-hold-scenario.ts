import assert from 'node:assert/strict';
import { getBroadcastSocketPath } from '../../../src/ipc/socket.ts';
import { createdItems, deliverBroadcast, isSubagentError, listedActors, waitForCondition, type ScenarioFixture } from './subagent-sdk-fixture.ts';

/** Broadcast membership stays topological even when a parent consumes later child results. */
export async function runHierarchicalBroadcastScenario(fixture: ScenarioFixture): Promise<void> {
  const { controls, chats, call, textAnswer, toolAnswer, stopped, sessionSocketDir } = fixture;
  const exit = fixture.gate();
  controls.chat = async request => {
    const spawned = request.context.messages.some(message => message.role === 'toolResult' && message.toolName === 'subagent_create');
    if (request.text.includes('SPAWN_MARKER') && !spawned) {
      return toolAnswer('subagent_create', { tasks: [{ name: 'ChildOne', task: 'Child assignment one' },
        { name: 'ChildTwo', task: 'Child assignment two' }] }, 'create-children');
    }
    if (request.text.includes('SPAWN_MARKER')) {
      const broadcastSent = request.context.messages.some(message => message.role === 'toolResult' && message.toolName === 'msg_write');
      if (spawned && !broadcastSent) return toolAnswer('msg_write', {
        path: getBroadcastSocketPath('sub_01', sessionSocketDir), content: 'CHILD_BROADCAST_ONLY',
      }, 'child-broadcast');
    }
    await exit.promise;
    return textAnswer('Local actor finished');
  };
  const assignments = ['SPAWN_MARKER parent assignment', 'Sibling assignment two', 'Sibling assignment three', 'Sibling assignment four'];
  const roots = createdItems(await call('subagent_create', { tasks: assignments.map(task => ({ task })) }));
  const children = await waitForCondition(async () => {
    const found = listedActors(await call('subagent_list', {})).filter(actor => roots.some(root => actor.id.startsWith(`${root.id}_`)));
    return found.length === 2 && found.every(actor => actor.status === 'running') &&
      chats.filter(request => request.text.includes('Child assignment')).length === 2 ? found : undefined;
  }, 'depth-2 children run alongside four active parents');
  assert.ok(children);
  assert.deepEqual(children.map(child => child.id), ['sub_01_01', 'sub_01_02']);
  await assert.rejects(call('msg_write', { path: getBroadcastSocketPath('sub_01', sessionSocketDir), content: 'OVERSTEP' }),
    error => isSubagentError(error, 'invalid_target'));
  await deliverBroadcast(fixture, getBroadcastSocketPath('Main', sessionSocketDir), 'ROOT_BROADCAST_ONLY');
  exit.resolve();
  await Promise.all([...roots, ...children].map(actor => stopped(actor.id)));
  const childRequests = chats.filter(request => request.text.includes('Child assignment'));
  assert.ok(childRequests.every(request => !request.text.includes('ROOT_BROADCAST_ONLY')), 'Main does not broadcast recursively');
  for (const name of ['Child assignment one', 'Child assignment two']) {
    const last = childRequests.findLast(request => request.text.includes(name));
    assert.ok(last);
    assert.match(last.text, /CHILD_BROADCAST_ONLY/);
  }
  const rootRequests = chats.filter(request => !request.text.includes('Child assignment'));
  assert.ok(rootRequests.every(request => !request.text.includes('CHILD_BROADCAST_ONLY')), 'child broadcasts do not reach ancestors or peers');
  for (const assignment of assignments) {
    assert.ok(rootRequests.some(request => request.text.includes(assignment) && request.text.includes('ROOT_BROADCAST_ONLY')),
      `root broadcast reaches ${assignment}`);
  }
}
