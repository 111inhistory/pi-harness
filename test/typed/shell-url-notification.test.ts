import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { sendApprovalNotification } from '../../src/shell-approval/url-notification.ts';

interface Received {
  method: string;
  path: string;
  contentType: string | undefined;
  body: string;
}

interface Receiver {
  readonly url: string;
  readonly requests: Received[];
  close(): Promise<void>;
}

async function receiver(handler: (request: Received, response: http.ServerResponse) => void): Promise<Receiver> {
  const requests: Received[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const received = {
        method: request.method ?? '',
        path: request.url ?? '',
        contentType: request.headers['content-type'],
        body,
      };
      requests.push(received);
      handler(received, response);
    });
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => { server.close(() => resolve()); });
    },
  };
}

test('approval notification is POSTed as exact JSON to the configured endpoint', async () => {
  const target = await receiver((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"code":200,"message":"success"}');
  });
  try {
    await sendApprovalNotification(`${target.url}/synthetic-device-key`, {
      title: 'Approval required', body: 'bash: npm publish',
    });
    assert.equal(target.requests.length, 1);
    const [request] = target.requests;
    assert.equal(request?.method, 'POST');
    assert.equal(request?.path, '/synthetic-device-key');
    assert.equal(request?.contentType, 'application/json');
    assert.deepEqual(JSON.parse(request?.body ?? ''), { title: 'Approval required', body: 'bash: npm publish' });
  } finally {
    await target.close();
  }
});

test('empty notification URL is a no-op without contacting any endpoint', async () => {
  await sendApprovalNotification('', { title: 'Approval required', body: 'bash: npm publish' });
  await sendApprovalNotification('', { title: '', body: '' }, AbortSignal.abort());
});

test('failure statuses reject with one fixed error, leak no destination, and are not retried', async () => {
  const target = await receiver((_request, response) => {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end('{"message":"synthetic provider detail synthetic-device-key"}');
  });
  try {
    const url = `${target.url}/synthetic-device-key`;
    let error: unknown;
    try {
      await sendApprovalNotification(url, { title: 'Approval required', body: 'bash: npm publish' });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'Shell approval notification failed.');
    assert.equal(error.message.includes('http'), false);
    assert.equal(error.message.includes('synthetic-device-key'), false);
    assert.equal(error.message.includes('provider detail'), false);
    assert.equal(target.requests.length, 1, 'no retry after a failed status');
  } finally {
    await target.close();
  }
});

const fixedFailure = (destination: string) => (error: unknown): boolean => error instanceof Error
  && error.message === 'Shell approval notification failed.'
  && !error.message.includes(destination)
  && !error.message.includes('synthetic-device-key');

test('redirects are rejected instead of followed, with the fixed error', async () => {
  const target = await receiver((_request, response) => {
    response.writeHead(302, { Location: '/elsewhere' });
    response.end();
  });
  try {
    await assert.rejects(
      sendApprovalNotification(`${target.url}/synthetic-device-key`, { title: 'Approval required', body: 'bash' }),
      fixedFailure(target.url),
    );
    assert.equal(target.requests.length, 1, 'redirects are not followed or retried');
  } finally {
    await target.close();
  }
});

test('network failures reject with the same fixed error and leak no destination', async () => {
  const closed = await receiver((_request, response) => { response.end(); });
  const url = `${closed.url}/synthetic-device-key`;
  await closed.close();
  await assert.rejects(sendApprovalNotification(url, { title: 'Approval required', body: 'bash' }), fixedFailure(closed.url));
});

test('caller cancellation aborts an unanswered request with the fixed error', async () => {
  let arrived: () => void = () => {};
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  let pending: http.ServerResponse | undefined;
  const target = await receiver((_request, response) => { pending = response; arrived(); });
  try {
    const controller = new AbortController();
    const sending = sendApprovalNotification(
      `${target.url}/synthetic-device-key`,
      { title: 'Approval required', body: 'bash: npm publish' },
      controller.signal,
    );
    await reached;
    controller.abort();
    await assert.rejects(sending, fixedFailure(target.url));
    assert.equal(target.requests.length, 1, 'cancellation does not reopen the request');
  } finally {
    pending?.destroy();
    await target.close();
  }
});

test('an unanswered request gives up after the fixed timeout without exposing the destination', { timeout: 10_000 }, async () => {
  let arrived: () => void = () => {};
  const reached = new Promise<void>(resolve => { arrived = resolve; });
  let pending: http.ServerResponse | undefined;
  const target = await receiver((_request, response) => { pending = response; arrived(); });
  try {
    const started = Date.now();
    const sending = sendApprovalNotification(`${target.url}/synthetic-device-key`, { title: 'Approval required', body: 'bash' });
    await reached;
    await assert.rejects(sending, fixedFailure(target.url));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 2_900, `timeout fired too early (${elapsed}ms)`);
    assert.ok(elapsed < 9_000, `timeout did not fire in time (${elapsed}ms)`);
  } finally {
    pending?.destroy();
    await target.close();
  }
});
