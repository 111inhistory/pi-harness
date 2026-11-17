import test from 'node:test';
import { runModelSubprocess } from '../../test-support/pbt.ts';

test('generated capability histories preserve base/dynamic membership, blacklist and declaration timing', { timeout: 150000 }, async t => {
  await runModelSubprocess(t, new URL('../../test-support/capability-history-model.ts', import.meta.url), 'CAPABILITY_HISTORY_MODEL_OK');
});
