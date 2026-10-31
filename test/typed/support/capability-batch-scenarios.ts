/**
 * Real-SDK Capability scenarios for the batched capability_step protocol.
 */

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";

import type { Api, Message, Model, ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools, getSystemMessageText } from "@earendil-works/pi-ai";
import { createWriteToolDefinition, type DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { resolveTranscriptTools } from "../../../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js";
import { convertResponsesMessages } from "../../../node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js";

import { deferred } from "../../../test-support/async.mjs";
import { promptString } from "../../../src/prompt-text.ts";
import { CAPABILITY_STEP_TOOL_NAME } from "../../../src/capability/contracts.ts";
import type { CapabilityDiscoveryResult, CapabilityStepDetails } from "../../../src/capability/agent.ts";
import { deliverToActor, type FixtureChat, type ScenarioFixture } from "./subagent-sdk-fixture.ts";
import { capabilityGuiText } from "./capability-gui.ts";

export interface CapabilityScenarioFixture extends ScenarioFixture {
  readonly resourceLoader: DefaultResourceLoader;
  readonly model: Model<Api>;
  readonly networkAttempts: readonly string[];
  getExternalToolExecutions(): number;
}

function textOf(context: { messages: readonly Message[] }): string {
  return context.messages
    .map((message) => {
      if (message.role === "system") {
        return getSystemMessageText(message);
      }
      if (typeof message.content === "string") {
        return message.content;
      }
      if (Array.isArray(message.content)) {
        return message.content
          .filter(
            (block): block is { type: "text"; text: string } =>
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              block.type === "text" &&
              typeof (block as { text?: unknown }).text === "string",
          )
          .map((block) => block.text)
          .join("\n");
      }
      return "";
    })
    .join("\n");
}

export async function runPackageSkillsScenario(
  fixture: CapabilityScenarioFixture,
  { cold, expected }: { cold: boolean; expected: readonly string[] },
): Promise<void> {
  const { session, resourceLoader, chats, controls, call, toolAnswer, networkAttempts } = fixture;
  const inventory = session.extensionRunner.createContext();
  const loaded = resourceLoader.getSkills().skills;
  if (cold) {
    assert.deepEqual(loaded, [], "cold Session has no loaded Skills or command entries");
  } else {
    assert.ok(loaded.some((skill) => skill.name === "ppt-master"));
    assert.ok(loaded.some((skill) => skill.name === "private-ppt"));
  }
  assert.ok(!loaded.some((skill) => skill.name === "filtered-ppt"));
  await session.prompt("Visibility check: do not use tools.");
  const lastChat = chats.at(-1);
  assert.ok(lastChat);
  assert.doesNotMatch(
    lastChat.text,
    /<available_skills>|<name>ppt-master<\/name>|Native package PPT guidance/,
    "loaded Skills must not be advertised in the base prompt before Capability discovery",
  );
  if (!cold) {
    assert.ok(
      resourceLoader.getSkills().skills.some((skill) => skill.name === "ppt-master"),
      "hiding prompt summaries must retain Pi's resource inventory",
    );
  }
  controls.chat = (request: FixtureChat) => {
    const stepResult = request.context.messages.findLast(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolName === CAPABILITY_STEP_TOOL_NAME,
    );
    if (!stepResult) return toolAnswer(CAPABILITY_STEP_TOOL_NAME, { queries: ["ppt"], refs: [] });
    const firstContent = stepResult.content[0];
    const rawText =
      typeof firstContent === "object" && firstContent !== null && "text" in firstContent && typeof firstContent.text === "string"
        ? firstContent.text
        : "";
    const details = JSON.parse(rawText) as CapabilityStepDetails;
    const matches = details.searches[0];
    assert.ok(matches);
    assert.deepEqual(matches.skills.map((skill) => skill.name).sort(), expected);
    assert.deepEqual(matches.warnings, []);
    assert.ok(matches.skills.every((skill) => path.isAbsolute(skill.filePath) && skill.ref === skill.filePath));
    return toolAnswer(CAPABILITY_STEP_TOOL_NAME, {
      queries: [],
      refs: matches.skills.map((skill) => skill.filePath),
      finish: true,
    });
  };
  const discovery = await call("capability", {});
  assert.equal(discovery.isError, false, JSON.stringify(discovery.details));
  const discoveryDetails = discovery.details as CapabilityDiscoveryResult;
  assert.deepEqual(discoveryDetails.skills.map((skill) => skill.name).sort(), expected);
  const firstContent = discovery.content[0];
  const rawDiscoveryText =
    typeof firstContent === "object" && firstContent !== null && "text" in firstContent && typeof firstContent.text === "string"
      ? firstContent.text
      : "";
  const visible = JSON.parse(rawDiscoveryText) as {
    warnings?: unknown;
    skills: Array<{ name: string; filePath: string; [key: string]: unknown }>;
  };
  assert.equal(visible.warnings, undefined);
  for (const hit of visible.skills) {
    for (const field of ["match", "score", "reason"]) {
      assert.equal(hit[field], undefined, `Main must not see ${field}`);
    }
  }
  assert.ok(
    discoveryDetails.skills.every(
      (hit) =>
        typeof (hit as { score?: unknown }).score === "number" &&
        typeof (hit as { reason?: unknown }).reason === "string",
    ),
    "ranking remains host-owned diagnostics",
  );
  const nativeRead = session.getToolDefinition("read");
  assert.ok(nativeRead);
  const entry = visible.skills.find((skill) => skill.name === "ppt-master");
  assert.ok(entry);
  const entryPath = entry.filePath;
  assert.ok(path.isAbsolute(entryPath));
  const resource = await nativeRead.execute(
    "read-package-skill",
    { path: entryPath },
    undefined,
    undefined,
    inventory as unknown as Parameters<typeof nativeRead.execute>[4],
  );
  const resourcePart = resource.content[0];
  const resourceText =
    typeof resourcePart === "object" && resourcePart !== null && "text" in resourcePart && typeof resourcePart.text === "string"
      ? resourcePart.text
      : "";
  assert.match(resourceText, /Native package PPT guidance/);
  assert.deepEqual(networkAttempts, [], "installed/CLI skills must not resolve or install missing packages");
}

export async function runResponsesOnlyScenario(fixture: CapabilityScenarioFixture): Promise<void> {
  const { session, controls, call, toolAnswer, textAnswer, chats } = fixture;
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  await session.prompt("Seed Codemode-only context.");
  controls.chat = (request: FixtureChat) => {
    const result = request.context.messages.findLast(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolName === CAPABILITY_STEP_TOOL_NAME,
    );
    if (!result) return toolAnswer(CAPABILITY_STEP_TOOL_NAME, { queries: ["namespace://subagent"], refs: [] });
    return toolAnswer(CAPABILITY_STEP_TOOL_NAME, { queries: [], refs: ["namespace://subagent"], finish: true });
  };
  const discovery = await call("capability", {});
  assert.equal(discovery.isError, false, JSON.stringify(discovery.details));
  const firstContent = discovery.content[0];
  const rawText =
    typeof firstContent === "object" && firstContent !== null && "text" in firstContent && typeof firstContent.text === "string"
      ? firstContent.text
      : "";
  const parsed = JSON.parse(rawText) as {
    tools: Array<{ tools: Array<{ name: string; parameters?: { type?: string } }> }>;
  };
  const selectedInterfaces = parsed.tools[0]?.tools ?? [];
  assert.equal(selectedInterfaces.length, 3, "hidden direct declarations must not imply supplied interfaces");
  assert.ok(
    selectedInterfaces.every((tool) => tool.parameters?.type === "object"),
    "selected interfaces must be supplied without a resource-read protocol",
  );
  controls.chat = () => textAnswer("Only mode continued");
  await session.prompt("Continue without directly declared Subagent interfaces.");
  const lastChat = chats.at(-1);
  assert.ok(lastChat);
  assert.deepEqual(getCurrentTools(lastChat.context.messages).map((tool) => tool.name), ["codemode"]);
}

export async function runResponsesPrefixScenario(fixture: CapabilityScenarioFixture): Promise<void> {
  const { session, cwd, model, chats, controls, call, toolAnswer, textAnswer } = fixture;
  const members = ["subagent_create", "subagent_list", "subagent_stop"];
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  await session.prompt("Seed a stable Responses transcript without calling tools.");
  const firstChat = chats[0];
  assert.ok(firstChat);
  const initial = structuredClone(firstChat.context.messages[0]);
  session.setThinkingLevel("high");
  let internalCalls = 0;
  controls.chat = (request: FixtureChat) => {
    const declared = getCurrentTools(request.context.messages).map((tool) => tool.name);
    const resultOf = (name: string) =>
      request.context.messages.findLast(
        (message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === name,
      );
    if (declared.includes(CAPABILITY_STEP_TOOL_NAME)) {
      internalCalls++;
      assert.equal(request.options.reasoning, "high", "retrieval keeps the parent's effort for compatible Responses");
      const head = request.context.messages[0];
      assert.ok(head);
      const headSections =
        "sections" in head && typeof head.sections === "object" && head.sections !== null
          ? (head.sections as Record<string, unknown>)
          : {};
      const { capabilities: _discoveryMemory, ...baseSections } = headSections;
      assert.deepEqual(
        { ...head, sections: baseSections },
        initial,
        "retrieval retains the base prompt and tool prefix while adding branch discovery memory",
      );
      assert.deepEqual(
        resolveTranscriptTools(request.context.messages, "changes").requestTools,
        [],
        "changes-capable Responses declare interfaces in the transcript",
      );
      const lastMessage = request.context.messages.at(-1);
      assert.ok(lastMessage && lastMessage.role === "system");
      assert.equal(getSystemMessageText(lastMessage), promptString("capability-policy.json", "additiveExecutionBlocked"));
      const deniedWrite = resultOf("write");
      if (!deniedWrite) {
        return toolAnswer("write", { path: "forbidden.txt", content: "must not execute" }, "forbidden-write");
      }
      assert.equal(deniedWrite.isError, true);
      const deniedWritePart = deniedWrite.content[0];
      const deniedWriteText =
        typeof deniedWritePart === "object" && deniedWritePart !== null && "text" in deniedWritePart && typeof deniedWritePart.text === "string"
          ? deniedWritePart.text
          : "";
      assert.match(deniedWriteText, /unavailable in capability discovery/);
      const deniedCodemode = resultOf("codemode");
      if (!deniedCodemode) {
        return toolAnswer(
          "codemode",
          { code: 'await tools.write({path:"forbidden-nested.txt",content:"no"})' },
          "forbidden-codemode",
        );
      }
      assert.equal(deniedCodemode.isError, true);
      const deniedCodemodePart = deniedCodemode.content[0];
      const deniedCodemodeText =
        typeof deniedCodemodePart === "object" && deniedCodemodePart !== null && "text" in deniedCodemodePart && typeof deniedCodemodePart.text === "string"
          ? deniedCodemodePart.text
          : "";
      assert.match(deniedCodemodeText, /unavailable in capability discovery/);
      if (!resultOf(CAPABILITY_STEP_TOOL_NAME)) {
        return toolAnswer(CAPABILITY_STEP_TOOL_NAME, { queries: ["namespace://subagent"], refs: [] }, "search-group");
      }
      return toolAnswer(CAPABILITY_STEP_TOOL_NAME, { queries: [], refs: ["namespace://subagent"], finish: true }, "submit-group");
    }
    return textAnswer("Parent completed");
  };
  const discovery = await call("capability", {});
  assert.equal(discovery.isError, false, JSON.stringify(discovery.details));
  assert.equal(internalCalls, 4);
  const firstContent = discovery.content[0];
  const rawText =
    typeof firstContent === "object" && firstContent !== null && "text" in firstContent && typeof firstContent.text === "string"
      ? firstContent.text
      : "";
  const compact = JSON.parse(rawText) as {
    tools: Array<{ tools?: unknown; description?: unknown; instructions?: string }>;
  };
  const compactGui = capabilityGuiText(fixture, discovery);
  assert.match(compactGui, /"interface":/);
  assert.doesNotMatch(compactGui, /"parameters":/);
  assert.equal(compact.tools[0]?.tools, undefined);
  assert.equal(compact.tools[0]?.description, undefined);
  const subagentCreateDef = session.getToolDefinition(members[0]!);
  assert.ok(subagentCreateDef);
  assert.equal(
    compact.tools[0]?.instructions,
    (subagentCreateDef as unknown as { namespace: { instructions: string } }).namespace.instructions,
    "compaction preserves the namespace's shared guidance",
  );
  const discoveryDetails = discovery.details as CapabilityDiscoveryResult;
  const toolsGroup = discoveryDetails.tools[0] as unknown as { tools: Array<{ name: string }> };
  assert.deepEqual(toolsGroup.tools.map((tool) => tool.name), members);
  assert.ok(members.every((name) => session.getActiveToolNames().includes(name)));
  const repeated = await call("capability", {});
  assert.equal(repeated.isError, false, JSON.stringify(repeated.details));
  const repeatedFirst = repeated.content[0];
  const repeatedRaw =
    typeof repeatedFirst === "object" && repeatedFirst !== null && "text" in repeatedFirst && typeof repeatedFirst.text === "string"
      ? repeatedFirst.text
      : "";
  const repeatedText = JSON.parse(repeatedRaw) as {
    tools: unknown[];
    mcp: unknown[];
    guidance: Array<{ ref: string }>;
  };
  assert.deepEqual(repeatedText.tools, [], "already active tools must not be reported as new interfaces");
  assert.deepEqual(repeatedText.mcp, []);
  assert.equal(repeatedText.guidance[0]?.ref, "namespace://subagent");
  assert.match(capabilityGuiText(fixture, repeated), /"guidance":/);
  const repeatedDetails = repeated.details as CapabilityDiscoveryResult;
  const repeatedToolsGroup = repeatedDetails.tools[0] as unknown as { tools: unknown[] };
  assert.equal(repeatedToolsGroup.tools.length, 3, "full selection remains in details, not model text");
  assert.equal(internalCalls, 8);
  await assert.rejects(fsp.stat(path.join(cwd, "forbidden.txt")), { code: "ENOENT" });
  await assert.rejects(fsp.stat(path.join(cwd, "forbidden-nested.txt")), { code: "ENOENT" });
  await session.prompt("Continue after capability activation.");
  const addedContext = chats.at(-1)!.context;
  const resolved = resolveTranscriptTools(addedContext.messages, "changes");
  assert.deepEqual(resolved.requestTools, [], "current Responses use inline tool declarations rather than a second top-level loadout");
  const wire = convertResponsesMessages(
    model,
    addedContext as unknown as TranscriptContext,
    new Set([model.provider]),
    { includeSystemPrompt: false, ...model.compat },
  );
  const declaredInterfaces = (wire as Array<{ type: string; tools?: Array<{ name: string; parameters?: object }> }>)
    .filter((item) => item.type === "additional_tools")
    .flatMap((item) => item.tools ?? []);
  for (const name of members) {
    assert.ok(
      declaredInterfaces.some((tool) => tool.name === name && typeof tool.parameters === "object"),
      `wire request declares ${name}`,
    );
  }
  session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "external_test_tool"));
  controls.chat = (request: FixtureChat) => {
    const results = request.context.messages.filter(
      (message): message is ToolResultMessage => message.role === "toolResult",
    );
    if (!results.some((result) => result.toolCallId === "disabled-direct")) {
      return toolAnswer("external_test_tool", {}, "disabled-direct");
    }
    if (!results.some((result) => result.toolCallId === "disabled-nested")) {
      return toolAnswer(
        "codemode",
        { code: 'try { await tools.external_test_tool({}); text("UNEXPECTED_EXECUTION"); } catch (error) { text("DISABLED_EXTERNAL_TOOL: " + error.message); }' },
        "disabled-nested",
      );
    }
    return textAnswer("Disabled calls refused");
  };
  await session.prompt("Exercise disabled direct and nested calls.");
  assert.equal(fixture.getExternalToolExecutions(), 0);
  const refused = session.messages.filter(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && ["disabled-direct", "disabled-nested"].includes(message.toolCallId),
  );
  assert.equal(refused.length, 2);
  assert.equal(refused[0]!.isError, true);
  const refusedDirectPart = refused[0]!.content[0];
  const refusedDirectText =
    typeof refusedDirectPart === "object" && refusedDirectPart !== null && "text" in refusedDirectPart && typeof refusedDirectPart.text === "string"
      ? refusedDirectPart.text
      : "";
  assert.match(refusedDirectText, /external_test_tool.*(not found|unavailable)/);
  const refusedNestedText = refused[1]!.content
    .map((part) => (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""))
    .join("\n");
  assert.match(
    refusedNestedText,
    /DISABLED_EXTERNAL_TOOL:/,
    "nested call must reach the script and be refused before execution",
  );
  assert.doesNotMatch(refusedNestedText, /UNEXPECTED_EXECUTION/);
  const lastChat = chats.at(-1)!;
  assert.deepEqual(resolveTranscriptTools(lastChat.context.messages, "changes").requestTools, []);
  assert.match(textOf(lastChat.context), /external_test_tool is unavailable/);
  session.setActiveToolsByName([...session.getActiveToolNames(), "external_test_tool"]);
  controls.chat = () => textAnswer("Re-enabled");
  await session.prompt("Re-enable without a second declaration.");
  const reenabledLast = chats.at(-1)!;
  assert.deepEqual(resolveTranscriptTools(reenabledLast.context.messages, "changes").requestTools, []);
  const addedTools = (
    reenabledLast.context.messages as Array<{ toolsAdded?: Array<{ name: string }> }>
  ).flatMap((message) => message.toolsAdded ?? []);
  assert.equal(
    addedTools.filter((tool) => tool.name === "external_test_tool").length,
    1,
  );
  assert.match(textOf(reenabledLast.context), /external_test_tool is available again/);
}

export async function runCapabilityMissingScenario(fixture: CapabilityScenarioFixture): Promise<void> {
  const { controls, call, toolAnswer, chats, classifications } = fixture;
  controls.chat = (request: FixtureChat) => {
    const searched = request.context.messages.some(
      (message) => message.role === "toolResult" && message.toolName === CAPABILITY_STEP_TOOL_NAME,
    );
    return searched
      ? toolAnswer(CAPABILITY_STEP_TOOL_NAME, { queries: [], refs: [], finish: true })
      : toolAnswer(CAPABILITY_STEP_TOOL_NAME, { queries: ["no matching local fixture"], refs: [] });
  };
  const result = await call("capability", {});
  assert.equal(result.isError, false, JSON.stringify(result.details));
  const details = result.details as CapabilityDiscoveryResult;
  assert.equal(details.status, "ok");
  assert.ok(chats.length > 0, "internal execution does not require public Subagent tools");
  assert.equal(classifications.length, 0, "internal retrieval does not enter public task role routing");
}

export async function runNamespaceScenario(fixture: CapabilityScenarioFixture): Promise<void> {
  const { session, cwd, controls, call, toolAnswer, create, stopped, chats } = fixture;
  const members = ["subagent_create", "subagent_list", "subagent_stop"];
  const initial = session.getActiveToolNames();
  assert.ok(members.every((name) => !initial.includes(name)));
  assert.doesNotMatch(session.systemPrompt, /subagent_create|one JSON object per line/);
  const nativeWrite = createWriteToolDefinition(cwd);
  const sessionWrite = session.getToolDefinition("write");
  assert.ok(sessionWrite);
  assert.equal(sessionWrite.description, nativeWrite.description);
  controls.chat = (request: FixtureChat) => {
    assert.deepEqual(
      getCurrentTools(request.context.messages).map((tool) => tool.name).sort(),
      [CAPABILITY_STEP_TOOL_NAME],
    );
    const stepResult = request.context.messages.findLast(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolName === CAPABILITY_STEP_TOOL_NAME,
    );
    if (!stepResult) return toolAnswer(CAPABILITY_STEP_TOOL_NAME, { queries: ["subagent"], refs: [] });
    const textPart = stepResult.content.find(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && "type" in part && part.type === "text" && typeof (part as { text?: unknown }).text === "string",
    );
    assert.ok(textPart);
    const found = JSON.parse(textPart.text) as CapabilityStepDetails;
    const searchResult = found.searches[0];
    assert.ok(searchResult);
    const namespaces = (
      searchResult.tools as Array<{ namespace?: string; ref: string; tools: Array<{ name: string }> }>
    ).filter((hit) => hit.namespace === "subagent");
    assert.equal(namespaces.length, 1, "matching members must collapse to one namespace candidate");
    const matchedNamespace = namespaces[0]!;
    assert.equal(matchedNamespace.ref, "namespace://subagent");
    assert.deepEqual(matchedNamespace.tools.map((tool) => tool.name), members);
    return toolAnswer(CAPABILITY_STEP_TOOL_NAME, { queries: [], refs: [matchedNamespace.ref], finish: true });
  };
  const discoveryResult = await call("capability", {});
  const discovery = discoveryResult.details as unknown as {
    tools: Array<{ kind: string; namespace: string; tools: Array<{ name: string }>; instructions: string; description: string }>;
  };
  const expandedGui = capabilityGuiText(fixture, discoveryResult);
  assert.match(expandedGui, /"parameters":/);
  assert.doesNotMatch(expandedGui, /"interface":/);
  assert.equal(discovery.tools.length, 1, JSON.stringify(discovery));
  const toolEntry = discovery.tools[0]!;
  assert.equal(toolEntry.kind, "namespace");
  assert.equal(toolEntry.namespace, "subagent");
  assert.deepEqual(toolEntry.tools.map((tool) => tool.name), members);
  const subagentCreateDef = session.getToolDefinition(members[0]!);
  assert.ok(subagentCreateDef);
  assert.equal(
    toolEntry.instructions,
    (subagentCreateDef as unknown as { namespace: { instructions: string } }).namespace.instructions,
    "namespace discovery preserves the registered shared guidance",
  );
  assert.ok(members.every((name) => session.getActiveToolNames().includes(name)));
  const updatedWrite = session.getToolDefinition("write");
  assert.ok(updatedWrite);
  assert.equal(updatedWrite.description, nativeWrite.description);
  assert.ok(toolEntry.tools.some((tool) => tool.name === "subagent_stop"));
  assert.ok(toolEntry.description.length > 0);
  const gate = deferred() as unknown as { promise: Promise<unknown>; resolve: () => void };
  controls.chat = async () => {
    await gate.promise;
    return fixture.textAnswer("Namespace child done");
  };
  const actor = await create("Namespace task");
  await deliverToActor(fixture, actor, "Namespace buffered message");
  gate.resolve();
  await stopped(actor.id);
  const lastChat = chats.at(-1);
  assert.ok(lastChat);
  assert.match(lastChat.text, /Namespace buffered message/);
}
