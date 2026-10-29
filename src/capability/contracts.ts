/**
 * Tool contracts for capability discovery.
 *
 * Discovery tools share these schemas. Descriptions come from
 * `prompts/capability-tools.json`; no schema text is duplicated in code.
 *
 * The internal `capability_search` tool is local-only. The schema must
 * advertise exactly the source the engine can execute; `src/capability-agent.mjs`
 * still fails closed for any other value at execution time.
 */

import { promptText } from "../prompt-text.mjs";

interface CapabilityToolsPrompt {
  readonly capability: {
    readonly description: string;
  };
  readonly search: {
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

const toolsPrompt: CapabilityToolsPrompt = JSON.parse(promptText("capability-tools.json"));

export const CAPABILITY_TOOL_NAME = "capability" as const;

export const CAPABILITY_TOOL_DESCRIPTION: string = toolsPrompt.capability.description;

/**
 * Model-visible schema of the public tool. Empty on purpose: the request is the
 * caller's conversation, and search categories, candidate counts and budget
 * controls are fixed harness behavior that must never become model input.
 */
export interface CapabilityParametersSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, never>>;
  readonly additionalProperties: false;
}

export const CAPABILITY_PARAMETERS: CapabilityParametersSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
  additionalProperties: false,
});

/** The only source group an internal capability search may request. */
export type CapabilitySearchSource = "local";

export const CAPABILITY_SEARCH_SOURCES = Object.freeze(["local"] as const);

/** Internal retrieval tool: only the nested capability search agent sees these. */
export const CAPABILITY_SEARCH_TOOL_NAME = "capability_search" as const;

export interface CapabilitySearchParametersSchema {
  readonly type: "object";
  readonly properties: {
    readonly query: {
      readonly type: "string";
      readonly minLength: 1;
      readonly description: string;
    };
    readonly src: {
      readonly type: "string";
      readonly enum: typeof CAPABILITY_SEARCH_SOURCES;
      readonly description: string;
    };
  };
  readonly required: readonly ["query", "src"];
  readonly additionalProperties: false;
}

export const CAPABILITY_SEARCH_PARAMETERS: CapabilitySearchParametersSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    query: Object.freeze({
      type: "string",
      minLength: 1,
      description: toolsPrompt.search.parameters.query,
    }),
    src: Object.freeze({
      type: "string",
      enum: CAPABILITY_SEARCH_SOURCES,
      description: toolsPrompt.search.parameters.src,
    }),
  }),
  required: Object.freeze(["query", "src"] as const),
  additionalProperties: false,
});

export const SUBMIT_RESULT_TOOL_NAME = "submit_result" as const;

export interface SubmitResultParametersSchema {
  readonly type: "object";
  readonly properties: {
    readonly refs: {
      readonly type: "array";
      readonly items: {
        readonly type: "string";
      };
      readonly description: string;
    };
  };
  readonly required: readonly ["refs"];
  readonly additionalProperties: false;
}

export const SUBMIT_RESULT_PARAMETERS: SubmitResultParametersSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({
    refs: Object.freeze({
      type: "array",
      items: Object.freeze({ type: "string" }),
      description: toolsPrompt.submit.parameters.refs,
    }),
  }),
  required: Object.freeze(["refs"] as const),
  additionalProperties: false,
});

/** Deterministic bounds for every result list and body read. */
export interface CapabilityLimits {
  readonly tools: number;
  readonly mcp: number;
  readonly skills: number;
  readonly skillBodies: number;
  readonly warnings: number;
  readonly requestTokens: number;
  readonly descriptionChars: number;
  readonly skillBodyChars: number;
  readonly warningChars: number;
}

export const CAPABILITY_LIMITS = Object.freeze({
  tools: 8, // standalone tools or whole namespaces, not member count
  mcp: 8, // whole MCP groups
  skills: 6,
  skillBodies: 6,
  warnings: 12,
  requestTokens: 128,
  descriptionChars: 240,
  skillBodyChars: 60_000,
  warningChars: 200,
} as const) satisfies CapabilityLimits;
