import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entries = ['result-rendering', 'subagent', 'capability', 'btw', 'preset'];

for (const registration of ['extensions', 'package'] as const) {
test(`separate plugins load through Pi's ${registration} registration without a TypeScript preload`, async t => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), 'pi-native-loader-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const paths = entries.map(name => fileURLToPath(new URL(`../../extensions/${name}.ts`, import.meta.url)));
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
  const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: '1' };
  delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, [
    '--input-type=module', '-e', `
      const { DefaultResourceLoader, SettingsManager } = await import(process.argv[1]);
      const packageMode = process.argv[3] === 'package';
      const loader = new DefaultResourceLoader({
        cwd: process.cwd(), agentDir: process.argv[2],
        settingsManager: SettingsManager.inMemory({
          packages: packageMode ? [process.argv[4]] : [], extensions: [],
        }),
        noExtensions: !packageMode, additionalExtensionPaths: packageMode ? [] : process.argv.slice(5),
        noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      });
      await loader.reload();
      const result = loader.getExtensions();
      if (result.errors.length) {
        console.error(JSON.stringify(result.errors));
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify(result.extensions.map(extension => ({
          path: extension.resolvedPath,
          tools: [...extension.tools.keys()],
          commands: [...extension.commands.keys()],
        }))));
      }
    `, sdk, agentDir, registration, packageRoot, ...paths,
  ], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const loaded = JSON.parse(child.stdout) as { path: string; tools: string[]; commands: string[] }[];
  assert.equal(loaded.length, entries.length);
  const byName = new Map(loaded.map(entry => [path.basename(entry.path, '.ts'), entry]));
  assert.ok(byName.get('subagent')?.tools.includes('msg_write'));
  assert.ok(byName.get('subagent')?.commands.includes('subagent'));
  assert.ok(byName.get('capability')?.tools.includes('capability'));
  assert.ok(byName.get('capability')?.commands.includes('mcp'));
  assert.deepEqual(byName.get('btw')?.tools, []);
  assert.deepEqual(byName.get('btw')?.commands, ['btw']);
  assert.deepEqual(byName.get('preset')?.tools, []);
  assert.ok(byName.get('preset')?.commands.includes('preset'));
  assert.deepEqual(byName.get('result-rendering')?.tools, []);
});
}
