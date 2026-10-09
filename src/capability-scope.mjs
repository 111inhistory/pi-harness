// Capability eligibility is separate from registration and activation.
// Parent availability is append-only; role denials always win.
const scopes = new WeakMap();

function scope(pi) {
  let value = scopes.get(pi);
  if (!value) {
    value = { parent: null, available: new Set(), denied: new Set() };
    scopes.set(pi, value);
  }
  return value;
}

export function setCapabilityParent(pi, parent, denied = []) {
  const value = scope(pi);
  value.parent = parent;
  value.denied = new Set(denied);
}

export function capabilityAvailableTools(pi) {
  const value = scope(pi);
  const parentPi = typeof value.parent === 'function' ? value.parent() : value.parent;
  const parent = parentPi ? capabilityAvailableTools(parentPi) : null;
  if (parent) {
    for (const name of parent) if (!value.denied.has(name)) value.available.add(name);
  }
  for (const tool of pi.getAllTools()) {
    if (tool.exposure === 'hidden' || value.denied.has(tool.name) || (parent && !parent.has(tool.name))) continue;
    value.available.add(tool.name);
  }
  return value.available;
}

export function capabilityAllowsTool(pi, name) {
  const value = scope(pi);
  if (value.denied.has(name)) return false;
  const parent = typeof value.parent === 'function' ? value.parent() : value.parent;
  return !parent || capabilityAvailableTools(parent).has(name);
}
