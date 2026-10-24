const ROOT_ID = "root";
const ROOT_KIND = "root";
const ROOT_TITLE = "TODO";
const DEFAULT_DEPTH = 2;

const NODE_KINDS = new Set(["item", "branch"]);
const STATUS_MARKERS = {
  pending: "[ ]",
  active: "[>]",
  done: "[x]",
  blocked: "[!]",
  paused: "[-]",
};

// Callers own titles, kinds and initial descriptions. Node ids, desc ids and
// statuses stay harness-owned, so any other field is rejected.
const ADD_ITEM_FIELDS = new Set(["kind", "title", "desc", "items"]);

const ACTION_FIELDS = new Map([
  ["add", ["attach", "items"]],
  ["focus", ["id"]],
  ["desc.add", ["nodeId", "content"]],
  ["desc.delete", ["nodeId", "entryId"]],
  ["desc.query", ["nodeId", "query"]],
  ["show", ["id", "depth", "full"]],
]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value, where) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} must be a non-empty string`);
  }
  return value.trim();
}

function checkFields(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${where}: unsupported field "${key}"`);
    }
  }
}

function itemNumber(numberPrefix, index) {
  return numberPrefix === "" ? String(index) : `${numberPrefix}.${index}`;
}

// New nodes start pending with a node-local desc id sequence; ids stay stable
// for the lifetime of the node and are never reused.
function planDesc(desc, where) {
  if (desc === undefined) return [];
  if (!Array.isArray(desc)) {
    throw new Error(`${where} must be an array of strings`);
  }
  return desc.map((content, index) => ({
    id: index + 1,
    content: requireText(content, `${where}[${index}]`),
  }));
}

function planItem(item, where, takeNodeId) {
  if (!isPlainObject(item)) {
    throw new Error(`${where} must be an object`);
  }
  checkFields(item, ADD_ITEM_FIELDS, where);

  const kind = item.kind ?? "item";
  if (!NODE_KINDS.has(kind)) {
    throw new Error(`${where}.kind must be "item" or "branch"`);
  }
  const title = requireText(item.title, `${where}.title`);
  if (item.items !== undefined && !Array.isArray(item.items)) {
    throw new Error(`${where}.items must be an array`);
  }
  const desc = planDesc(item.desc, `${where}.desc`);

  const id = takeNodeId();
  return {
    id,
    kind,
    title,
    status: "pending",
    desc,
    nextDescId: desc.length + 1,
    children: (item.items ?? []).map((child, index) =>
      planItem(child, `${where}.items[${index}]`, takeNodeId),
    ),
  };
}

function publicDescription(entry) {
  return { id: entry.id, content: entry.content };
}

function publicNode(node) {
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    status: node.status,
    desc: node.desc.map(publicDescription),
    items: node.children.map(publicNode),
  };
}

export class Work {
  #nodes = new Map();
  #nextNodeId = 1;
  #focusId = ROOT_ID;

  constructor() {
    this.#nodes.set(ROOT_ID, {
      id: ROOT_ID,
      kind: ROOT_KIND,
      title: ROOT_TITLE,
      status: "pending",
      desc: [],
      nextDescId: 1,
      children: [],
    });
  }

  get focusId() {
    return this.#focusId;
  }

  add({ attach, items } = {}) {
    if (typeof attach !== "string" || attach === "") {
      throw new Error("attach must be a node id string");
    }
    const parent = this.#requireNode(attach, "attach");
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("items must be a non-empty array");
    }

    // The whole recursive batch is validated and planned before any counter or
    // map is touched, so a failure at any depth creates nothing.
    let nextNodeId = this.#nextNodeId;
    const takeNodeId = () => `w${nextNodeId++}`;
    const planned = items.map((item, index) =>
      planItem(item, `items[${index}]`, takeNodeId),
    );

    this.#nextNodeId = nextNodeId;
    for (const node of planned) {
      parent.children.push(node);
      this.#register(node);
    }
    return { ok: true, attach, nodes: planned.map(publicNode) };
  }

  focus({ id } = {}) {
    const node = this.#requireNode(id, "id");
    this.#focusId = node.id;
    return { ok: true, focus: node.id };
  }

  descAdd({ nodeId, content } = {}) {
    const node = this.#requireNode(nodeId, "nodeId");
    const text = requireText(content, "content");
    const entry = { id: node.nextDescId, content: text };
    node.nextDescId += 1;
    node.desc.push(entry);
    return { ok: true, nodeId: node.id, entry: publicDescription(entry) };
  }

  descDelete({ nodeId, entryId } = {}) {
    const node = this.#requireNode(nodeId, "nodeId");
    if (!Number.isInteger(entryId)) {
      throw new Error("entryId must be an integer");
    }
    const index = node.desc.findIndex((entry) => entry.id === entryId);
    if (index === -1) {
      throw new Error(`unknown desc entry ${entryId} on node ${node.id}`);
    }
    const [entry] = node.desc.splice(index, 1);
    return { ok: true, nodeId: node.id, deleted: publicDescription(entry) };
  }

  descQuery({ nodeId, query } = {}) {
    const node = this.#requireNode(nodeId, "nodeId");
    const needle =
      query === undefined || (typeof query === "string" && query.trim() === "")
        ? undefined
        : requireText(query, "query").toLowerCase();
    const entries = node.desc
      .filter(
        (entry) =>
          needle === undefined || entry.content.toLowerCase().includes(needle),
      )
      .map(publicDescription);
    return { ok: true, nodeId: node.id, entries };
  }

  show({ id, depth, full } = {}) {
    const node = this.#requireNode(id === undefined ? this.#focusId : id, "id");
    if (full !== undefined && typeof full !== "boolean") {
      throw new Error("full must be a boolean");
    }

    const lines = [ROOT_TITLE];
    if (full === true) {
      if (depth !== undefined) {
        throw new Error("depth cannot be combined with full");
      }
      this.#renderFullTarget(node, lines, { first: true });
    } else {
      const limit = depth === undefined ? DEFAULT_DEPTH : depth;
      if (!Number.isInteger(limit) || limit < 0) {
        throw new Error("depth must be a non-negative integer");
      }
      this.#renderCompactTarget(node, limit, lines);
    }
    return lines.join("\n");
  }

  dispatch(request) {
    if (!isPlainObject(request)) {
      throw new Error("request must be an object");
    }
    if (request.tool !== "work") {
      throw new Error(`unsupported tool: ${String(request.tool)}`);
    }
    const fields = ACTION_FIELDS.get(request.action);
    if (!fields) {
      throw new Error(`unsupported work action: ${String(request.action)}`);
    }
    checkFields(request, new Set(["tool", "action", ...fields]), `work.${request.action}`);

    switch (request.action) {
      case "add":
        return this.add({ attach: request.attach, items: request.items });
      case "focus":
        return this.focus({ id: request.id });
      case "desc.add":
        return this.descAdd({ nodeId: request.nodeId, content: request.content });
      case "desc.delete":
        return this.descDelete({ nodeId: request.nodeId, entryId: request.entryId });
      case "desc.query":
        return this.descQuery({ nodeId: request.nodeId, query: request.query });
      case "show":
        return this.show({ id: request.id, depth: request.depth, full: request.full });
      default:
        throw new Error(`unsupported work action: ${String(request.action)}`);
    }
  }

  #renderCompactTarget(node, depth, lines) {
    if (node.kind === ROOT_KIND) {
      this.#renderCompactSequence(node, depth, "", "", lines);
    } else if (node.kind === "branch") {
      this.#renderCompactBranch(node, depth, "", lines);
    } else {
      this.#renderCompactItem(node, depth, "", "1", lines);
    }
  }

  // Branches sit one step deeper than the items they branch off, and never
  // consume a serial number of the level they belong to.
  #renderCompactSequence(parent, depth, indent, numberPrefix, lines) {
    if (depth === 0) return;
    let itemIndex = 0;
    for (const child of parent.children) {
      if (child.kind === "branch") {
        this.#renderCompactBranch(child, depth - 1, `${indent}   `, lines);
        continue;
      }
      itemIndex += 1;
      this.#renderCompactItem(child, depth - 1, indent, itemNumber(numberPrefix, itemIndex), lines);
    }
  }

  #renderCompactItem(node, depth, indent, number, lines) {
    lines.push(this.#itemLine(node, indent, number));
    this.#renderCompactSequence(node, depth, `${indent}   `, number, lines);
  }

  #renderCompactBranch(node, depth, indent, lines) {
    lines.push(this.#branchLine(node, indent));
    this.#renderCompactSequence(node, depth, `${indent}   `, "", lines);
  }

  #renderFullTarget(node, lines, state) {
    if (node.kind === ROOT_KIND) {
      this.#renderFullSequence(node, "", "", lines, state);
    } else if (node.kind === "branch") {
      this.#renderFullBranch(node, "", lines, state);
    } else {
      this.#renderFullItem(node, "", "1", lines, state);
    }
  }

  #renderFullSequence(parent, indent, numberPrefix, lines, state) {
    let itemIndex = 0;
    for (const child of parent.children) {
      if (child.kind === "branch") {
        this.#renderFullBranch(child, `${indent}   `, lines, state);
        continue;
      }
      itemIndex += 1;
      this.#renderFullItem(child, indent, itemNumber(numberPrefix, itemIndex), lines, state);
    }
  }

  #renderFullItem(node, indent, number, lines, state) {
    this.#startFullNode(lines, state);
    lines.push(this.#itemLine(node, indent, number));
    this.#renderDescBlock(node, indent, lines);
    this.#renderFullSequence(node, `${indent}   `, number, lines, state);
  }

  #renderFullBranch(node, indent, lines, state) {
    this.#startFullNode(lines, state);
    lines.push(this.#branchLine(node, indent));
    this.#renderDescBlock(node, indent, lines);
    this.#renderFullSequence(node, `${indent}   `, "", lines, state);
  }

  // The full view separates node blocks with one blank line: the header is
  // never followed by a blank line and the output never ends with one.
  #startFullNode(lines, state) {
    if (!state.first) lines.push("");
    state.first = false;
  }

  #renderDescBlock(node, indent, lines) {
    if (node.desc.length === 0) return;
    lines.push(`${indent}   desc:`);
    for (const entry of node.desc) {
      lines.push(`${indent}     [${entry.id}] ${entry.content}`);
    }
  }

  #itemLine(node, indent, number) {
    return `${indent}${number}. ${STATUS_MARKERS[node.status]} ${node.title}  #${node.id}${this.#focusSuffix(node)}`;
  }

  #branchLine(node, indent) {
    const status = node.status === "pending" ? "" : `  ${STATUS_MARKERS[node.status]}`;
    return `${indent}↳ BRANCH ${node.title}  #${node.id}${status}${this.#focusSuffix(node)}`;
  }

  #focusSuffix(node) {
    return node.id === this.#focusId ? "  ← focus" : "";
  }

  #register(node) {
    this.#nodes.set(node.id, node);
    for (const child of node.children) {
      this.#register(child);
    }
  }

  #requireNode(id, field) {
    const node = typeof id === "string" ? this.#nodes.get(id) : undefined;
    if (!node) {
      throw new Error(`${field} does not reference an existing node: ${String(id)}`);
    }
    return node;
  }
}

export function createWork() {
  return new Work();
}

export function createWorkDispatcher(work = createWork()) {
  return {
    work,
    dispatch(request) {
      return work.dispatch(request);
    },
  };
}
