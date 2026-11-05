#!/usr/bin/env node
/**
 * Synthetic MCP server for offline SDK acceptance tests.
 *
 * Newline-delimited JSON-RPC 2.0 over stdin/stdout, the framing Pi's
 * `StdioTransport` uses. It exposes one tool and one resource and never touches
 * the network, the filesystem or the environment.
 *
 * With `MCP_FIXTURE_TOOLS_FILE` set, `tools/list` answers from that JSON file on
 * every call instead of the built-in tool. A test can rewrite the file and drive
 * Pi's native `/mcp reconnect` to exercise a server whose tool list changed,
 * without a second fixture server or a second MCP client.
 */
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

// A test that spawns this server records the pid so it can terminate it, since
// the SDK transport keeps the child handle open after the session is disposed.
if (process.env['MCP_FIXTURE_PID_FILE']) {
  await writeFile(process.env['MCP_FIXTURE_PID_FILE'], String(process.pid));
}

const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const TOOL_NAME = 'deploy';
const RESOURCE_URI = 'memory://fixture';
const TOOLS_FILE = process.env['MCP_FIXTURE_TOOLS_FILE'];

/** Tools the server currently offers; the built-in fixture tool by default. */
async function currentTools() {
  if (!TOOLS_FILE) {
    return [{
      name: TOOL_NAME,
      description: 'Deploy through the synthetic MCP fixture',
      inputSchema: { type: 'object', properties: {} },
    }];
  }
  try {
    const parsed = JSON.parse(await readFile(TOOLS_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((tool) => typeof tool?.name === 'string' && tool.name !== '')
      .map((tool) => ({
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: { type: 'object', properties: {} },
      }));
  } catch {
    return [];
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  // Notifications carry no id and expect no answer.
  if (id === undefined) return;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: typeof params?.protocolVersion === 'string'
            ? params.protocolVersion
            : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'manual_fixture', version: '1.0.0' },
          instructions: 'SYNTHETIC_MCP_FIXTURE',
        },
      });
      return;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id,
        result: { tools: await currentTools() },
      });
      return;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'MCP_DEPLOY_EXECUTED' }] },
      });
      return;
    case 'resources/list':
      send({
        jsonrpc: '2.0',
        id,
        result: { resources: [{ uri: RESOURCE_URI, name: 'fixture', mimeType: 'text/plain' }] },
      });
      return;
    case 'resources/templates/list':
      send({ jsonrpc: '2.0', id, result: { resourceTemplates: [] } });
      return;
    case 'resources/read':
      send({
        jsonrpc: '2.0',
        id,
        result: { contents: [{ uri: RESOURCE_URI, mimeType: 'text/plain', text: 'SYNTHETIC_MCP_RESOURCE' }] },
      });
      return;
    default:
      send({ jsonrpc: '2.0', id, result: {} });
  }
}

let buffer = '';
// `tools/list` may read the fixture file, so requests are answered in order
// through one promise chain instead of inside the data callback.
let queue = Promise.resolve();
function enqueue(line) {
  queue = queue.then(async () => {
    try {
      await handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`synthetic-mcp-server: ${String(error)}\n`);
    }
  });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') continue;
    enqueue(line);
  }
});
process.stdin.on('end', () => { void queue.then(() => process.exit(0)); });
