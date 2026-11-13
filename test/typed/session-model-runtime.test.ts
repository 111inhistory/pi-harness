/**
 * Focused contract tests for the parent ModelRuntime bridge.
 *
 * The bridge is the one documented private-SDK boundary. These tests pin the
 * audited package version, prove identity is preserved (never a fresh fallback
 * runtime), and prove the structural guard accepts a same-version runtime that
 * did not come from this package's `ModelRuntime` class.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  MODEL_RUNTIME_AUDITED_VERSION,
  ModelRuntimeBridgeError,
  findParentModelRuntime,
  parentModelRuntime,
} from "../../src/session/model-runtime.ts";

interface FakeRuntime {
  readonly marker: string;
  streamSimple(): void;
  getAuth(): Promise<undefined>;
  getRegisteredProviderIds(): readonly string[];
}

function fakeRuntime(marker: string): FakeRuntime {
  return {
    marker,
    streamSimple(): void {},
    async getAuth(): Promise<undefined> {
      return undefined;
    },
    getRegisteredProviderIds(): readonly string[] {
      return [];
    },
  };
}

interface PackageManifest {
  readonly version: string;
}

test("the private-SDK bridge is pinned to the installed 1.5.0 package", async () => {
  const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const manifestPath = path.resolve(path.dirname(entry), "../package.json");
  const manifest: PackageManifest = JSON.parse(await readFile(manifestPath, "utf8"));

  assert.equal(MODEL_RUNTIME_AUDITED_VERSION, "1.5.0");
  assert.equal(manifest.version, MODEL_RUNTIME_AUDITED_VERSION);
});

test("the bridge returns the exact parent runtime, including a same-version cross-package copy", () => {
  const runtime = fakeRuntime("parent-runtime");
  assert.equal(runtime instanceof ModelRuntime, false, "the guard must not depend on instanceof");

  const registry = { runtime };
  assert.equal(findParentModelRuntime(registry), runtime);
  assert.equal(parentModelRuntime(registry), runtime);
});

test("the bridge never falls back to a fresh or registry-shaped runtime", () => {
  const registryShapedLikeRuntime = fakeRuntime("registry");
  assert.equal(findParentModelRuntime(registryShapedLikeRuntime), null);

  const invalid: readonly unknown[] = [
    null,
    undefined,
    {},
    { runtime: null },
    { runtime: {} },
    { runtime: { streamSimple() {}, getAuth() {}, getRegisteredProviderIds: 1 } },
    { runtime: { streamSimple: 1, getAuth() {}, getRegisteredProviderIds() {} } },
    { runtime: { streamSimple() {}, getAuth: "auth", getRegisteredProviderIds() {} } },
  ];
  for (const registry of invalid) assert.equal(findParentModelRuntime(registry), null);
});

test("an unavailable bridge is an explicit compatibility error with the consumer subject", () => {
  const expected =
    "this Pi build does not expose the session ModelRuntime through ModelRegistry.runtime, so capability discovery " +
    "cannot reuse the parent session's provider registrations and virtual models; refusing to silently fall back " +
    "to a fresh runtime";
  assert.throws(
    () => parentModelRuntime({}, "capability discovery"),
    (error: unknown) =>
      error instanceof ModelRuntimeBridgeError &&
      error.code === "model_runtime_unavailable" &&
      error.message === expected,
  );
});
