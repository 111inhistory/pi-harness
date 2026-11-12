import test from 'node:test';
import { runModelSubprocess } from '../../test-support/pbt.ts';

test('generated native histories preserve message, Job and persistence semantics', { timeout: 150000 }, async t => {
  await runModelSubprocess(t, new URL('../../test-support/native-lifecycle-model.ts', import.meta.url), 'NATIVE_LIFECYCLE_MODEL_OK');
});
