/**
 * Desired-contract regressions for the capability tool schemas and the
 * local-only `capability_search` source.
 *
 * The schema is owned by `src/capability/contracts.ts`; this file checks the
 * broker's public re-exports and the engine's actual execution behavior, so a
 * schema that advertises more than the engine executes fails here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_PARAMETERS,
  CAPABILITY_SEARCH_PARAMETERS,
  CAPABILITY_SEARCH_TOOL_NAME,
  SUBMIT_RESULT_PARAMETERS,
  SUBMIT_RESULT_TOOL_NAME,
} from "../../src/capability-broker.mjs";
import {
  CAPABILITY_SEARCH_SOURCES,
  type CapabilityParametersSchema,
  type CapabilitySearchParametersSchema,
  type SubmitResultParametersSchema,
} from "../../src/capability/contracts.ts";
import { createCapabilityDiscovery } from "../../src/capability-agent.mjs";
import { promptText } from "../../src/prompt-text.mjs";

interface CapabilityToolsPrompt {
  readonly capability: {
    readonly description: string;
    readonly guidelines: readonly string[];
  };
  readonly search: {
    readonly description: string;
    readonly parameters: {
      readonly query: string;
      readonly src: string;
    };
  };
  readonly submit: {
    readonly parameters: {
      readonly refs: string;
    };
  };
}

interface ToolExecutionResult {
  readonly content: Array<{ readonly type: string; readonly text: string }>;
  readonly isError?: boolean;
}

interface InternalTool {
  readonly name: string;
  execute(toolCallId: string, params: Record<string, unknown>): Promise<ToolExecutionResult>;
}

interface DiscoverySessionRequest {
  readonly customTools: readonly InternalTool[];
}

interface DiscoverySession {
  prompt(): Promise<unknown[]>;
  abort(): void;
  dispose(): Promise<void>;
}

interface BrokerSearchRequest {
  readonly query: string;
  readonly src: string;
}

interface GroupedResult {
  status: "ok";
  tools: [];
  mcp: [];
  skills: [];
  remote: [];
  missingCapabilities: [];
  warnings: [];
}

const toolsPrompt: CapabilityToolsPrompt = JSON.parse(promptText("capability-tools.json"));

function emptyGroupedResult(): GroupedResult {
  return {
    status: "ok",
    tools: [],
    mcp: [],
    skills: [],
    remote: [],
    missingCapabilities: [],
    warnings: [],
  };
}

test("capability_search advertises only the local source with the unchanged required shape", () => {
  const searchSchema: CapabilitySearchParametersSchema = CAPABILITY_SEARCH_PARAMETERS;
  const publicSchema: CapabilityParametersSchema = CAPABILITY_PARAMETERS;
  const submitSchema: SubmitResultParametersSchema = SUBMIT_RESULT_PARAMETERS;

  assert.equal(searchSchema.type, "object");
  assert.deepEqual([...searchSchema.required], ["query", "src"]);
  assert.equal(searchSchema.additionalProperties, false);
  assert.equal(searchSchema.properties.query.type, "string");
  assert.equal(searchSchema.properties.query.minLength, 1);
  assert.equal(searchSchema.properties.query.description, toolsPrompt.search.parameters.query);
  assert.ok(searchSchema.properties.query.description.length > 0);

  // I2: the enum is the single local source, not the executable-unreachable
  // remote/all options. The broker re-export is the same frozen array.
  assert.deepEqual([...searchSchema.properties.src.enum], ["local"]);
  assert.equal(searchSchema.properties.src.enum, CAPABILITY_SEARCH_SOURCES);
  assert.ok(Object.isFrozen(searchSchema.properties.src.enum));
  assert.equal(searchSchema.properties.src.description, toolsPrompt.search.parameters.src);
  assert.match(searchSchema.properties.src.description, /local:/);
  assert.doesNotMatch(searchSchema.properties.src.description, /\bremote:|\ball:/);
  assert.doesNotMatch(searchSchema.properties.src.description, /installation requests/);

  assert.equal(publicSchema.type, "object");
  assert.equal(Object.keys(publicSchema.properties).length, 0);
  assert.equal(publicSchema.additionalProperties, false);

  assert.equal(submitSchema.type, "object");
  assert.deepEqual([...submitSchema.required], ["refs"]);
  assert.equal(submitSchema.additionalProperties, false);
  assert.equal(submitSchema.properties.refs.type, "array");
  assert.equal(submitSchema.properties.refs.items.type, "string");
  assert.equal(submitSchema.properties.refs.description, toolsPrompt.submit.parameters.refs);
});

test("capability prompts no longer advertise remote choices or the obsolete needs_approval guideline", () => {
  assert.match(toolsPrompt.search.description, /local/i);
  assert.doesNotMatch(toolsPrompt.search.description, /\bremote:|\ball:/);

  assert.ok(Array.isArray(toolsPrompt.capability.guidelines));
  assert.ok(toolsPrompt.capability.guidelines.length > 0);
  for (const guideline of toolsPrompt.capability.guidelines) {
    assert.equal(typeof guideline, "string");
    assert.ok(guideline.trim().length > 0);
    assert.doesNotMatch(guideline, /needs_approval/);
  }
});

test("the production engine fails closed for every non-local src and calls the broker only for local", async () => {
  const calls: BrokerSearchRequest[] = [];
  const broker = {
    async search(request: BrokerSearchRequest): Promise<GroupedResult> {
      calls.push({ query: request.query, src: request.src });
      return emptyGroupedResult();
    },
  };

  const openSession = async (request: DiscoverySessionRequest): Promise<DiscoverySession> => {
    const search = request.customTools.find((tool) => tool.name === CAPABILITY_SEARCH_TOOL_NAME);
    assert.ok(search, "capability_search must be registered");
    assert.ok(
      request.customTools.some((tool) => tool.name === SUBMIT_RESULT_TOOL_NAME),
      "submit_result must be registered",
    );

    return {
      async prompt(): Promise<unknown[]> {
        const remote = await search.execute("call-1", { query: "read", src: "remote" });
        assert.equal(remote.isError, true);
        assert.equal(remote.content[0]?.text, 'capability_search requires src to be "local".');

        const all = await search.execute("call-2", { query: "read", src: "all" });
        assert.equal(all.isError, true);
        assert.equal(all.content[0]?.text, 'capability_search requires src to be "local".');

        const unknown = await search.execute("call-3", { query: "read", src: "web" });
        assert.equal(unknown.isError, true);
        assert.match(unknown.content[0]?.text ?? "", /capability_search requires src to be "local"/);

        const missing = await search.execute("call-4", { query: "read" });
        assert.equal(missing.isError, true);
        assert.match(missing.content[0]?.text ?? "", /capability_search requires src to be "local"/);

        const emptyQuery = await search.execute("call-5", { query: "   ", src: "local" });
        assert.equal(emptyQuery.isError, true);
        assert.match(emptyQuery.content[0]?.text ?? "", /non-empty query/);

        const local = await search.execute("call-6", { query: "read", src: "local" });
        assert.equal(local.isError, undefined);
        return [];
      },
      abort(): void {},
      async dispose(): Promise<void> {},
    };
  };

  const discovery = createCapabilityDiscovery({ broker, openSession });
  await discovery.discover({ cwd: "/test" });

  assert.deepEqual(calls, [{ query: "read", src: "local" }], "only a local search may reach the broker");
});
