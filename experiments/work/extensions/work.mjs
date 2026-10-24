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
      "Manage an in-memory work tree. Actions: add (attach, items), focus (id), show (optional id, depth, full), desc.add (nodeId, content), desc.delete (nodeId, entryId), desc.query (nodeId, optional query). Records work only; does not execute tasks.",
    promptSnippet: "Record and inspect a recursive work tree",
    promptGuidelines: [
      "Use returned node IDs for work operations. focus changes only the view; it does not start, stop, or complete work.",
    ],
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
