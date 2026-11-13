/**
 * Approval identities must survive a fresh extension module load.
 *
 * The old module-global counter restarted at `approval-1` whenever Pi loaded a
 * new SDK/extension instance, so an old reply could address a newly queued
 * request. This test loads the real controller twice and keeps one pending
 * request in each instance; it does not add a second approval state owner.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type {
  ManualApprovalController as ManualApprovalControllerInstance,
  ManualApprovalControllerOptions,
} from "../../src/shell-approval/controller.ts";
import type { ShellApprovalRequest, ShellApprovalResult } from "../../src/shell-approval/types.ts";

interface ControllerModule {
  readonly ManualApprovalController: new (
    options?: ManualApprovalControllerOptions,
  ) => ManualApprovalControllerInstance;
}

function loadFreshController(): Promise<ControllerModule> {
  return import(
    `../../src/shell-approval/controller.ts?fresh=${randomUUID()}`
  ) as Promise<ControllerModule>;
}

function request(sourceAgent: string): ShellApprovalRequest {
  return {
    sourceAgent,
    shell: "bash",
    cwd: "/tmp/project",
    command: "printf fixture",
    timeoutSeconds: 30,
  };
}

test("fresh controller module instances cannot reply with a stale approval id", { timeout: 10000 }, async (t) => {
  const [firstModule, secondModule] = await Promise.all([
    loadFreshController(),
    loadFreshController(),
  ]);
  assert.notEqual(firstModule.ManualApprovalController, secondModule.ManualApprovalController);
  const first = new firstModule.ManualApprovalController({ canPresent: () => true });
  const second = new secondModule.ManualApprovalController({ canPresent: () => true });
  t.after(() => { first.dispose(); second.dispose(); });

  const firstPending = first.request(request("first"));
  const firstId = first.list()[0]?.id;
  assert.ok(firstId);
  const secondPending = second.request(request("second"));
  const secondId = second.list()[0]?.id;
  assert.ok(secondId);
  assert.notEqual(firstId, secondId, "fresh module loads must not reuse the same approval id");

  const stale = second.respond(firstId, "allow");
  assert.deepEqual(stale, { accepted: false, reason: "not_pending" });
  assert.equal(second.get(firstId), undefined);
  assert.deepEqual(second.list().map((pending) => pending.id), [secondId]);

  let secondSettled = false;
  void secondPending.then(() => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false, "the new controller's request remains pending");

  first.dispose();
  second.dispose();
  assert.deepEqual(await firstPending, { approved: false, reason: "disposed" });
  assert.deepEqual(await secondPending, { approved: false, reason: "disposed" } satisfies ShellApprovalResult);
  assert.deepEqual(first.list(), []);
  assert.deepEqual(second.list(), []);
  assert.deepEqual(await second.request(request("after-dispose")), { approved: false, reason: "disposed" });
});
