import { realpathSync } from "node:fs";
import path from "node:path";
import { DefaultPackageManager, SettingsManager, loadSkills } from "@earendil-works/pi-coding-agent";

function canonical(filePath) {
  try { return realpathSync(filePath); } catch { return path.resolve(filePath); }
}

function isWithin(filePath, root) {
  const relative = path.relative(canonical(root), canonical(filePath));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/**
 * Discovery is independent of prompt exposure and the current Session loadout.
 * Use only Pi's native manifest/filter/trust rules over configured, installed
 * resources. Skip missing packages; never install/update or run extension code.
 * Loaded command metadata additionally covers temporary/extension-provided paths.
 */
export async function discoverSessionSkills(pi, { cwd, agentDir, projectTrusted = false }) {
  const settings = SettingsManager.create(cwd, agentDir);
  settings.setProjectTrusted(projectTrusted);
  const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
  const diagnostics = [];
  const resolved = await packages.resolve(async (source) => {
    diagnostics.push({ type: "warning", message: `configured package is not installed at the requested version; skipped: ${source}` });
    return "skip";
  });
  const sources = new Map();
  const denied = resolved.skills.filter((resource) => !resource.enabled).map((resource) => resource.path);
  const addSource = (filePath, sourceInfo) => {
    if (denied.some((root) => isWithin(filePath, root))) return;
    const key = canonical(filePath);
    if (!sources.has(key)) sources.set(key, { filePath, sourceInfo });
  };
  for (const resource of resolved.skills) {
    if (resource.enabled) addSource(resource.path, { path: resource.path, ...resource.metadata });
  }
  const installedRoots = packages.listConfiguredPackages().map((pkg) => pkg.installedPath).filter(Boolean);
  for (const command of pi.getCommands().filter((command) => command.source === "skill")) {
    const filePath = command.sourceInfo?.path;
    if (typeof filePath !== "string" || !filePath.length) {
      diagnostics.push({ type: "warning", message: `loaded skill ${command.name} has no source path` });
      continue;
    }
    // Stale loaded commands must not bypass Pi's current package selection.
    if (installedRoots.some((root) => isWithin(filePath, root)) &&
        !resolved.skills.some((resource) => resource.enabled && isWithin(filePath, resource.path))) continue;
    addSource(filePath, command.sourceInfo);
  }
  const loaded = loadSkills({ cwd, agentDir, skillPaths: [...sources.values()].map((entry) => entry.filePath), includeDefaults: false });
  return {
    skills: loaded.skills.map((skill) => ({ ...skill, sourceInfo: sources.get(canonical(skill.filePath))?.sourceInfo ?? skill.sourceInfo })),
    diagnostics: [...diagnostics, ...loaded.diagnostics],
  };
}
