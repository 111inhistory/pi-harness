import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { discoverSessionSkills } from "../src/capability-skills.mjs";
import { createCapabilityBroker } from "../src/capability-broker.mjs";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-capability-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd: path.join(root, "workspace"), agentDir: path.join(root, "agent") };
}
async function skill(filePath, name, extra = "") {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `---\nname: ${name}\ndescription: PPT presentation workflow\n${extra}---\n# Reusable PPT guidance\n`);
}
const command = (name, filePath) => ({ name: `skill:${name}`, source: "skill", sourceInfo: { path: filePath, source: "git:https://example.test/ppt", scope: "user", origin: "package" } });

test("loaded package/temporary Skills are searchable without scanning other configured resources", async (t) => {
  const { root, cwd, agentDir } = await workspace(t);
  const packageSkill = path.join(root, "installed-package", "guidance", "ppt.md");
  const temporarySkill = path.join(root, "cli", "ppt.md");
  const privateSkill = path.join(root, "installed-package", "guidance", "private.md");
  await skill(packageSkill, "ppt-master");
  await skill(temporarySkill, "ppt-template");
  await skill(privateSkill, "private-ppt", "disable-model-invocation: true\n");
  await skill(path.join(agentDir, "skills", "not-loaded", "SKILL.md"), "excluded-ppt");
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ skills: ["-skills/not-loaded"] }));
  const selected = [command("ppt-master", packageSkill), command("ppt-template", temporarySkill), command("private-ppt", privateSkill)];
  const loaded = await discoverSessionSkills({ getCommands: () => [...selected, selected[0], { source: "extension", name: "unrelated" }] }, { cwd, agentDir });
  assert.deepEqual(loaded.skills.map((entry) => entry.name), ["ppt-master", "ppt-template", "private-ppt"]);
  assert.deepEqual(loaded.skills[0].sourceInfo, selected[0].sourceInfo);
  assert.deepEqual(loaded.diagnostics, []);
  const broker = createCapabilityBroker({ listTools: () => [], discoverSkills: () => loaded });
  const hits = await broker.search({ query: "ppt", src: "local", cwd });
  assert.deepEqual(hits.skills.map((entry) => entry.name).sort(), ["ppt-master", "ppt-template"]);
  const selectedPath = hits.skills.find((entry) => entry.name === "ppt-master").filePath;
  assert.equal(selectedPath, packageSkill);
  const text = await readFile(selectedPath, "utf8");
  assert.match(text, /Reusable PPT guidance/);
});

test("native package-object whitelist, blacklist and empty selection cannot be bypassed by loaded commands", async (t) => {
  const { root, cwd, agentDir } = await workspace(t);
  const repo = path.join(root, "installed-package");
  const debug = path.join(repo, "skills", "hai-debug", "SKILL.md");
  const architecture = path.join(repo, "skills", "hai-architecture", "SKILL.md");
  await skill(debug, "hai-debug");
  await skill(architecture, "hai-architecture");
  await mkdir(agentDir, { recursive: true });
  const discover = async (selection) => {
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [{ source: repo, skills: selection }] }));
    return discoverSessionSkills({ getCommands: () => [command("hai-debug", debug), command("hai-architecture", architecture)] }, { cwd, agentDir });
  };
  assert.deepEqual((await discover(["skills/hai-debug/**"])).skills.map((entry) => entry.name), ["hai-debug"]);
  assert.deepEqual((await discover(["!skills/hai-debug/**"])).skills.map((entry) => entry.name), ["hai-architecture"]);
  assert.deepEqual((await discover([])).skills, []);
});

test("configured resource filters apply with an empty command inventory; missing paths are reported", async (t) => {
  const { cwd, agentDir } = await workspace(t);
  await skill(path.join(agentDir, "skills", "unselected", "SKILL.md"), "unselected-ppt");
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ skills: ["-skills/unselected"] }));
  assert.deepEqual((await discoverSessionSkills({ getCommands: () => [] }, { cwd, agentDir })).skills, []);
  const loaded = await discoverSessionSkills({ getCommands: () => [{ name: "skill:broken", source: "skill" }, command("missing", path.join(cwd, "missing.md"))] }, { cwd, agentDir });
  assert.deepEqual(loaded.skills, []);
  assert.ok(loaded.diagnostics.some((entry) => /no source path/.test(entry.message)));
  assert.ok(loaded.diagnostics.some((entry) => /does not exist/.test(entry.message)));
});
