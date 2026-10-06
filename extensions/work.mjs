import { createWorkDispatcher } from "../src/work.mjs";

const workParameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["add", "focus", "show", "desc.add", "desc.delete", "desc.query"],
      description: "Work operation to perform.",
    },
    attach: { type: "string", description: "Existing node ID or root for add." },
    items: {
      type: "array",
      minItems: 1,
      description: "Recursive ordered work items. Each item accepts title, optional kind, desc, and items.",
      items: { type: "object" },
    },
    id: { type: "string", description: "Node ID for focus/show; show defaults to current focus." },
    nodeId: { type: "string", description: "Owning node ID for desc operations." },
    entryId: { type: "integer", minimum: 1, description: "Description entry ID." },
    content: { type: "string", description: "Description text to add." },
    query: { type: "string", description: "Optional case-insensitive description filter." },
    depth: { type: "integer", minimum: 0, description: "Compact view descendant depth." },
    full: { type: "boolean", description: "Render the complete subtree and descriptions." },
  },
  required: ["action"],
  additionalProperties: false,
};

export default function workExtension(pi) {
  const { dispatch } = createWorkDispatcher();

  pi.registerTool({
    name: "work",
    label: "Work",
    description:
      "Manage an in-memory recursive TODO tree. Add ordered item/branch subtrees atomically, change the viewing focus, render the tree, and manage node descriptions. This tool records work only; it does not execute tasks or launch subagents.",
    parameters: workParameters,
    async execute(_toolCallId, params) {
      const response = dispatch({ tool: "work", ...params });
      const text = typeof response === "string" ? response : JSON.stringify(response);
      return {
        content: [{ type: "text", text }],
        details: { action: params.action, response },
      };
    },
  });
}
