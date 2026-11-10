/**
 * Real SDK coverage for the optional Shell syntax and approval entrypoint.
 *
 * Each scenario loads `extensions/shell-preflight.ts` into a real AgentSession
 * with a faux provider. Policy programs are offline Node children; no provider
 * credentials or network requests are used.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  fauxProvider,
  InMemoryCredentialStore,
  contentText,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream as AssistantMessageEventStreamType,
  type JsonObject,
  type Model,
} from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";

import { DEFAULT_HARNESS_CONFIG, harnessConfigFor } from "../../src/harness-config.ts";
import shellPreflightExtension from "../../src/shell-approval/extension.ts";
import { PARSER_MODULE_URL } from "../../src/shell-approval/job-command.ts";

const POLICY_SCRIPT = String.raw`
const fs = require("node:fs");
const action = JSON.parse(fs.readFileSync(0, "utf8"));
if (action.rules[1]) fs.writeFileSync(action.rules[1], "called");
const decision = action.rules[0];
process.stdout.write(JSON.stringify({ decision, reason: "fixture policy " + decision }));
`;

const RECORDING_POLICY_SCRIPT = String.raw`
const fs = require("node:fs");
const action = JSON.parse(fs.readFileSync(0, "utf8"));
const rules = Array.isArray(action.rules) ? action.rules : [];
const mode = rules[0];
const recordPath = rules[1];
const denyToken = rules[2];
const argv = Array.isArray(action.argv) ? action.argv : [];
const tokenDenied = typeof denyToken === "string" && denyToken.length > 0 && JSON.stringify(argv).includes(denyToken);
const decision = mode === "deny" || tokenDenied ? "deny" : "allow";
if (recordPath) fs.appendFileSync(recordPath, JSON.stringify({
  argv, cwd: action.cwd, command: action.command, decision,
}) + "\n");
process.stdout.write(JSON.stringify({ decision, reason: "fixture policy " + decision }));
`;

const PARSER_PATH = fileURLToPath(PARSER_MODULE_URL);
const parserSkip = existsSync(PARSER_PATH) ? false : `requires ${PARSER_PATH}`;

interface PolicyRecord {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly command: string;
  readonly decision: "allow" | "deny";
}

/** Synthetic policy strings are written as regular files, one rule per file. */
async function writeRuleFiles(root: string, contents: readonly string[]): Promise<string[]> {
  const directory = path.join(root, "rules");
  await mkdir(directory, { recursive: true });
  return Promise.all(contents.map(async (content, index) => {
    const file = path.join(directory, `rule-${index}.txt`);
    await writeFile(file, content, "utf8");
    return file;
  }));
}

async function readPolicyRecords(file: string): Promise<PolicyRecord[]> {
  try {
    const text = await readFile(file, "utf8");
    return text.trim().split("\n").filter(line => line.length > 0).map(line => JSON.parse(line) as PolicyRecord);
  } catch {
    return [];
  }
}

interface RecordedApproval {
  readonly session: AgentSession;
  readonly records: readonly PolicyRecord[];
  readonly errors: readonly unknown[];
}

async function runRecordedApproval(
  root: string,
  command: string,
  ruleContents: readonly string[],
): Promise<RecordedApproval> {
  const environment = stripCallbackEnvironment();
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  const ruleFiles = await writeRuleFiles(root, ruleContents);
  let session: AgentSession | undefined;
  try {
    const config = {
      ...DEFAULT_HARNESS_CONFIG,
      shell: {
        preflight: true,
        approval: {
          ...DEFAULT_HARNESS_CONFIG.shell.approval,
          enabled: true,
          mode: "ask" as const,
          command: [process.execPath, "-e", RECORDING_POLICY_SCRIPT],
          ruleFiles,
          commandTimeoutMs: 5_000,
          manualTimeoutMs: 1_000,
          reviewer: { ...DEFAULT_HARNESS_CONFIG.shell.approval.reviewer, enabled: false },
        },
      },
    };
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({
      api: "openai-responses",
      models: [{ id: "shell-approval-extraction-fixture", contextWindow: 1_048_576 }],
    });
    const model: Model<Api> = { ...faux.models[0]!, api: "openai-responses" };
    const steps: AssistantMessage[] = [
      toolCall(model, shellTool(), { command }, "call-extracted-shell"),
      done(model),
    ];
    faux.provider.streamSimple = (requestModel): AssistantMessageEventStreamType => {
      const message = steps.shift() ?? done(requestModel);
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      return stream;
    };
    runtime.registerNativeProvider(faux.provider);

    const settings = SettingsManager.inMemory({
      packages: [],
      extensions: [],
      defaultTools: ["bash", "powershell"],
      retry: { enabled: false },
      cacheWarming: "off",
      compaction: { enabled: false, keepRecentTokens: 0 },
    });
    const errors: unknown[] = [];
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [
        {
          name: "shell-approval-extraction-fixture",
          factory(api) {
            harnessConfigFor(api, config);
            shellPreflightExtension(api);
          },
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    session = (await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      model,
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
    })).session;
    await session.bindExtensions({ onError: error => { errors.push(error); } });
    await session.prompt("Run the recorded shell approval fixture.");
    return { session, records: await readPolicyRecords(ruleContents[1] ?? ""), errors };
  } catch (error) {
    session?.dispose();
    throw error;
  } finally {
    environment.restore();
  }
}

interface Scenario {
  readonly name: string;
  readonly mode: "ask" | "auto" | "yolo";
  readonly policy: "allow" | "deny" | "review";
  readonly reviewerEnabled: boolean;
  readonly kind: "marker" | "invalid" | "codemode";
  readonly markerExpected: boolean;
  readonly policyExpected: boolean;
  readonly expectedText: RegExp | null;
}

const scenarios: readonly Scenario[] = [
  {
    name: "ask mode executes an allowed command",
    mode: "ask", policy: "allow", reviewerEnabled: false, kind: "marker",
    markerExpected: true, policyExpected: true, expectedText: null,
  },
  {
    name: "ask mode blocks a denied command before execution",
    mode: "ask", policy: "deny", reviewerEnabled: false, kind: "marker",
    markerExpected: false, policyExpected: true, expectedText: /fixture policy deny/,
  },
  {
    name: "auto mode falls back to manual approval and denies without UI",
    mode: "auto", policy: "review", reviewerEnabled: false, kind: "marker",
    markerExpected: false, policyExpected: true, expectedText: /Manual approval denied \(no_ui\)/,
  },
  {
    name: "yolo skips policy but still blocks a syntax error",
    mode: "yolo", policy: "allow", reviewerEnabled: false, kind: "invalid",
    markerExpected: false, policyExpected: false, expectedText: /shell preflight failed/,
  },
  {
    name: "codemode nested bash calls pass through the same approval check",
    mode: "ask", policy: "deny", reviewerEnabled: false, kind: "codemode",
    markerExpected: false, policyExpected: true, expectedText: /fixture policy deny/,
  },
];

function shellTool(): "bash" | "powershell" {
  return process.platform === "win32" ? "powershell" : "bash";
}

function markerCommand(markerPath: string): string {
  const script = `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ok")`;
  return `node -e '${script}'`;
}

/**
 * Quote one literal argument for the shell that executes the command. This is
 * shell quoting, not JSON escaping: PowerShell doubles an embedded single quote,
 * POSIX closes the quote, emits an escaped quote and reopens it.
 */
function shellQuote(value: string): string {
  return process.platform === "win32"
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The pinned policy parser lowers only a literal PowerShell subset and keeps a
 * bare `--` opaque, while PowerShell passes a quoted `'--'` as the same
 * argument. This quotes the separator only where the parser needs it; a native
 * bare `--` still falls back to whole-command review.
 */
function createSeparator(): string {
  return process.platform === "win32" ? "'--'" : "--";
}

function invalidCommand(): string {
  return process.platform === "win32" ? "if ($true) {" : "if true; then";
}

function assistantMessage(
  model: Model<Api>,
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
  return {
    role: "assistant",
    api: model.api,
    provider: model.provider,
    model: model.id,
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      totalTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

function toolCall(model: Model<Api>, name: string, arguments_: JsonObject, id: string): AssistantMessage {
  return assistantMessage(model, [{ type: "toolCall", id, name, arguments: arguments_ }], "toolUse");
}

function done(model: Model<Api>): AssistantMessage {
  return assistantMessage(model, [{ type: "text", text: "Done" }], "stop");
}

function resultTexts(session: AgentSession): string[] {
  return session.messages.flatMap(message =>
    message.role === "toolResult" ? [contentText(message.content)] : []);
}

function stripCallbackEnvironment(): { restore(): void } {
  const keys = ["PI_AGENT_ID", "PI_AGENT_SOCKET", "PI_ASYNC_SHELL_TOKEN", "PI_ASYNC_SHELL_ROOT", "PI_CODING_AGENT_DIR"];
  const previous = new Map(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  return {
    restore() {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

for (const scenario of scenarios) {
  test(`Shell approval SDK: ${scenario.name}`, { timeout: 30_000 }, async t => {
    const environment = stripCallbackEnvironment();
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-shell-approval-sdk-"));
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
    let session: AgentSession | undefined;
    t.after(async () => {
      session?.dispose();
      environment.restore();
      await rm(root, { recursive: true, force: true });
    });

    const markerPath = path.join(root, "command-marker.txt");
    const policyMarkerPath = path.join(root, "policy-marker.txt");
    const ruleFiles = await writeRuleFiles(root, [scenario.policy, policyMarkerPath]);
    const config = {
      ...DEFAULT_HARNESS_CONFIG,
      shell: {
        preflight: true,
        approval: {
          ...DEFAULT_HARNESS_CONFIG.shell.approval,
          enabled: true,
          mode: scenario.mode,
          command: [process.execPath, "-e", POLICY_SCRIPT],
          ruleFiles,
          commandTimeoutMs: 5_000,
          manualTimeoutMs: 1_000,
          reviewer: {
            ...DEFAULT_HARNESS_CONFIG.shell.approval.reviewer,
            enabled: scenario.reviewerEnabled,
          },
        },
      },
    };

    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const faux = fauxProvider({
      api: "openai-responses",
      models: [{ id: "shell-approval-fixture", contextWindow: 1_048_576 }],
    });
    const model: Model<Api> = { ...faux.models[0]!, api: "openai-responses" };
    const command = scenario.kind === "invalid" ? invalidCommand() : markerCommand(markerPath);
    const tool = shellTool();
    const steps: AssistantMessage[] = scenario.kind === "codemode"
      ? [
          toolCall(model, "codemode", {
            code: `await tools.bash({ command: ${JSON.stringify(command)} });`,
          }, "call-codemode"),
          done(model),
        ]
      : [toolCall(model, tool, { command }, "call-shell"), done(model)];
    faux.provider.streamSimple = (requestModel): AssistantMessageEventStreamType => {
      const message = steps.shift() ?? done(requestModel);
      const stream = new AssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      stream.end();
      return stream;
    };
    runtime.registerNativeProvider(faux.provider);

    const settings = SettingsManager.inMemory({
      packages: [],
      extensions: [],
      defaultTools: ["bash", "powershell", "codemode"],
      retry: { enabled: false },
      cacheWarming: "off",
      compaction: { enabled: false, keepRecentTokens: 0 },
    });
    const errors: unknown[] = [];
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [
        { name: "codemode-sdk-fixture", factory: createCodemodeExtension(), replaceable: true },
        {
          name: "shell-approval-sdk-fixture",
          factory(api) {
            harnessConfigFor(api, config);
            shellPreflightExtension(api);
          },
        },
      ],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);

    session = (await createAgentSession({
      cwd: root,
      agentDir: root,
      modelRuntime: runtime,
      model,
      settingsManager: settings,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
    })).session;
    await session.bindExtensions({ onError: error => { errors.push(error); } });
    await session.prompt("Run the shell approval fixture.");

    assert.equal(existsSync(markerPath), scenario.markerExpected, "command execution matches the scenario");
    assert.equal(existsSync(policyMarkerPath), scenario.policyExpected, "static policy invocation matches the scenario");
    if (scenario.expectedText !== null) {
      const texts = resultTexts(session);
      assert.ok(texts.some(text => scenario.expectedText?.test(text)), JSON.stringify(texts));
    }
    assert.deepEqual(errors, []);
  });
}

test("real parser sends pi-job create actual argv and cwd to policy before denial", {
  skip: parserSkip,
  timeout: 30_000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-shell-extract-job-"));
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
  const jobCwd = path.join(root, "job-cwd");
  await mkdir(jobCwd, { recursive: true });
  const markerPath = path.join(jobCwd, "executed-marker.txt");
  const recordPath = path.join(root, "policy-records.jsonl");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed")`;
  const command = `pi-job create --cwd ${shellQuote(jobCwd)} ${createSeparator()} node -e ${shellQuote(script)}`;

  const result = await runRecordedApproval(root, command, ["deny", recordPath]);
  session = result.session;

  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(markerPath), false, "the denied pi-job command must not start");
  assert.equal(result.records.length, 1);
  const [record] = result.records;
  assert.ok(record !== undefined);
  assert.deepEqual(record.argv, ["node", "-e", script]);
  assert.equal(record.cwd, jobCwd);
  assert.equal(record.decision, "deny");
  assert.doesNotMatch(JSON.stringify(record.argv), /pi-job/);
});

test("real parser keeps a native bare -- PowerShell command opaque and denies the whole command", {
  skip: process.platform === "win32" ? parserSkip : "PowerShell policy parser semantics are Windows-only",
  timeout: 30_000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-shell-extract-bare-separator-"));
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
  const jobCwd = path.join(root, "job-cwd");
  await mkdir(jobCwd, { recursive: true });
  const markerPath = path.join(jobCwd, "executed-marker.txt");
  const recordPath = path.join(root, "policy-records.jsonl");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed")`;
  // Native PowerShell spelling: an unquoted `--` separator, which the pinned
  // parser cannot lower. The harness must review the original command instead
  // of inventing an argv it never proved.
  const command = `pi-job create --cwd ${shellQuote(jobCwd)} -- node -e ${shellQuote(script)}`;

  const result = await runRecordedApproval(root, command, ["deny", recordPath]);
  session = result.session;

  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(markerPath), false, "the denied command must not start");
  assert.equal(result.records.length, 1);
  const [record] = result.records;
  assert.ok(record !== undefined);
  assert.deepEqual(record.argv, []);
  assert.equal(record.cwd, root);
  assert.equal(record.command, command);
  assert.equal(record.decision, "deny");
});

test("real parser reviews every compound candidate and any denial blocks execution", {
  skip: parserSkip,
  timeout: 30_000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-shell-extract-compound-"));
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
  const jobCwd = path.join(root, "job-cwd");
  await mkdir(jobCwd, { recursive: true });
  const markerPath = path.join(jobCwd, "dangerous-executed.txt");
  const recordPath = path.join(root, "policy-records.jsonl");
  const script = `require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "executed"); // dangerous`;
  const command = `echo sibling && pi-job create --cwd ${shellQuote(jobCwd)} ${createSeparator()} node -e ${shellQuote(script)}`;

  const result = await runRecordedApproval(root, command, ["allow", recordPath, "dangerous"]);
  session = result.session;

  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(markerPath), false, "a denied candidate blocks the whole compound command");
  assert.equal(result.records.length, 2);
  const [sibling, job] = result.records;
  assert.ok(sibling !== undefined);
  assert.ok(job !== undefined);
  assert.deepEqual(sibling.argv, ["echo", "sibling"]);
  assert.equal(sibling.cwd, root);
  assert.equal(sibling.decision, "allow");
  assert.deepEqual(job.argv, ["node", "-e", script]);
  assert.equal(job.cwd, jobCwd);
  assert.equal(job.decision, "deny");
});

test("send/key-only pi-job commands are user-authorized and never call static policy", {
  skip: parserSkip,
  timeout: 30_000,
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-shell-extract-send-key-"));
  let session: AgentSession | undefined;
  t.after(async () => { session?.dispose(); await rm(root, { recursive: true, force: true }); });
  const recordPath = path.join(root, "policy-records.jsonl");
  const command = "pi-job key job_00000000 Enter; pi-job send job_00000000 hello";

  const result = await runRecordedApproval(root, command, ["deny", recordPath]);
  session = result.session;

  assert.deepEqual(result.errors, []);
  assert.equal(existsSync(recordPath), false, "send/key-only commands must not invoke static policy");
  assert.equal(result.records.length, 0);
});
