import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';

// A real child process exercises the exit hook without retaining files in this test process.
test('temporary result directories remain readable until process exit, then are removed', () => {
  const moduleUrl = new URL('../../src/subagent/temporary-results.ts', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { temporaryResultDirectory } from ${JSON.stringify(moduleUrl)};
    import { writeFileSync, readFileSync } from 'node:fs';
    import path from 'node:path';
    const directory = temporaryResultDirectory();
    const file = path.join(directory, 'result.txt');
    writeFileSync(file, 'DELIVERED_RESULT');
    process.stdout.write(JSON.stringify({ directory, content: readFileSync(file, 'utf8') }));
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const observed: { directory: string; content: string } = JSON.parse(result.stdout);
  assert.equal(observed.content, 'DELIVERED_RESULT');
  assert.equal(existsSync(observed.directory), false);
});
