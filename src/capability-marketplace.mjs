/**
 * npm marketplace metadata helper for the capability broker's remote branch.
 *
 * Pi packages are ordinary npm packages that carry the `pi-package` keyword
 * (installed Pi docs/packages.md: "The `pi-package` keyword makes an npm package
 * eligible for discovery in the Pi package gallery"). This module is the
 * concrete remote metadata source for `src: "remote"` and the `npm://` protocol
 * read; it is npm-only on purpose and makes no claim about other marketplaces.
 *
 * Requests are metadata-only GETs:
 *
 *   searchRemote(query, { signal, installed })
 *     -> { source: "npm", candidates: PackageCandidate[] }
 *   readRemote(ref, { signal })
 *     -> package metadata object (name, version, description, dist.tarball,
 *        dist.integrity, dependency overview, ...)
 *
 * The search request asks the registry for `keywords:pi-package <query>` and
 * maps each result to a candidate. `readRemote` resolves `npm://<pkg>[@<version>]`
 * through the package version manifest (`GET /<pkg>/<version>`, or the `latest`
 * tag when no version was given). Neither call ever downloads a package archive,
 * installs, enables or executes a package: the returned tarball URL and integrity
 * are inert metadata for the human approval flow.
 *
 * Already installed packages never appear as candidates. The caller supplies the
 * installed npm sources either once (`listInstalledPackages`, as the capability
 * adapter does with Pi's settings) or per call (`installed`). With neither, a
 * search fails closed instead of guessing that nothing is installed.
 *
 * Every request has a finite timeout and honors an optional caller `signal`
 * (`AbortSignal`); on timeout or abort the fetch is cancelled and the error is
 * raised to the broker, which reports the remote source group as failed rather
 * than pretending the marketplace has no matches. A metadata read that the
 * registry answers with 404/410 throws `NpmNotFoundError`; the broker treats
 * only that marker as a legitimate "no such package or version" no-hit, while
 * transport, timeout and other registry errors degrade the group's status.
 */

export const NPM_REGISTRY_URL = "https://registry.npmjs.org";
export const PI_PACKAGE_KEYWORD = "pi-package";
export const NPM_MARKETPLACE_SOURCE = "npm";

/**
 * An explicit "the registry has no such package or version" answer (HTTP
 * 404/410 on a metadata read), as opposed to a transport or registry failure.
 * The broker treats only this error as a legitimate no-hit for an exact ref;
 * every other readRemote failure degrades the remote source group.
 */
export class NpmNotFoundError extends Error {
  constructor(url) {
    super(`npm registry knows no package or version at ${url}`);
    this.name = "NpmNotFoundError";
    this.code = "NPM_NOT_FOUND";
    this.status = 404;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_SEARCH_SIZE = 10;
const MAX_SEARCH_SIZE = 50;
const USER_AGENT = "pi-harness-capability-marketplace";

// npm package name grammar; also used to reject path traversal through refs.
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;
const VERSION = /^[a-z0-9][a-z0-9._+-]*$/i;

function isPackageName(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 214 && !value.includes("..") && PACKAGE_NAME.test(value);
}

function isVersion(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && VERSION.test(value);
}

function ensureStringArray(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.length > 0) : [];
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error("marketplace request aborted");
  error.name = "AbortError";
  return error;
}

/** `npm:@scope/pkg@1.0.0`, `@scope/pkg`, `{ source }` or `{ name }` -> `@scope/pkg`. */
export function packageNameFromSource(value) {
  let spec = "";
  if (typeof value === "string") spec = value.trim();
  else if (value !== null && typeof value === "object") {
    if (typeof value.source === "string") spec = value.source.trim();
    else if (typeof value.name === "string") spec = value.name.trim();
  }
  if (spec.length === 0) return null;
  if (spec.startsWith("npm:")) spec = spec.slice("npm:".length).trim();
  else if (/^(?:git\+|git:|https?:|file:|\.|\/|~)/i.test(spec)) return null;
  const at = spec.lastIndexOf("@");
  if (at > 0) spec = spec.slice(0, at);
  if (!isPackageName(spec)) return null;
  return spec.toLowerCase();
}

/** `@scope/pkg` -> `@scope%2Fpkg`: one URL path segment per the registry convention. */
function encodeScopedName(name) {
  return name.replace(/\//g, "%2F");
}

function parseNpmRef(ref) {
  const text = typeof ref === "string" ? ref.trim() : "";
  const prefix = "npm://";
  if (!text.startsWith(prefix)) {
    throw new Error(`unsupported capability ref "${text}": expected npm://<package>@<version>`);
  }
  const rest = text.slice(prefix.length);
  const at = rest.lastIndexOf("@");
  let encodedName = rest;
  let encodedVersion;
  if (at > 0) {
    encodedName = rest.slice(0, at);
    encodedVersion = rest.slice(at + 1);
  }
  let name;
  let version;
  try {
    name = decodeURIComponent(encodedName);
    version = encodedVersion === undefined ? undefined : decodeURIComponent(encodedVersion);
  } catch {
    throw new Error(`malformed npm ref "${text}"`);
  }
  if (!isPackageName(name)) throw new Error(`invalid npm package name in ref "${text}"`);
  if (version !== undefined && !isVersion(version)) throw new Error(`invalid npm version in ref "${text}"`);
  return { name, version };
}

function normalizeSearchObject(entry) {
  if (entry === null || typeof entry !== "object") return null;
  const pkg = entry.package;
  if (pkg === null || typeof pkg !== "object") return null;
  const name = typeof pkg.name === "string" ? pkg.name.trim() : "";
  if (!isPackageName(name)) return null;
  const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
  if (!isVersion(version)) return null;
  const keywords = ensureStringArray(pkg.keywords);
  // The registry qualifier already filters by keyword; this is the client-side
  // safety net for registries/proxies that ignore qualifiers.
  if (keywords.length > 0 && !keywords.some((keyword) => keyword.toLowerCase() === PI_PACKAGE_KEYWORD)) return null;
  const links = pkg.links !== null && typeof pkg.links === "object" ? pkg.links : {};
  const cleanLinks = {};
  for (const key of ["npm", "homepage", "repository", "bugs"]) {
    if (typeof links[key] === "string" && links[key].length > 0) cleanLinks[key] = links[key];
  }
  const publisher = pkg.publisher !== null && typeof pkg.publisher === "object" && typeof pkg.publisher.username === "string"
    ? pkg.publisher.username
    : typeof pkg.author?.name === "string" && pkg.author.name.length > 0
      ? pkg.author.name
      : "";
  return {
    name,
    source: NPM_MARKETPLACE_SOURCE,
    version,
    description: typeof pkg.description === "string" ? pkg.description : "",
    ...(keywords.length > 0 ? { keywords } : {}),
    ...(typeof pkg.date === "string" && pkg.date.length > 0 ? { date: pkg.date } : {}),
    ...(publisher.length > 0 ? { publisher } : {}),
    ...(Object.keys(cleanLinks).length > 0 ? { links: cleanLinks } : {}),
  };
}

function normalizeManifest(target, manifest) {
  if (manifest === null || typeof manifest !== "object") {
    throw new Error(`npm registry returned no metadata for "${target.name}"`);
  }
  const name = typeof manifest.name === "string" && isPackageName(manifest.name) ? manifest.name : target.name;
  const version = typeof manifest.version === "string" && isVersion(manifest.version)
    ? manifest.version
    : target.version;
  if (version === undefined || !isVersion(version)) {
    throw new Error(`npm registry returned no version for "${target.name}"`);
  }
  const dist = manifest.dist !== null && typeof manifest.dist === "object" ? manifest.dist : {};
  const cleanDist = {};
  for (const key of ["tarball", "integrity", "shasum"]) {
    if (typeof dist[key] === "string" && dist[key].length > 0) cleanDist[key] = dist[key];
  }
  for (const key of ["fileCount", "unpackedSize"]) {
    if (typeof dist[key] === "number" && Number.isFinite(dist[key])) cleanDist[key] = dist[key];
  }
  const repository = manifest.repository;
  const repositoryUrl = typeof repository === "string"
    ? repository
    : repository !== null && typeof repository === "object" && typeof repository.url === "string"
      ? repository.url
      : "";
  return {
    ref: `npm://${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
    kind: "package",
    source: NPM_MARKETPLACE_SOURCE,
    name,
    version,
    description: typeof manifest.description === "string" ? manifest.description : "",
    ...(typeof manifest.license === "string" && manifest.license.length > 0 ? { license: manifest.license } : {}),
    ...(ensureStringArray(manifest.keywords).length > 0 ? { keywords: ensureStringArray(manifest.keywords) } : {}),
    ...(typeof manifest.deprecated === "string" && manifest.deprecated.length > 0 ? { deprecated: manifest.deprecated } : {}),
    ...(manifest.dependencies !== null && typeof manifest.dependencies === "object" ? { dependencies: { ...manifest.dependencies } } : {}),
    ...(manifest.peerDependencies !== null && typeof manifest.peerDependencies === "object"
      ? { peerDependencies: { ...manifest.peerDependencies } }
      : {}),
    ...(typeof manifest.homepage === "string" && manifest.homepage.length > 0 ? { homepage: manifest.homepage } : {}),
    ...(repositoryUrl.length > 0 ? { repository: repositoryUrl } : {}),
    ...(Object.keys(cleanDist).length > 0 ? { dist: cleanDist } : {}),
    sourceUrl: `https://www.npmjs.com/package/${name}/v/${version}`,
  };
}

/**
 * Build the npm marketplace helper. Options:
 *
 *   fetch                 fetch implementation (defaults to globalThis.fetch)
 *   registry              registry base URL (defaults to registry.npmjs.org)
 *   timeoutMs             finite per-request timeout (default 10s)
 *   searchSize            registry results per search, 1..50 (default 10)
 *   listInstalledPackages installed npm sources; array, Promise, or function
 */
export function createNpmMarketplace(options = {}) {
  const fetchImpl = typeof options.fetch === "function" ? options.fetch : globalThis.fetch;
  const registry = String(options.registry ?? NPM_REGISTRY_URL).replace(/\/+$/, "");
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const searchSize = Number.isInteger(options.searchSize) && options.searchSize > 0
    ? Math.min(options.searchSize, MAX_SEARCH_SIZE)
    : DEFAULT_SEARCH_SIZE;
  const listInstalledPackages = options.listInstalledPackages;

  async function requestJson(url, userSignal, { allowNotFound = false } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("npm marketplace fetch is not available");
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = userSignal !== undefined && userSignal !== null
      ? AbortSignal.any([userSignal, timeoutSignal])
      : timeoutSignal;
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        signal,
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
    } catch (error) {
      if (userSignal?.aborted) throw abortError(userSignal.reason);
      if (timeoutSignal.aborted) {
        const timedOut = new Error(`npm registry request timed out after ${timeoutMs}ms`);
        timedOut.name = "TimeoutError";
        throw timedOut;
      }
      throw error;
    }
    if (!response.ok) {
      // An explicit 404/410 on a metadata read is "no such package or version";
      // every other non-OK response is a registry failure.
      if (allowNotFound && (response.status === 404 || response.status === 410)) {
        throw new NpmNotFoundError(url.toString());
      }
      throw new Error(`npm registry request failed: HTTP ${response.status} for ${url.toString()}`);
    }
    try {
      return await response.json();
    } catch {
      throw new Error(`npm registry returned invalid JSON for ${url.toString()}`);
    }
  }

  async function installedSet(explicit) {
    const source = explicit !== undefined ? explicit : listInstalledPackages;
    if (source === undefined || source === null) {
      throw new Error(
        "installed packages are not configured; refusing to present installed packages as new install requests",
      );
    }
    const list = typeof source === "function" ? await source() : await source;
    const names = new Set();
    if (Array.isArray(list)) {
      for (const entry of list) {
        const name = packageNameFromSource(entry);
        if (name !== null) names.add(name);
      }
    }
    return names;
  }

  async function searchRemote(query, { signal, installed } = {}) {
    const text = typeof query === "string" ? query.trim() : "";
    if (text.length === 0) throw new Error("marketplace search query must be a non-empty string");
    const excluded = await installedSet(installed);
    const url = new URL(`${registry}/-/v1/search`);
    url.searchParams.set("text", `keywords:${PI_PACKAGE_KEYWORD} ${text}`);
    url.searchParams.set("size", String(searchSize));
    const payload = await requestJson(url, signal);
    const objects = payload !== null && typeof payload === "object" && Array.isArray(payload.objects) ? payload.objects : [];
    const candidates = [];
    for (const object of objects) {
      const candidate = normalizeSearchObject(object);
      if (candidate === null) continue;
      if (excluded.has(candidate.name.toLowerCase())) continue;
      candidates.push(candidate);
    }
    return { source: NPM_MARKETPLACE_SOURCE, candidates };
  }

  async function readRemote(ref, { signal } = {}) {
    const target = parseNpmRef(ref);
    const version = target.version ?? "latest";
    const url = `${registry}/${encodeScopedName(target.name)}/${encodeURIComponent(version)}`;
    const manifest = await requestJson(url, signal, { allowNotFound: true });
    return normalizeManifest(target, manifest);
  }

  return { searchRemote, readRemote };
}
