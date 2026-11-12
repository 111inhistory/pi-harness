import test from 'node:test';
import { runModelSubprocess } from '../../test-support/pbt.ts';

test('generated parent-child histories preserve Job, delivery and topology semantics', { timeout: 150000 }, async t => {
  await runModelSubprocess(t, new URL('../../test-support/parent-coordination-model.ts', import.meta.url), 'PARENT_COORDINATION_MODEL_OK');
});
