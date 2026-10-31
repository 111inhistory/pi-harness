import assert from 'node:assert/strict';
import { readTranscriptEvents, type FixtureActor, type ScenarioFixture } from './subagent-sdk-fixture.ts';

/** A child's message and terminal notice continue its parent's original Job. */
export async function runUpstreamParentHoldScenario(fixture: ScenarioFixture): Promise<void> {
  const { controls, create, item, stopped, textAnswer, toolAnswer, classifications, session } = fixture;
  const send = fixture.gate();
  const leafStarted = fixture.gate();
  const received = fixture.gate();
  let parent: FixtureActor;
  let parentRuns = 0;
  controls.chat = async request => {
    if (request.text.includes('UPSTREAM_LEAF')) {
      leafStarted.resolve();
      await send.promise;
      assert.match(request.text, /Your direct parent is sub_01/);
      assert.ok(request.text.includes(parent.socket));
      const wrote = request.context.messages.some(message => message.role === 'toolResult' && message.toolName === 'msg_write');
      if (!wrote) return toolAnswer('msg_write', { path: parent.socket, content: 'UPSTREAM_PARENT_MARKER' }, 'leaf-upstream-write');
      return textAnswer('Leaf done');
    }
    if (request.text.includes('UPSTREAM_PARENT')) {
      parentRuns++;
      const created = request.context.messages.some(message => message.role === 'toolResult' && message.toolName === 'subagent_create');
      if (!created) return toolAnswer('subagent_create', { tasks: [{ task: 'UPSTREAM_LEAF: send to your direct parent' }] });
      if (request.text.includes('UPSTREAM_PARENT_MARKER')) {
        assert.match(request.text, /\[Message from sub_01_01\]/);
        assert.ok(request.context.messages.some(message => message.role === 'user' &&
          (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).includes('[Message from sub_01_01]')));
        received.resolve();
      }
      return textAnswer('Parent done');
    }
    assert.fail('Depth 2 delivery must not wake Main');
  };
  parent = await create('UPSTREAM_PARENT: create a leaf, then finish');
  await leafStarted.promise;
  assert.equal((await item(parent.id))?.status, 'running', 'a held parent remains in its original running Job');
  const leaf = await item(`${parent.id}_01`);
  assert.ok(leaf);
  send.resolve();
  const leafDone = await stopped(leaf.id);
  assert.ok(leafDone.history);
  const leafEvents = await readTranscriptEvents(leafDone.history.cleanJsonl);
  const sent = leafEvents.find(event => event.role === 'toolResult' && event.toolName === 'msg_write');
  assert.ok(sent && !sent.isError, JSON.stringify(sent));
  await received.promise;
  const completed = await stopped(parent.id);
  assert.equal(completed.history?.jobId, parent.id, 'child activity does not allocate parent continuation Jobs');
  assert.ok(parentRuns >= 3 && parentRuns <= 4);
  assert.equal(classifications.length, 4, 'only original parent and leaf assignments are routed');
  assert.equal(session.messages.some(message => message.role === 'custom' && message.customType === 'agent-message'), false);
}
