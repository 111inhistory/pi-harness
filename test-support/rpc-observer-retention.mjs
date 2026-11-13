// Isolated GC diagnostic for Stage 3 subscription ownership.
//
// Run with `node --expose-gc --import tsx`. The fixture uses the real Runtime
// and stream port, creates an unresolved Job, subscribes and unsubscribes many
// connections, then checks that every connection object is collectible before
// the Job settles. It must stay outside the normal in-process gate because it
// needs explicit GC; the deterministic observer tests cover delivery and
// listener removal without relying on collection.
import assert from "node:assert/strict";

import { createSubagentRuntime } from "../src/subagent/runtime.ts";
import { buildStreamPort } from "../src/harness-rpc/ports/stream.ts";

assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");

function makeConnection() {
  const events = [];
  const subscriptions = new Map();
  let counter = 0;
  return {
    events,
    addSubscription(unsubscribe) {
      counter += 1;
      const id = `sub-${counter}`;
      subscriptions.set(id, unsubscribe);
      return id;
    },
    removeSubscription(id) {
      const unsubscribe = subscriptions.get(id);
      if (unsubscribe === undefined) return false;
      subscriptions.delete(id);
      unsubscribe();
      return true;
    },
    pushEvent(subscription, payload) {
      events.push({ subscription, payload });
    },
  };
}

async function collect() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.gc();
  }
}

let finish;
const done = new Promise((resolve) => {
  finish = resolve;
});
const runtime = createSubagentRuntime({
  startJob(request) {
    request.recordStart("e1");
    return { done, cancel() {} };
  },
});
const item = runtime.create({ tasks: [{ task: "work" }] }).items[0];
assert.ok(item);
const root = {
  sessionId: "session-root",
  runtime,
  subscribeJobEvents: () => () => {},
  liveSnapshot: () => ({ endEntryId: "e2", messages: [], partial: null }),
};
const port = buildStreamPort(root);
const references = [];

async function subscribeAndDrop() {
  for (let index = 0; index < 500; index += 1) {
    const connection = makeConnection();
    await port.subscribe({ jobId: item.id }, connection);
    // Wire unsubscribe is transport-owned and remains available without a Root.
    connection.removeSubscription("sub-1");
    references.push(new WeakRef(connection));
  }
}

await subscribeAndDrop();
await collect();
assert.equal(
  references.filter((reference) => reference.deref() !== undefined).length,
  0,
  "unsubscribed stream connections must be collectible before the Job settles",
);

finish({ status: "completed", result: "done", history: { startEntryId: "e1", endEntryId: "e3" } });
await runtime.jobDone(item.id);
await collect();
assert.equal(
  references.filter((reference) => reference.deref() !== undefined).length,
  0,
  "settling the Job must not resurrect removed observations",
);

console.log("RETENTION_OK");
