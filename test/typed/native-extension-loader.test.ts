import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('the real Harness entrypoint loads through Pi without a TypeScript preload', async t => {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), 'pi-native-loader-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const entrypoint = fileURLToPath(new URL('../../extensions/harness.ts', import.meta.url));
  const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
  const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: '1' };
  delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, [
    '--input-type=module', '-e', `
      const { DefaultResourceLoader, SettingsManager } = await import(process.argv[1]);
      const loader = new DefaultResourceLoader({
        cwd: process.cwd(), agentDir: process.argv[2],
        settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
        noExtensions: true, additionalExtensionPaths: [process.argv[3]],
        noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      });
      await loader.reload();
      const result = loader.getExtensions();
      if (result.errors.length) {
        console.error(JSON.stringify(result.errors));
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify({
          tools: result.extensions.flatMap(extension => [...extension.tools.keys()]),
          commands: result.extensions.flatMap(extension => [...extension.commands.keys()]),
        }));
      }
    `, sdk, agentDir, entrypoint,
  ], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const loaded = JSON.parse(child.stdout) as { tools: string[]; commands: string[] };
  assert.ok(loaded.tools.includes('capability'));
  assert.ok(loaded.tools.includes('msg_write'));
  assert.ok(loaded.commands.includes('subagent'));
  assert.ok(loaded.commands.includes('capability'));
});
