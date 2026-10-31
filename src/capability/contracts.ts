/**
 * Tool contracts for capability discovery.
 *
 * Discovery tools share these schemas. Descriptions come from
 * `prompts/capability-tools.json`; no schema text is duplicated in code.
 *
 * The internal `capability_step` tool is local-only. The schema must advertise
 * exactly the source the engine can execute; the engine accepts only local
 * searches at execution time.
 */

import { Type } from "@earendil-works/pi-ai";
import type { Static } from "@earendil-works/pi-ai";

import { promptText } from "../prompt-text.mjs";

interface CapabilityToolsPrompt {
  readonly capability: {
    readonly description: string;
  };
  readonly step: {
    readonly description: string;
    readonly parameters: {
      readonly queries: string;
      readonly refs: string;
      readonly finish: string;
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
export const CAPABILITY_PARAMETERS = Type.Object({}, { additionalProperties: false });

export type CapabilityParameters = Static<typeof CAPABILITY_PARAMETERS>;

/** Internal retrieval tool: only the nested capability retrieval agent sees this. */
export const CAPABILITY_STEP_TOOL_NAME = "capability_step" as const;

/**
 * One batched retrieval step. The engine submits `refs` selected from earlier
 * results first, then launches `queries` as parallel local searches. `finish`
 * ends discovery after this step; it is absent/false for a continuing step.
 */
export const CAPABILITY_STEP_PARAMETERS = Type.Object(
  {
    queries: Type.Optional(Type.Array(Type.String(), {
      default: [],
      description: toolsPrompt.step.parameters.queries,
    })),
    refs: Type.Optional(Type.Array(Type.String(), {
      default: [],
      description: toolsPrompt.step.parameters.refs,
    })),
    finish: Type.Optional(
      Type.Boolean({
        default: false,
        description: toolsPrompt.step.parameters.finish,
      }),
    ),
  },
  { additionalProperties: false },
);

export type CapabilityStepParameters = Static<typeof CAPABILITY_STEP_PARAMETERS>;

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
