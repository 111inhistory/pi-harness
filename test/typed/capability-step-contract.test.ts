import assert from "node:assert/strict";
import test from "node:test";

import type { TSchema } from "@earendil-works/pi-ai";

import { promptText } from "../../src/prompt-text.ts";
import {
  CAPABILITY_PARAMETERS,
  CAPABILITY_STEP_PARAMETERS,
  CAPABILITY_STEP_TOOL_NAME,
  CAPABILITY_TOOL_DESCRIPTION,
} from "../../src/capability/contracts.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

const publicSchema: TSchema = CAPABILITY_PARAMETERS;
const stepSchema: TSchema = CAPABILITY_STEP_PARAMETERS;

const tools = record(JSON.parse(promptText("capability-tools.json")));
const stepText = record(tools.step);
const stepParameters = record(stepText.parameters);

test("public capability schema stays empty and strict", () => {
  assert.equal(publicSchema, CAPABILITY_PARAMETERS);
  assert.deepEqual(CAPABILITY_PARAMETERS, {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.equal(CAPABILITY_TOOL_DESCRIPTION, record(tools.capability).description);
});

test("capability_step schema makes all fields optional with defaults", () => {
  assert.equal(CAPABILITY_STEP_TOOL_NAME, "capability_step");
  assert.equal(stepSchema, CAPABILITY_STEP_PARAMETERS);
  const schema = record(CAPABILITY_STEP_PARAMETERS);
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required ?? [], []);

  const properties = record(schema.properties);
  const queries = record(properties.queries);
  const refs = record(properties.refs);
  const finish = record(properties.finish);
  assert.equal(queries.type, "array");
  assert.equal(record(queries.items).type, "string");
  assert.deepEqual(queries.default, []);
  assert.equal(refs.type, "array");
  assert.equal(record(refs.items).type, "string");
  assert.deepEqual(refs.default, []);
  assert.equal(finish.type, "boolean");
  assert.equal(finish.default, false);
  assert.equal(typeof stepText.description, "string");
  assert.ok(String(stepText.description).length > 0);
  assert.equal(queries.description, stepParameters.queries);
  assert.equal(refs.description, stepParameters.refs);
  assert.equal(finish.description, stepParameters.finish);
});

test("tool prompt exposes the step section instead of the old search and submit sections", () => {
  assert.deepEqual(Object.keys(tools), ["capability", "step"]);
  assert.deepEqual(Object.keys(stepParameters), ["queries", "refs", "finish"]);
});
