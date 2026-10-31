import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { initTheme, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import type { ScenarioFixture, FixtureToolResult } from './subagent-sdk-fixture.ts';

/** Exercise Pi's real interactive component with the harness renderers. */
export function capabilityGuiText(fixture: ScenarioFixture, result: FixtureToolResult): string {
  initTheme('dark');
  const definition = fixture.session.extensionRunner.resolveToolRenderers('capability', () => fixture.session.getToolDefinition('capability'));
  assert.ok(definition);
  assert.equal(typeof definition.renderResult, 'function', 'Harness folds visible content without rendering internal details');
  // Rendering needs only requestRender; no terminal is started in this fixture.
  const ui = { requestRender() {} } as TUI;
  const component = new ToolExecutionComponent('capability', 'gui-review', {}, { showImages: false }, definition, ui, fixture.cwd);
  component.updateResult({ content: [...result.content], details: result.details, isError: result.isError === true });
  component.setExpanded(true);
  const rendered = component.render(4096).map(stripVTControlCharacters).join('\n');
  assert.doesNotMatch(rendered, /"match":|"score":|"warnings":/);
  return rendered;
}
