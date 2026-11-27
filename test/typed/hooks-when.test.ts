import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { compileWhen, evaluateWhen, type WhenContext } from '../../src/hooks/when.ts';

const cwd = path.resolve('workspace');
function result(source: string, context: Partial<WhenContext> = {}) {
  return evaluateWhen(compileWhen(source, 'tool_result'), { cwd, ...context });
}

test('when validates event fields and operand types before matching', () => {
  assert.throws(() => compileWhen('tool == "bash"', 'before_agent_start'), /unavailable/);
  assert.throws(() => compileWhen('contains(prompt, "task")', 'tool_result'), /unavailable/);
  assert.throws(() => compileWhen('turn.byTool == 1', 'tool_result'), /unavailable/);
  assert.throws(() => compileWhen('result.outputChars == "10"', 'tool_result'), /incompatible/);
  assert.throws(() => compileWhen('exists(input.a.b.c.d.e)', 'tool_result'), /unavailable/);
  assert.throws(() => compileWhen('shellStandalone(input.command, input.verbs)', 'tool_result'), /invalid arguments/);
  assert.throws(() => compileWhen('regex(result.output, "\\d+")', 'tool_result'), /when string literal/);
  assert.throws(() => compileWhen('!'.repeat(25) + 'true', 'tool_result'), /too deep/);
  assert.throws(() => compileWhen(Array.from({ length: 130 }, () => 'true').join(' && '), 'tool_result'), /too many tokens/);
  const before = compileWhen('contains(prompt, "task") && model.id in ["example", "other"]', 'before_agent_start');
  assert.equal(evaluateWhen(before, { cwd, prompt: 'example task', model: { provider: 'fake', id: 'example' } }), 'true');
});

test('when keeps unknown distinct from false and never follows prototypes, getters or arrays', () => {
  assert.equal(result('!result.truncated'), 'unknown');
  assert.equal(result('result.truncated != true', { result: { truncated: false } }), 'true');
  assert.equal(result('!result.truncated && false'), 'false');
  assert.equal(result('!result.truncated || true'), 'true');
  assert.equal(result('input.value >= 2 && !exists(input.missing)', { input: { value: 3 } }), 'true');
  assert.equal(result('input.value >= 2', { input: { value: '3' } }), 'unknown');
  assert.equal(result('exists(input.present)', { input: { present: null } }), 'true');
  assert.equal(result('!exists(input.unobserved)'), 'unknown');
  assert.equal(result('exists(input.a.value)', { input: { a: Object.create({ value: true }) } }), 'false');
  assert.equal(result('exists(input.a.length)', { input: { a: [] } }), 'false');
  assert.equal(result('exists(input.value)', { input: { get value() { throw new Error('getter must not execute'); } } }), 'false');
});

test('when bounds regular expressions and checks workspace paths lexically', () => {
  assert.equal(result("regex(result.output, '^WARN\\d+', 'im')", { result: { output: 'ok\nwarn12' } }), 'true');
  assert.equal(result('regex(result.output, "abc")', { result: { output: 'a'.repeat(8193) } }), 'unknown');
  assert.throws(() => compileWhen("regex(result.output, '(x)\\1')", 'tool_result'));
  assert.throws(() => compileWhen("regex(result.output, 'x{1000}')", 'tool_result'), /counted/);
  assert.equal(result('inWorkspace(input.path)', { input: { path: './sub/file' } }), 'true');
  assert.equal(result('inWorkspace(input.path)', { input: { path: `../${path.basename(cwd)}-outside/file` } }), 'false');
});

test('Shell predicates distinguish standalone verbs, literal text, and pipeline segments', () => {
  const standalone = 'shellStandalone(input.command, ["head", "sed"])';
  const any = 'shellHasCommand(input.command, ["head", "sed"])';
  const evaluate = (source: string, command: string) => result(source, { shell: 'posix', input: { command } });
  assert.equal(evaluate(standalone, 'LANG="C" /usr/bin/head -n 5 < input.txt'), 'true');
  assert.equal(evaluate(standalone, 'git diff | head -n 50'), 'false');
  assert.equal(evaluate(any, 'git diff | head -n 50'), 'true');
  assert.equal(evaluate(standalone, 'head -n 3 | > capture'), 'false');
  assert.equal(evaluate(any, 'echo "head | sed"'), 'false');
  assert.equal(evaluate(any, 'echo $value | "$dynamic"'), 'unknown');
  assert.equal(evaluate(any, 'echo $value | head -n 1'), 'true');
  assert.equal(evaluate(any, 'echo "$(head x)"'), 'unknown');
  assert.equal(evaluate(any, 'echo "missing quote'), 'unknown');
  for (const command of ['head a.txt;;', 'head a.txt; ; echo b', 'head a.txt; | cat', 'head a.txt; && cat']) {
    assert.equal(evaluate(any, command), 'unknown', command);
  }
  assert.equal(evaluate(standalone, './scripts/head a.txt'), 'false');
  assert.equal(evaluate(standalone, 'scripts/head a.txt'), 'false');
  assert.equal(result(standalone, { input: { command: 'head -n 1' } }), 'unknown');
});
