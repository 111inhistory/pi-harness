import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  ATTACH_CHANNEL,
  ProtocolIOError,
  attachProtocolRouter,
  createProtocolOverrides,
  createProtocolRouter,
  installProtocolOverrides,
  parseProtocolUri,
} from "../src/protocol-io.mjs";

function protocolError(code) {
  return (error) => error instanceof ProtocolIOError && error.code === code;
}

// Mirrors dist/core/event-bus.js: `on` wraps the handler in an async function,
// so handler bodies run synchronously up to their first await, and a throwing
// handler is collected instead of disturbing the emitter.
function createTestBus() {
  const listeners = new Map();
  const errors = [];
  return {
    errors,
    emit(channel, data) {
      for (const handler of [...(listeners.get(channel) ?? [])]) {
        const safeHandler = async (value) => {
          try {
            await handler(value);
          } catch (error) {
            errors.push(error);
          }
        };
        void safeHandler(data);
      }
    },
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => {
        set.delete(handler);
        if (set.size === 0) listeners.delete(channel);
      };
    },
    count(channel) {
      return listeners.get(channel)?.size ?? 0;
    },
    clear() {
      listeners.clear();
    },
  };
}

// Minimal stand-ins for Pi's ExtensionAPI surface used by the installer.
function createTestPi(bus) {
  return {
    registrations: [],
    events: {
      emit: (channel, data) => bus.emit(channel, data),
      on: (channel, handler) => bus.on(channel, handler),
    },
    registerTool(definition) {
      this.registrations.push(definition);
    },
  };
}

// Minimal stand-ins for createReadToolDefinition/createWriteToolDefinition.
// They record how the override drives them and implement just enough native
// behavior (line offset/limit, a small line bound, a continuation notice) to
// prove which parameters and operations flow where. The real bound and the
// real filesystem access live in Pi's factories, which the extension injects;
// the bundled-loader smoke covers those.
function createNativeToolSpies() {
  const calls = [];
  const factoryCalls = [];

  const createNativeRead = (cwd, options) => {
    factoryCalls.push({ tool: "read", cwd, options });
    return {
      name: "read",
      label: "read",
      description: "Native read description.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Native read path description" },
          offset: { type: "number" },
          limit: { type: "number" },
        },
        required: ["path"],
        additionalProperties: false,
      },
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        calls.push({ tool: "read", cwd, options, params, toolCallId, ctx });
        if (!options?.operations) {
          return { content: [{ type: "text", text: `native-file:${params.path}` }], details: { nativeRead: true } };
        }
        await options.operations.access("virtual");
        const text = (await options.operations.readFile("virtual")).toString("utf8");
        const lines = text.split("\n");
        const start = params.offset ? Math.max(0, params.offset - 1) : 0;
        if (start >= lines.length) {
          throw new Error(`Offset ${params.offset} is beyond end of file (${lines.length} lines total)`);
        }
        const remaining = params.limit === undefined ? lines.length - start : Math.min(params.limit, lines.length - start);
        const selected = lines.slice(start, start + remaining);
        const MAX_LINES = 4;
        const bounded = selected.slice(0, MAX_LINES);
        let output = bounded.join("\n");
        if (selected.length > MAX_LINES) {
          output += `\n\n[Showing lines ${start + 1}-${start + MAX_LINES} of ${lines.length}. Use offset=${start + MAX_LINES + 1} to continue.]`;
        }
        return { content: [{ type: "text", text: output }], details: { nativeRead: true } };
      },
    };
  };

  const createNativeWrite = (cwd) => {
    factoryCalls.push({ tool: "write", cwd });
    return {
      name: "write",
      label: "write",
      description: "Native write description.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Native write path description" },
          content: { type: "string", description: "Native write content description" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        calls.push({ tool: "write", cwd, params, toolCallId, ctx });
        return { content: [{ type: "text", text: `native-write:${params.path}` }] };
      },
    };
  };

  return { calls, factoryCalls, createNativeRead, createNativeWrite };
}

const LINES = ["line1", "line2", "line3", "line4", "line5", "line6"].join("\n");

test("classifies protocol URIs by scheme and keeps the uri verbatim", () => {
  assert.deepEqual(parseProtocolUri("agent://agent_01/inbox"), { malformed: false, scheme: "agent", uri: "agent://agent_01/inbox" });
  assert.deepEqual(parseProtocolUri("Tool://Read"), { malformed: false, scheme: "tool", uri: "Tool://Read" });
  assert.deepEqual(parseProtocolUri("npm://pkg@1.2.3"), { malformed: false, scheme: "npm", uri: "npm://pkg@1.2.3" });
  assert.equal(parseProtocolUri("agent://").scheme, "agent");
  assert.equal(parseProtocolUri("mcp://server/tool").scheme, "mcp");
  assert.equal(parseProtocolUri("skill://a/b/c").scheme, "skill");
});

test("classifies explicit file:// URLs and keeps lone file: names as native paths", () => {
  assert.deepEqual(parseProtocolUri("file:///tmp/notes.md"), { malformed: false, scheme: "file", uri: "file:///tmp/notes.md" });
  assert.deepEqual(parseProtocolUri("FILE:///tmp/x"), { malformed: false, scheme: "file", uri: "FILE:///tmp/x" });
  assert.deepEqual(parseProtocolUri("file://"), { malformed: false, scheme: "file", uri: "file://" });
  assert.equal(parseProtocolUri("file:notes.txt"), null);
  assert.equal(parseProtocolUri("file:/tmp/x"), null);
});

test("does not treat filesystem paths as protocol URIs", () => {
  assert.equal(parseProtocolUri("./src/protocol-io.mjs"), null);
  assert.equal(parseProtocolUri("/tmp/x://y"), null);
  assert.equal(parseProtocolUri("dir/note://x"), null);
  assert.equal(parseProtocolUri("agent:foo"), null);
  assert.equal(parseProtocolUri("C:\\Users\\x"), null);
  assert.equal(parseProtocolUri(""), null);
  assert.equal(parseProtocolUri(42), null);
});

test("rejects malformed protocol prefixes instead of falling through to files", () => {
  assert.deepEqual(parseProtocolUri("://x"), { malformed: true, scheme: null, uri: "://x" });
  assert.deepEqual(parseProtocolUri("1x://y"), { malformed: true, scheme: null, uri: "1x://y" });
  assert.deepEqual(parseProtocolUri("a b://c"), { malformed: true, scheme: null, uri: "a b://c" });
});

test("treats drive-letter paths as files only on win32", () => {
  assert.equal(parseProtocolUri("C://tmp/x", { platform: "win32" }), null);
  assert.equal(parseProtocolUri("C:/tmp/x", { platform: "win32" }), null);
  assert.equal(parseProtocolUri("C://tmp/x", { platform: "linux" }).scheme, "c");
});

test("merges distinct schemes across installers and refuses duplicate ownership", async () => {
  const router = createProtocolRouter({ readers: { tool: async (uri) => `tool:${uri}` } });
  const dispose = router.register({
    readers: { Skill: async (uri) => `skill:${uri}` },
    writers: { agent: async (uri) => ({ ok: true, uri }) },
  });
  assert.deepEqual(router.readSchemes(), ["skill", "tool"]);
  assert.deepEqual(router.writeSchemes(), ["agent"]);
  assert.equal(await router.read("tool://read", {}), "tool:tool://read");
  assert.equal(await router.read("skill://x", {}), "skill:skill://x");

  assert.throws(() => router.register({ readers: { tool: async () => "intruder" } }), protocolError("conflicting_route"));
  assert.equal(await router.read("tool://read", {}), "tool:tool://read");

  dispose();
  assert.deepEqual(router.readSchemes(), ["tool"]);
  assert.deepEqual(router.writeSchemes(), []);
  router.register({ readers: { skill: async () => "again" } });
  assert.equal(await router.read("skill://y", {}), "again");
});

test("refuses unregistered, malformed and non-text reads before any handler runs", async () => {
  let calls = 0;
  const router = createProtocolRouter({
    readers: {
      tool: async (uri, ctx) => {
        calls += 1;
        return "ok";
      },
    },
  });
  await assert.rejects(
    () => router.read("npm://pkg", {}),
    (error) => protocolError("unsupported_protocol")(error) && error.message.includes("tool://"),
  );
  await assert.rejects(() => router.read("://x", {}), protocolError("invalid_protocol_uri"));

  const ctx = { cwd: "/tmp" };
  const seen = [];
  const echoing = createProtocolRouter({
    readers: {
      tool: async (uri, readCtx) => {
        seen.push([uri, readCtx]);
        return "text";
      },
    },
  });
  assert.equal(await echoing.read("Tool://Read", ctx), "text");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], "Tool://Read");
  assert.equal(seen[0][1], ctx);
  assert.equal(calls, 0);

  const notText = createProtocolRouter({ readers: { tool: async () => ({ body: "text" }) } });
  await assert.rejects(() => notText.read("tool://x", {}), protocolError("invalid_reader_result"));

  const failing = createProtocolRouter({ readers: { tool: async () => { throw new Error("registry miss"); } } });
  await assert.rejects(() => failing.read("tool://x", {}), /registry miss/);
});

test("writes report the writer's result and refuse read-only, malformed and non-text writes", async () => {
  const calls = [];
  const ctx = { cwd: "/tmp" };
  const router = createProtocolRouter({
    readers: { tool: async () => "text" },
    writers: {
      agent: async (uri, content, writeCtx) => {
        calls.push([uri, content, writeCtx]);
        return `accepted ${content} for ${uri}`;
      },
    },
  });

  assert.equal(await router.write("agent://Main", "hello", ctx), "accepted hello for agent://Main");
  assert.deepEqual(calls, [["agent://Main", "hello", ctx]]);

  await assert.rejects(() => router.write("tool://read", "x", ctx), protocolError("readonly_protocol"));
  await assert.rejects(() => router.write("npm://pkg", "x", ctx), protocolError("readonly_protocol"));
  await assert.rejects(() => router.write("://x", "hello", ctx), protocolError("invalid_protocol_uri"));
  await assert.rejects(() => router.write("agent://Main", { text: "no" }, ctx), protocolError("invalid_content"));
  assert.equal(calls.length, 1);
});

test("write results need no receipt shape, but unserializable output stays an error", async () => {
  const valueRouter = createProtocolRouter({ writers: { agent: async () => ({ ok: true, to: "agent://Main", jobId: "job_2" }) } });
  assert.equal(await valueRouter.write("agent://Main", "hi", {}), '{"ok":true,"to":"agent://Main","jobId":"job_2"}');

  const silent = createProtocolRouter({ writers: { agent: async () => undefined } });
  assert.equal(await silent.write("agent://x", "hi", {}), "Wrote to agent://x.");
  const nullRouter = createProtocolRouter({ writers: { agent: async () => null } });
  assert.equal(await nullRouter.write("agent://x", "hi", {}), "Wrote to agent://x.");

  const cyclic = {};
  cyclic.self = cyclic;
  const cyclicRouter = createProtocolRouter({ writers: { agent: async () => cyclic } });
  await assert.rejects(() => cyclicRouter.write("agent://x", "hi", {}), protocolError("invalid_writer_result"));

  const failing = createProtocolRouter({ writers: { agent: async () => { throw new Error("target missing"); } } });
  await assert.rejects(() => failing.write("agent://x", "hi", {}), /target missing/);
});

test("the file scheme is reserved for local files and never routes to a reader or writer", async () => {
  assert.throws(() => createProtocolRouter({ readers: { file: async () => "" } }), protocolError("reserved_scheme"));
  assert.throws(() => createProtocolRouter({ writers: { FILE: async () => "" } }), protocolError("reserved_scheme"));

  const router = createProtocolRouter({ readers: { agent: async () => "text" } });
  await assert.rejects(() => router.read("file:///tmp/x", {}), protocolError("reserved_scheme"));
  await assert.rejects(() => router.write("file:///tmp/x", "x", {}), protocolError("reserved_scheme"));
  assert.deepEqual(router.readSchemes(), ["agent"]);
});

test("an already-aborted call starts no protocol reader or writer", async () => {
  const seen = [];
  const router = createProtocolRouter({
    readers: { agent: async () => { seen.push("read"); return "text"; } },
    writers: { agent: async () => { seen.push("write"); return "sent"; } },
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => router.read("agent://x", {}, { signal: controller.signal }), /Operation aborted/);
  await assert.rejects(() => router.write("agent://Main", "hi", {}, { signal: controller.signal }), /Operation aborted/);

  const { createNativeRead, createNativeWrite } = createNativeToolSpies();
  const { read, write } = createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd: "/work" });
  const ctx = { cwd: "/work" };
  await assert.rejects(() => read.execute("c1", { path: "agent://x" }, controller.signal, undefined, ctx), /Operation aborted/);
  await assert.rejects(() => write.execute("c2", { path: "agent://Main", content: "hi" }, controller.signal, undefined, ctx), /Operation aborted/);
  assert.deepEqual(seen, []);
});

test("the caller signal reaches protocol handlers without touching the shared context", async () => {
  const controller = new AbortController();
  const ctx = { cwd: "/work" };
  const seen = [];
  const router = createProtocolRouter({
    readers: { agent: async (uri, readCtx, options) => { seen.push(["read", uri, readCtx, options]); return "agent body"; } },
    writers: { agent: async (uri, content, writeCtx, options) => { seen.push(["write", uri, writeCtx, options]); return "sent"; } },
  });
  const { createNativeRead, createNativeWrite } = createNativeToolSpies();
  const { read, write } = createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd: "/work" });

  const readResult = await read.execute("c1", { path: "agent://agent_01" }, controller.signal, undefined, ctx);
  const writeResult = await write.execute("c2", { path: "agent://Main", content: "ping" }, controller.signal, undefined, ctx);
  assert.equal(readResult.content[0].text, "agent body");
  assert.equal(writeResult.content[0].text, "sent");

  assert.deepEqual(seen.map((entry) => entry[0]), ["read", "write"]);
  assert.equal(seen[0][1], "agent://agent_01");
  assert.equal(seen[0][2], ctx);
  assert.equal(seen[0][3].signal, controller.signal);
  assert.equal(seen[1][1], "agent://Main");
  assert.equal(seen[1][2], ctx);
  assert.equal(seen[1][3].signal, controller.signal);
  assert.equal("signal" in ctx, false);
});

test("explicit file URLs read and write the path they name through the native tools", async () => {
  const { calls, factoryCalls, createNativeRead, createNativeWrite } = createNativeToolSpies();
  const router = createProtocolRouter({ readers: { agent: async () => "protocol" } });
  const { read, write } = createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd: "/work" });
  const ctx = { cwd: "/work" };
  const target = path.join(os.tmpdir(), "pi protocol", "read me.txt");

  const bare = await read.execute("c1", { path: target, offset: 2, limit: 3 }, undefined, undefined, ctx);
  assert.equal(bare.content[0].text, `native-file:${target}`);
  const factories = factoryCalls.length;

  const url = pathToFileURL(target);
  const spellings = [
    url.href,
    url.href.replace(/^file:/, "File:"),
    `file://localhost${url.pathname}`,
  ];
  for (const [index, href] of spellings.entries()) {
    const result = await read.execute(`f${index}`, { path: href, offset: 2, limit: 3 }, undefined, undefined, ctx);
    assert.equal(result.content[0].text, `native-file:${target}`);
    assert.deepEqual(calls.at(-1).params, { path: target, offset: 2, limit: 3 });
    assert.equal(calls.at(-1).ctx, ctx);
  }
  // Bare paths and file URLs share one native read definition and its settings.
  assert.equal(factoryCalls.length, factories);

  const writeTarget = path.join(os.tmpdir(), "pi protocol", "out.txt");
  const written = await write.execute("w1", { path: pathToFileURL(writeTarget).href, content: "hi" }, undefined, undefined, ctx);
  assert.equal(written.content[0].text, `native-write:${writeTarget}`);
  assert.deepEqual(calls.at(-1).params, { path: writeTarget, content: "hi" });
});

test("a lone file: prefix stays a native filename, not URL shorthand", async () => {
  const { calls, createNativeRead, createNativeWrite } = createNativeToolSpies();
  const router = createProtocolRouter({ readers: { agent: async () => "protocol" } });
  const { read, write } = createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd: "/work" });
  const ctx = { cwd: "/work" };

  const plain = await read.execute("c1", { path: "file:notes.txt" }, undefined, undefined, ctx);
  assert.equal(plain.content[0].text, "native-file:file:notes.txt");
  assert.deepEqual(calls.at(-1).params, { path: "file:notes.txt" });

  const nested = await read.execute("c2", { path: "file:/tmp/out.txt", offset: 1 }, undefined, undefined, ctx);
  assert.equal(nested.content[0].text, "native-file:file:/tmp/out.txt");
  assert.deepEqual(calls.at(-1).params, { path: "file:/tmp/out.txt", offset: 1 });

  const written = await write.execute("c3", { path: "file:log.md", content: "hi" }, undefined, undefined, ctx);
  assert.equal(written.content[0].text, "native-write:file:log.md");
  assert.deepEqual(calls.at(-1).params, { path: "file:log.md", content: "hi" });
});

test("file URLs that are not local paths fail without touching files or native tools", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "protocol-io-"));
  try {
    const { calls, createNativeRead, createNativeWrite } = createNativeToolSpies();
    const router = createProtocolRouter({ readers: { agent: async () => "text" } });
    const { read, write } = createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd: dir });
    const ctx = { cwd: dir };
    const broken = ["file:///%zz", "file:///tmp/%2Fetc"];
    // Windows resolves a file URL host as a UNC share, so only POSIX refuses it.
    if (process.platform !== "win32") broken.push("file://elsewhere/tmp/x");

    for (const [index, uri] of broken.entries()) {
      await assert.rejects(() => read.execute(`r${index}`, { path: uri }, undefined, undefined, ctx), protocolError("invalid_file_url"));
      await assert.rejects(
        () => write.execute(`w${index}`, { path: uri, content: "x" }, undefined, undefined, ctx),
        protocolError("invalid_file_url"),
      );
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("first installer owns the session router, later installers merge into it", async () => {
  const bus = createTestBus();
  const first = attachProtocolRouter(bus, { readers: { tool: async () => "tool-body" } });
  assert.equal(first.owner, true);

  const second = attachProtocolRouter(bus, {
    readers: { skill: async () => "skill-body" },
    writers: { agent: async () => ({ ok: true }) },
  });
  assert.equal(second.owner, false);
  assert.equal(second.router, first.router);
  assert.deepEqual(first.router.readSchemes(), ["skill", "tool"]);
  assert.equal(await second.router.read("skill://x", {}), "skill-body");
  assert.equal(await first.router.read("tool://x", {}), "tool-body");
  assert.equal(bus.count(ATTACH_CHANNEL), 1);
  assert.deepEqual(bus.errors, []);

  second.dispose();
  assert.deepEqual(first.router.readSchemes(), ["tool"]);
  assert.equal(await first.router.read("tool://x", {}), "tool-body");
});

test("a conflicting join fails without disturbing the owner's routes", async () => {
  const bus = createTestBus();
  const owner = attachProtocolRouter(bus, { readers: { tool: async () => "owned" } });
  assert.throws(
    () => attachProtocolRouter(bus, { readers: { tool: async () => "intruder" } }),
    protocolError("conflicting_route"),
  );
  assert.equal(await owner.router.read("tool://x", {}), "owned");
  assert.deepEqual(bus.errors, []);
});

test("separate sessions or buses do not share routes", async () => {
  const sessionA = createTestBus();
  const sessionB = createTestBus();
  const a = attachProtocolRouter(sessionA, { readers: { tool: async () => "A" } });
  const b = attachProtocolRouter(sessionB, { readers: { agent: async () => "B" } });
  assert.equal(a.owner, true);
  assert.equal(b.owner, true);
  assert.notEqual(a.router, b.router);
  await assert.rejects(() => b.router.read("tool://x", {}), protocolError("unsupported_protocol"));
  await assert.rejects(() => a.router.read("agent://x", {}), protocolError("unsupported_protocol"));
});

test("after an invalidate drops subscriptions, the next installer owns a fresh router", async () => {
  const bus = createTestBus();
  const old = attachProtocolRouter(bus, { readers: { tool: async () => "old" } });
  bus.clear();
  const fresh = attachProtocolRouter(bus, { readers: { agent: async () => "new" } });
  assert.equal(fresh.owner, true);
  assert.notEqual(fresh.router, old.router);
  assert.deepEqual(fresh.router.readSchemes(), ["agent"]);

  const joiner = attachProtocolRouter(bus, { readers: { skill: async () => "joined" } });
  assert.equal(joiner.owner, false);
  assert.deepEqual(fresh.router.readSchemes(), ["agent", "skill"]);

  old.dispose();
  await assert.rejects(() => old.router.read("tool://x", {}), protocolError("unsupported_protocol"));
});

test("ordinary file paths delegate to the native tools unchanged", async () => {
  const { calls, createNativeRead, createNativeWrite } = createNativeToolSpies();
  const router = createProtocolRouter({ readers: { tool: async () => "protocol" } });
  const { read, write } = createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd: "/work" });

  assert.equal(read.name, "read");
  assert.deepEqual(read.parameters.required, ["path"]);
  assert.equal(write.name, "write");
  assert.deepEqual(write.parameters.required, ["path", "content"]);

  const ctx = { cwd: "/work" };
  const readResult = await read.execute("call-1", { path: "src/a.mjs", offset: 3, limit: 9 }, undefined, undefined, ctx);
  assert.deepEqual(readResult, { content: [{ type: "text", text: "native-file:src/a.mjs" }], details: { nativeRead: true } });
  const writeResult = await write.execute("call-2", { path: "out.txt", content: "hi" }, undefined, undefined, ctx);
  assert.deepEqual(writeResult, { content: [{ type: "text", text: "native-write:out.txt" }] });

  assert.deepEqual(calls.map((call) => call.tool), ["read", "write"]);
  assert.deepEqual(calls[0].params, { path: "src/a.mjs", offset: 3, limit: 9 });
  assert.equal(calls[0].ctx, ctx);
  assert.equal(calls[0].options, undefined);
  assert.deepEqual(calls[1].params, { path: "out.txt", content: "hi" });
  assert.equal(calls[1].ctx, ctx);
});

test("protocol reads run the reader first and execute the native read over its text", async () => {
  const { calls, factoryCalls, createNativeRead, createNativeWrite } = createNativeToolSpies();
  const readerCalls = [];
  const router = createProtocolRouter({
    readers: {
      agent: async (uri, ctx) => {
        readerCalls.push([uri, ctx]);
        return LINES;
      },
    },
  });
  const { read } = createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd: "/work" });
  const ctx = { cwd: "/session" };

  const result = await read.execute("call-1", { path: "agent://agent_01", offset: 2, limit: 5 }, undefined, undefined, ctx);
  assert.equal(readerCalls.length, 1);
  assert.equal(readerCalls[0][0], "agent://agent_01");
  assert.equal(readerCalls[0][1], ctx);

  const protocolCall = calls.at(-1);
  assert.equal(protocolCall.tool, "read");
  assert.deepEqual(protocolCall.params, { path: "agent://agent_01", offset: 2, limit: 5 });
  assert.equal(protocolCall.cwd, "/session");
  const served = (await protocolCall.options.operations.readFile("ignored")).toString("utf8");
  assert.equal(served, LINES);
  const withOperations = factoryCalls.filter((call) => call.options !== undefined);
  assert.equal(withOperations.length, 1);
  assert.equal(withOperations[0].cwd, "/session");

  assert.equal(result.content[0].text, "line2\nline3\nline4\nline5\n\n[Showing lines 2-5 of 6. Use offset=6 to continue.]");
  assert.deepEqual(result.details, { nativeRead: true });

  const full = await read.execute("call-2", { path: "agent://agent_01" }, undefined, undefined, ctx);
  assert.equal(full.content[0].text, "line1\nline2\nline3\nline4\n\n[Showing lines 1-4 of 6. Use offset=5 to continue.]");
});

test("protocol reads fail before any native or reader work for unknown and malformed schemes", async () => {
  const { calls, factoryCalls, createNativeRead, createNativeWrite } = createNativeToolSpies();
  const router = createProtocolRouter({ readers: { agent: async () => "text" } });
  const { read } = createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd: "/work" });
  const ctx = { cwd: "/work" };

  await assert.rejects(() => read.execute("c1", { path: "tool://read" }, undefined, undefined, ctx), protocolError("unsupported_protocol"));
  await assert.rejects(() => read.execute("c2", { path: "://broken" }, undefined, undefined, ctx), protocolError("invalid_protocol_uri"));
  assert.deepEqual(calls, []);
  assert.deepEqual(factoryCalls.filter((call) => call.options !== undefined), []);

  const failingRouter = createProtocolRouter({
    readers: { agent: async () => { throw new Error("registry miss"); } },
  });
  const failing = createProtocolOverrides({ router: failingRouter, createNativeRead, createNativeWrite, cwd: "/work" });
  const before = factoryCalls.length;
  await assert.rejects(() => failing.read.execute("c3", { path: "agent://agent_99" }, undefined, undefined, ctx), /registry miss/);
  assert.equal(factoryCalls.length, before);
  assert.deepEqual(calls, []);
});

test("unsupported and read-only protocol writes refuse before any filesystem work", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "protocol-io-"));
  try {
    const { calls, createNativeRead, createNativeWrite } = createNativeToolSpies();
    const router = createProtocolRouter({ readers: { agent: async () => "text" } });
    const { write } = createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd: dir });
    const ctx = { cwd: dir };

    await assert.rejects(
      () => write.execute("c1", { path: "skill://anything", content: "x" }, undefined, undefined, ctx),
      protocolError("readonly_protocol"),
    );
    await assert.rejects(
      () => write.execute("c2", { path: "://bad", content: "x" }, undefined, undefined, ctx),
      protocolError("invalid_protocol_uri"),
    );
    assert.deepEqual(calls, []);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("protocol writes report the writer's simple result without touching the native write", async () => {
  const { calls, createNativeRead, createNativeWrite } = createNativeToolSpies();
  const router = createProtocolRouter({
    writers: {
      agent: async (uri, content, ctx, options) => {
        assert.equal(options.signal, undefined);
        return { ok: true, to: uri, jobId: "job_2", content };
      },
    },
  });
  const { write } = createProtocolOverrides({ router, createNativeRead, createNativeWrite, cwd: "/work" });
  const ctx = { cwd: "/work" };

  const result = await write.execute("c1", { path: "agent://agent_02", content: "hello" }, undefined, undefined, ctx);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, to: "agent://agent_02", jobId: "job_2", content: "hello" });
  assert.equal(result.details, undefined);
  assert.deepEqual(calls, []);
});

test("installs the read/write overrides once per session and composes installers", async () => {
  const bus = createTestBus();
  const { createNativeRead, createNativeWrite } = createNativeToolSpies();
  const capabilityPi = createTestPi(bus);
  const subagentPi = createTestPi(bus);

  const first = installProtocolOverrides(capabilityPi, {
    readers: { tool: async () => "tool body", skill: async () => "skill body" },
    createNativeRead,
    createNativeWrite,
  });
  const second = installProtocolOverrides(subagentPi, {
    readers: { agent: async () => "agent body", history: async () => "history body" },
    writers: { agent: async (uri) => ({ ok: true, uri }) },
    createNativeRead,
    createNativeWrite,
  });

  assert.equal(first.owner, true);
  assert.equal(second.owner, false);
  assert.deepEqual(capabilityPi.registrations.map((tool) => tool.name), ["read", "write"]);
  assert.deepEqual(subagentPi.registrations, []);
  assert.deepEqual(first.router.readSchemes(), ["agent", "history", "skill", "tool"]);
  assert.deepEqual(first.router.writeSchemes(), ["agent"]);
  assert.equal(bus.count(ATTACH_CHANNEL), 1);

  const read = capabilityPi.registrations[0];
  const readResult = await read.execute("c1", { path: "history://agent_01" }, undefined, undefined, { cwd: "/work" });
  assert.equal(readResult.content[0].text, "history body");

  const write = capabilityPi.registrations[1];
  const writeResult = await write.execute("c2", { path: "agent://Main", content: "ping" }, undefined, undefined, { cwd: "/work" });
  assert.deepEqual(JSON.parse(writeResult.content[0].text), { ok: true, uri: "agent://Main" });
});

test("installs in one session never leak into another session", async () => {
  const { createNativeRead, createNativeWrite } = createNativeToolSpies();
  const sessionA = createTestBus();
  const sessionB = createTestBus();
  const piA = createTestPi(sessionA);
  const piB = createTestPi(sessionB);

  installProtocolOverrides(piA, { readers: { agent: async () => "A" }, createNativeRead, createNativeWrite });
  installProtocolOverrides(piB, { readers: { tool: async () => "B" }, createNativeRead, createNativeWrite });

  const ctx = { cwd: "/work" };
  await assert.rejects(() => piB.registrations[0].execute("c1", { path: "agent://agent_01" }, undefined, undefined, ctx), protocolError("unsupported_protocol"));
  await assert.rejects(() => piA.registrations[0].execute("c2", { path: "tool://read" }, undefined, undefined, ctx), protocolError("unsupported_protocol"));
  assert.equal(await piA.registrations[0].execute("c3", { path: "agent://agent_01" }, undefined, undefined, ctx).then((result) => result.content[0].text), "A");
  assert.equal(await piB.registrations[0].execute("c4", { path: "tool://read" }, undefined, undefined, ctx).then((result) => result.content[0].text), "B");
});

test("a scheme claimed by two installers fails the second install", () => {
  const bus = createTestBus();
  const { createNativeRead, createNativeWrite } = createNativeToolSpies();
  const piA = createTestPi(bus);
  const piB = createTestPi(bus);

  installProtocolOverrides(piA, { readers: { skill: async () => "a" }, createNativeRead, createNativeWrite });
  assert.throws(
    () => installProtocolOverrides(piB, { readers: { skill: async () => "b" }, createNativeRead, createNativeWrite }),
    protocolError("conflicting_route"),
  );
  assert.deepEqual(piB.registrations, []);
  assert.deepEqual(piA.registrations.map((tool) => tool.name), ["read", "write"]);
});

test("rejects invalid routes, buses and Pi surfaces before anything is installed", () => {
  const bus = createTestBus();
  const { createNativeRead, createNativeWrite } = createNativeToolSpies();
  const pi = createTestPi(bus);

  assert.throws(
    () => installProtocolOverrides(pi, { readers: { "bad scheme": async () => "" }, createNativeRead, createNativeWrite }),
    protocolError("invalid_scheme"),
  );
  assert.throws(
    () => installProtocolOverrides(pi, { readers: { tool: "not a function" }, createNativeRead, createNativeWrite }),
    protocolError("invalid_routes"),
  );
  assert.throws(
    () => installProtocolOverrides({ events: pi.events }, { readers: {}, createNativeRead, createNativeWrite }),
    protocolError("invalid_pi_api"),
  );
  assert.throws(
    () => installProtocolOverrides(pi, { readers: {}, createNativeRead, createNativeWrite: undefined }),
    protocolError("invalid_native_factory"),
  );
  assert.throws(() => attachProtocolRouter({}, {}), protocolError("invalid_event_bus"));
  assert.throws(
    () => createProtocolOverrides({ router: {}, createNativeRead, createNativeWrite }),
    protocolError("invalid_router"),
  );

  assert.deepEqual(pi.registrations, []);
  assert.equal(bus.count(ATTACH_CHANNEL), 0);
  assert.deepEqual(bus.errors, []);
});

test("a reload elects a fresh owner and re-registers the overrides for the new batch", async () => {
  const bus = createTestBus();
  const { createNativeRead, createNativeWrite } = createNativeToolSpies();
  const firstBatchPi = createTestPi(bus);
  installProtocolOverrides(firstBatchPi, {
    readers: { tool: async () => "tool body" },
    createNativeRead,
    createNativeWrite,
  });
  assert.deepEqual(firstBatchPi.registrations.map((tool) => tool.name), ["read", "write"]);

  bus.clear();

  const secondBatchPi = createTestPi(bus);
  const second = installProtocolOverrides(secondBatchPi, {
    readers: { agent: async () => "agent body" },
    createNativeRead,
    createNativeWrite,
  });
  assert.equal(second.owner, true);
  assert.deepEqual(secondBatchPi.registrations.map((tool) => tool.name), ["read", "write"]);
  assert.deepEqual(second.router.readSchemes(), ["agent"]);
  assert.equal(bus.count(ATTACH_CHANNEL), 1);

  const ctx = { cwd: "/work" };
  const read = secondBatchPi.registrations[0];
  assert.equal(await read.execute("c1", { path: "agent://agent_01" }, undefined, undefined, ctx).then((result) => result.content[0].text), "agent body");
  await assert.rejects(() => read.execute("c2", { path: "tool://read" }, undefined, undefined, ctx), protocolError("unsupported_protocol"));

  const joinerPi = createTestPi(bus);
  const joiner = installProtocolOverrides(joinerPi, {
    readers: { skill: async () => "skill body" },
    createNativeRead,
    createNativeWrite,
  });
  assert.equal(joiner.owner, false);
  assert.deepEqual(joinerPi.registrations, []);
  assert.deepEqual(second.router.readSchemes(), ["agent", "skill"]);
  assert.equal(await read.execute("c3", { path: "skill://x" }, undefined, undefined, ctx).then((result) => result.content[0].text), "skill body");
  assert.equal(bus.count(ATTACH_CHANNEL), 1);
});
