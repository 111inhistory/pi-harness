/**
 * Preserved desired-contract regressions owned by the capability review file.
 *
 * Qualification is intentionally append-only: a child keeps eligibility that a
 * parent granted earlier even when the parent later stops exposing the tool.
 * Capability discovery memory must also survive compaction because it is
 * rehydrated from branch records, not from the compacted transcript.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  capabilityAllowsTool,
  capabilityAvailableTools,
  setCapabilityParent,
} from "../../src/capability-scope.mjs";
import { capabilityPromptTranscript } from "../../src/capability-prompt.mjs";
import { additiveToolTranscript, supportsAdditiveResponses } from "../../src/responses-tool-prefix.mjs";

interface ScopeTool {
  readonly name: string;
  readonly exposure?: "hidden" | "direct" | "codemode" | "deferred";
}

interface ScopeApi {
  getActiveTools(): string[];
  getAllTools(): ScopeTool[];
}

interface MutableScope {
  readonly api: ScopeApi;
  setTools(tools: readonly ScopeTool[]): void;
}

function mutableScope(initial: readonly ScopeTool[]): MutableScope {
  let tools = [...initial];
  return {
    api: {
      getActiveTools: () => tools.map((tool) => tool.name),
      getAllTools: () => [...tools],
    },
    setTools(next: readonly ScopeTool[]): void {
      tools = [...next];
    },
  };
}

test("qualification stays append-only across parent tool changes and the available-tools view agrees with per-tool checks", () => {
  const read: ScopeTool = { name: "read", exposure: "direct" };
  const bash: ScopeTool = { name: "bash", exposure: "direct" };
  const calc: ScopeTool = { name: "mcp__server__calc", exposure: "direct" };

  const root = mutableScope([read, bash]);
  const child = mutableScope([read]);
  const leaf = mutableScope([read]);

  setCapabilityParent(child.api, root.api, ["bash"]); // role denial for bash
  setCapabilityParent(leaf.api, child.api);

  assert.equal(capabilityAllowsTool(child.api, "bash"), false, "role denial wins");
  assert.equal(capabilityAllowsTool(leaf.api, "bash"), false, "child role denial propagates to leaf");
  assert.equal(capabilityAllowsTool(leaf.api, calc.name), false);

  // Parent adds a new tool that the child never declared itself.
  root.setTools([read, bash, calc]);
  assert.equal(capabilityAllowsTool(leaf.api, calc.name), true);

  // Parent removes the tool later: eligibility gained earlier is not revoked.
  root.setTools([read, bash]);
  const available = capabilityAvailableTools(leaf.api);
  assert.equal(
    available.has(calc.name),
    true,
    "eligibility must be append-only (monotonic) across parent tool changes",
  );

  for (const name of [read.name, bash.name, calc.name, "mcp__server__never"]) {
    assert.equal(
      capabilityAllowsTool(leaf.api, name),
      available.has(name),
      `per-tool check and available-tools view must agree for ${name}`,
    );
  }
});

test("capability memory rehydrates from branch records after compaction while additive transcripts warn about removed tools", () => {
  // Additive responses are model-compatibility policy, not a capability rule.
  assert.equal(
    supportsAdditiveResponses({
      api: "openai-responses",
      compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
    }),
    true,
  );
  assert.equal(
    supportsAdditiveResponses({
      api: "anthropic",
      compat: { supportsMidConvoSystemMessages: true, supportsAdditionalTools: true },
    }),
    false,
  );

  const rewritten = additiveToolTranscript([
    {
      role: "system" as const,
      content: "Initial system prompt",
      toolsRemoved: [{ name: "bash" }],
    },
  ]);
  assert.equal(rewritten.length, 1);
  const content = rewritten[0]?.content;
  assert.match(
    typeof content === "string" ? content : "",
    /Tool bash is unavailable in this session\. Do not call it; execution is blocked\./,
  );

  const messagesWithCompaction = [
    { role: "user" as const, content: "Hello" },
    { role: "assistant" as const, content: [{ type: "text", text: "Compacted" }] },
  ];
  const branchEntries = [
    {
      type: "compaction",
      summary: "Compacted summary that forgets all tools and discoveries",
    },
    {
      type: "custom",
      customType: "capability-discovery",
      data: {
        version: 1,
        toolCallId: "c_test",
        result: {
          status: "ok",
          tools: [{ ref: "tool://read", name: "read", status: "available", kind: "tool" }],
          skills: [],
          mcp: [],
          guidance: [],
          coverage: { local: "searched", remote: "not_searched" },
        },
      },
    },
  ];

  const projected = capabilityPromptTranscript(messagesWithCompaction, branchEntries, {
    allowsTool: () => true,
  });

  const hasCapabilities = projected.some(
    (message: { role: string; sections?: Record<string, string> }) =>
      message.role === "system" && Boolean(message.sections?.capabilities?.includes("<capabilities>")),
  );
  assert.equal(
    hasCapabilities,
    true,
    "capability discovery must rehydrate from branch custom entries, surviving compaction summaries",
  );
});
