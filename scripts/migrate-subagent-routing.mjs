#!/usr/bin/env -S node --import tsx
/** Offline conversion: node --import tsx scripts/migrate-subagent-routing.mjs INPUT OUTPUT */
import { readFile, writeFile } from 'node:fs/promises';
import { validateRoutingConfig } from '../src/subagent/routing.ts';

const [input, output, ...extra] = process.argv.slice(2);
if (!input || !output || extra.length) throw new Error(
  'Usage: node --import tsx scripts/migrate-subagent-routing.mjs INPUT OUTPUT (OUTPUT must not exist)');
const old = JSON.parse(await readFile(input, 'utf8'));
if (old.version !== 2 || !Array.isArray(old.roles) || !Array.isArray(old.models)) {
  throw new Error('INPUT must be a version 2 routing configuration.');
}
const models = new Map(old.models.map(model => [model.id, model]));
const roles = old.roles.map(role => {
  if (!Array.isArray(role.excludeTools) || !Array.isArray(role.candidates)
      || (role.enableTools !== undefined && !Array.isArray(role.enableTools))) {
    throw new Error(`Role ${role.id} has malformed tools or candidates.`);
  }
  const candidates = Object.create(null);
  for (const candidate of role.candidates) {
    const model = models.get(candidate.model);
    if (!model || Object.hasOwn(candidates, candidate.model)) {
      throw new Error(`Role ${role.id} has an unknown or duplicate model ${candidate.model}.`);
    }
    candidates[candidate.model] = {
      description: model.preference,
      model: { provider: model.provider, id: model.model },
      thinkingLevel: candidate.thinking,
      tools: [
        ...(role.enableTools ?? []).map(name => `+${name}`),
        ...role.excludeTools.map(name => `-${name}`),
      ],
    };
  }
  return { id: role.id, instructions: role.instructions, candidates };
});
const converted = validateRoutingConfig({ version: 3, classifier: old.classifier, instructions: old.instructions, roles });
// Explicit offline output never overwrites the user's current or destination file.
await writeFile(output, `${JSON.stringify(converted, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`Wrote version 3 routing configuration to ${output}`);
