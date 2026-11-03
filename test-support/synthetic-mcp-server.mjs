#!/usr/bin/env node
/**
 * Synthetic MCP server for offline SDK acceptance tests.
 *
 * Newline-delimited JSON-RPC 2.0 over stdin/stdout, the framing Pi's
 * `StdioTransport` uses. It exposes one tool and one resource and never touches
 * the network, the filesystem or the environment.
 */
import { writeFile } from 'node:fs/promises';
import process from 'node:process';

// A test that spawns this server records the pid so it can terminate it, since
// the SDK transport keeps the child handle open after the session is disposed.
if (process.env['MCP_FIXTURE_PID_FILE']) {
  await writeFile(process.env['MCP_FIXTURE_PID_FILE'], String(process.pid));
}

const FALLBACK_PROTOCOL_VERSION = '2025-06-18';
const TOOL_NAME = 'deploy';
const RESOURCE_URI = 'memory://fixture';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request) {
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
        result: {
          tools: [{
            name: TOOL_NAME,
            description: 'Deploy through the synthetic MCP fixture',
            inputSchema: { type: 'object', properties: {} },
          }],
        },
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
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(`synthetic-mcp-server: ${String(error)}\n`);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
