import assert from "node:assert/strict";
import test from "node:test";

import {
  NPM_MARKETPLACE_SOURCE,
  NPM_REGISTRY_URL,
  PI_PACKAGE_KEYWORD,
  createNpmMarketplace,
  packageNameFromSource,
} from "../src/capability-marketplace.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function abortsOnSignal(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function searchPayload(objects) {
  return { objects, total: objects.length, time: "2026-10-02T00:00:00.000Z" };
}

test("searches the npm registry for pi-package keyword matches and normalizes candidates", async () => {
  const calls = [];
  const marketplace = createNpmMarketplace({
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse(
        searchPayload([
          {
            package: {
              name: "@scope/pi-firefox-tools",
              version: "1.2.3",
              description: "Firefox automation for Pi",
              keywords: ["pi-package", "firefox"],
              date: "2026-01-01T00:00:00.000Z",
              links: {
                npm: "https://www.npmjs.com/package/@scope/pi-firefox-tools",
                homepage: "https://example.com",
                repository: "https://github.com/example/pi-firefox-tools",
                bugs: "https://github.com/example/pi-firefox-tools/issues",
              },
              publisher: { username: "octo" },
            },
          },
          // Not a Pi package: the client-side safety net drops it even if a
          // registry or proxy ignores the keyword qualifier.
          { package: { name: "not-a-pi-package", version: "9.9.9", description: "nope", keywords: ["other"] } },
          // No version: a candidate that cannot be referenced exactly is skipped.
          { package: { name: "missing-version", description: "x", keywords: ["pi-package"] } },
          // Keywords missing entirely: the registry qualifier already filtered.
          { package: { name: "keywordless-pi-package", version: "2.0.0", description: "keywords omitted" } },
        ]),
      );
    },
    listInstalledPackages: [],
  });

  const result = await marketplace.searchRemote("firefox automation");
  assert.equal(result.source, NPM_MARKETPLACE_SOURCE);
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.name),
    ["@scope/pi-firefox-tools", "keywordless-pi-package"],
  );
  const candidate = result.candidates[0];
  assert.equal(candidate.version, "1.2.3");
  assert.equal(candidate.source, "npm");
  assert.equal(candidate.publisher, "octo");
  assert.equal(candidate.date, "2026-01-01T00:00:00.000Z");
  assert.equal(candidate.links.repository, "https://github.com/example/pi-firefox-tools");

  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, `${NPM_REGISTRY_URL}/-/v1/search`);
  assert.equal(url.searchParams.get("text"), `keywords:${PI_PACKAGE_KEYWORD} firefox automation`);
  assert.equal(url.searchParams.get("size"), "10");
  assert.equal(calls[0].options.headers.accept, "application/json");
});

test("excludes installed packages, accepting npm sources, specs and package objects", async () => {
  const marketplace = createNpmMarketplace({
    fetch: async () =>
      jsonResponse(
        searchPayload([
          { package: { name: "@scope/pi-firefox-tools", version: "1.2.3", description: "Firefox tools", keywords: ["pi-package"] } },
          { package: { name: "pi-pager", version: "0.5.0", description: "Pager tools", keywords: ["pi-package"] } },
        ]),
      ),
    listInstalledPackages: () => ["npm:@scope/pi-firefox-tools@1.2.3", { source: "git:github.com/example/pi-git-tools@v1" }, "./local"],
  });

  const result = await marketplace.searchRemote("tools");
  assert.deepEqual(result.candidates.map((candidate) => candidate.name), ["pi-pager"]);

  // A per-call installed list overrides the constructed source.
  const overridden = await marketplace.searchRemote("tools", { installed: ["pi-pager"] });
  assert.deepEqual(overridden.candidates.map((candidate) => candidate.name), ["@scope/pi-firefox-tools"]);
});

test("fails closed when no installed package source is configured", async () => {
  const marketplace = createNpmMarketplace({
    fetch: async () => {
      throw new Error("fetch must not be reached without an installed set");
    },
  });
  await assert.rejects(marketplace.searchRemote("firefox"), /installed packages are not configured/);
});

test("readRemote resolves an exact version manifest with integrity and never fetches archives", async () => {
  const calls = [];
  const marketplace = createNpmMarketplace({
    fetch: async (url) => {
      calls.push(String(url));
      return jsonResponse({
        name: "@scope/pkg",
        version: "1.2.3",
        description: "Scoped package",
        license: "MIT",
        dependencies: { dep: "^1.0.0" },
        repository: { type: "git", url: "git+https://github.com/example/repo.git" },
        dist: {
          tarball: "https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz",
          integrity: "sha512-abc",
          shasum: "deadbeef",
          unpackedSize: 1234,
        },
      });
    },
  });

  const metadata = await marketplace.readRemote("npm://%40scope%2Fpkg@1.2.3");
  assert.equal(calls[0], `${NPM_REGISTRY_URL}/@scope%2Fpkg/1.2.3`);
  assert.equal(metadata.ref, "npm://%40scope%2Fpkg@1.2.3");
  assert.equal(metadata.kind, "package");
  assert.equal(metadata.name, "@scope/pkg");
  assert.equal(metadata.version, "1.2.3");
  assert.equal(metadata.dist.integrity, "sha512-abc");
  assert.equal(metadata.dist.tarball, "https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz");
  assert.deepEqual(metadata.dependencies, { dep: "^1.0.0" });
  assert.ok(!calls.some((url) => url.endsWith(".tgz")), "metadata-only: the tarball is never downloaded");
});

test("readRemote resolves the latest tag when the ref carries no version", async () => {
  const calls = [];
  const marketplace = createNpmMarketplace({
    fetch: async (url) => {
      calls.push(String(url));
      return jsonResponse({ name: "pi-tools", version: "2.0.0", description: "Latest" });
    },
  });
  const metadata = await marketplace.readRemote("npm://pi-tools");
  assert.equal(calls[0], `${NPM_REGISTRY_URL}/pi-tools/latest`);
  assert.equal(metadata.version, "2.0.0");
  assert.equal(metadata.source, "npm");
});

test("readRemote marks an explicit not-found and rejects other registry errors", async () => {
  const notFound = createNpmMarketplace({
    fetch: async () => new Response("not found", { status: 404 }),
  });
  await assert.rejects(notFound.readRemote("npm://pi-tools@9.9.9"), (error) => {
    assert.equal(error.name, "NpmNotFoundError");
    assert.equal(error.code, "NPM_NOT_FOUND");
    assert.equal(error.status, 404);
    return true;
  });

  const failing = createNpmMarketplace({
    fetch: async () => new Response("boom", { status: 500 }),
  });
  await assert.rejects(failing.readRemote("npm://pi-tools@9.9.9"), (error) => {
    assert.notEqual(error.name, "NpmNotFoundError", "a registry failure must not look like a legitimate miss");
    assert.match(error.message, /HTTP 500/);
    return true;
  });

  const marketplace = createNpmMarketplace({ fetch: async () => jsonResponse({ name: "x", version: "1.0.0" }) });
  await assert.rejects(marketplace.readRemote("npm://..%2F..%2Fetc@1.0.0"), /invalid npm package name/);
  await assert.rejects(marketplace.readRemote("npm://pi-tools@1.0.0%2Fevil"), /invalid npm version/);
  await assert.rejects(marketplace.readRemote("tool://bash"), /expected npm:\/\//);
});

test("bounds every request with a finite timeout", async () => {
  // AbortSignal.timeout does not keep the event loop alive; hold it while the
  // fake fetch waits for the timeout signal.
  const keepAlive = setTimeout(() => {}, 500);
  try {
    const marketplace = createNpmMarketplace({
      fetch: async (url, { signal }) => abortsOnSignal(signal),
      timeoutMs: 20,
      listInstalledPackages: [],
    });
    await assert.rejects(marketplace.searchRemote("firefox"), /timed out after 20ms/);

    const reader = createNpmMarketplace({
      fetch: async (url, { signal }) => abortsOnSignal(signal),
      timeoutMs: 20,
    });
    await assert.rejects(reader.readRemote("npm://pi-tools@1.0.0"), /timed out after 20ms/);
  } finally {
    clearTimeout(keepAlive);
  }
});

test("honors caller cancellation", async () => {
  const marketplace = createNpmMarketplace({
    fetch: async (url, { signal }) => abortsOnSignal(signal),
    timeoutMs: 5_000,
  });
  const controller = new AbortController();
  const pending = marketplace.searchRemote("firefox", { signal: controller.signal, installed: [] });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
});

test("normalizes Pi package sources to npm package names", () => {
  assert.equal(packageNameFromSource("npm:@scope/pkg@1.0.0"), "@scope/pkg");
  assert.equal(packageNameFromSource("@scope/pkg"), "@scope/pkg");
  assert.equal(packageNameFromSource("plain-pkg"), "plain-pkg");
  assert.equal(packageNameFromSource({ source: "npm:pi-tools@2.0.0" }), "pi-tools");
  assert.equal(packageNameFromSource({ name: "@scope/other" }), "@scope/other");
  assert.equal(packageNameFromSource("git:github.com/example/pi-tools@v1"), null);
  assert.equal(packageNameFromSource("./local-package"), null);
  assert.equal(packageNameFromSource("https://github.com/example/pi-tools"), null);
  assert.equal(packageNameFromSource(""), null);
  assert.equal(packageNameFromSource({}), null);
});
