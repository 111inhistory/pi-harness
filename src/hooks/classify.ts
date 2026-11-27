import type { ClassifierQuestion } from '@earendil-works/pi-ai';
import type { HookClassification, HookRule, HookAction } from './config.ts';

export const HOOK_QUESTION = 'hook';

export function hookQuestion(rule: HookClassification): ClassifierQuestion {
  const instructions = rule.question;
  switch (rule.kind) {
    case 'bool': return { type: 'bool', instructions, criteria: { true: 'The condition holds.', false: 'The condition does not hold.' } };
    case 'score': return { type: 'score', instructions, criteria: ['Estimate how strongly the condition holds, from 0 to 1.'] };
    case 'choice': return { type: 'choice', instructions, criteria: Object.fromEntries(rule.choices.map(choice => [choice, choice])) };
  }
}

const NO_ACTIONS: readonly HookAction[] = [];

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function unit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Undefined means a malformed answer. A valid negative or observation-only answer has no actions. */
export function classifiedActions(rule: HookRule, answers: unknown): readonly HookAction[] | undefined {
  const classifier = rule.classify;
  const answer = record(record(answers)?.[HOOK_QUESTION]);
  if (classifier === undefined || answer?.type !== classifier.kind) return undefined;
  if (classifier.kind === 'bool') {
    return unit(answer.probability) ? answer.probability > 0.5 ? rule.actions : NO_ACTIONS : undefined;
  }
  if (classifier.kind === 'score') {
    if (!unit(answer.score) || !unit(answer.confidence)) return undefined;
    return answer.score >= classifier.minScore ? rule.actions : NO_ACTIONS;
  }
  if (!unit(answer.confidence) || typeof answer.choice !== 'string' || !classifier.choices.includes(answer.choice)) return undefined;
  const probabilities = record(answer.probabilities);
  if (!probabilities || Object.keys(probabilities).length !== classifier.choices.length) return undefined;
  let peak = 0;
  let winner: string | undefined;
  for (const choice of classifier.choices) {
    const probability = Object.hasOwn(probabilities, choice) ? probabilities[choice] : undefined;
    if (!unit(probability)) return undefined;
    if (probability > peak) {
      peak = probability;
      winner = choice;
    }
  }
  if (winner === undefined || winner !== answer.choice) return undefined;
  return rule.onChoice?.[winner] ?? NO_ACTIONS;
}

export function canClassifyForBranch(rule: HookRule): boolean {
  const canApply = (action: HookAction) => action.type === 'activate' || action.type === 'discoverCapability';
  return rule.actions.some(canApply) || Object.values(rule.onChoice ?? {}).some(actions => actions.some(canApply));
}
