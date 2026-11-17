import { getMarkdownTheme, type Theme } from '@earendil-works/pi-coding-agent';
import {
  Markdown,
  replaceControlCharacters,
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
} from '@earendil-works/pi-tui';

export type BtwTurnState = 'streaming' | 'complete' | 'error' | 'cancelling' | 'cancelled';

interface BtwTurn {
  readonly question: string;
  answer: string;
  state: BtwTurnState;
  error?: string;
  markdown: Markdown;
  markdownText: string;
}

const QUESTION_PREFIX = 'You: ';
const ANSWER_INDENT = '  ';
/** The dock alternates between two adjacent widths; keep a small margin above that. */
const TRANSCRIPT_LAYOUT_WIDTHS = 3;

function errorMessage(error: unknown): string {
  if (error === undefined) return 'side question failed';
  const raw = error instanceof Error ? error.message : String(error);
  const message = replaceControlCharacters(raw).trim();
  return message || 'side question failed';
}

/**
 * The `/btw` answer document.
 *
 * Turns are appended and mutated by the panel; this component only turns them
 * into wrapped lines. Wrapping is cached per width and revision so streaming
 * updates re-render once per change instead of once per frame.
 *
 * The dock asks for two widths on a frame that overflows (`width` to detect the
 * overflow, `width - 1` to draw the scrollbar), so the cache keeps the few most
 * recent widths. A single-width cache would evict one form with the other and
 * reflow every turn twice on every unchanged frame.
 */
export class BtwTranscript implements Component {
  private readonly theme: Theme;
  private readonly turns: BtwTurn[] = [];
  private markdownTheme: MarkdownTheme;
  private revision = 0;
  private readonly layouts = new Map<number, { readonly revision: number; readonly lines: string[] }>();

  constructor(theme: Theme) {
    this.theme = theme;
    this.markdownTheme = getMarkdownTheme();
  }

  get turnCount(): number {
    return this.turns.length;
  }

  /** Append a streaming turn and return its index for later updates. */
  begin(question: string): number {
    this.turns.push({
      question,
      answer: '',
      state: 'streaming',
      markdown: new Markdown('', 0, 0, this.markdownTheme),
      markdownText: '',
    });
    this.touch();
    return this.turns.length - 1;
  }

  setAnswer(index: number, text: string): void {
    const turn = this.turns[index];
    if (!turn) return;
    turn.answer = text;
    this.touch();
  }

  state(index: number): BtwTurnState | undefined {
    return this.turns[index]?.state;
  }

  /** Settle a turn that finished on its own. */
  settle(index: number, state: 'complete' | 'error', error?: unknown): void {
    const turn = this.turns[index];
    if (!turn) return;
    turn.state = state;
    if (state === 'error') turn.error = errorMessage(error);
    else delete turn.error;
    this.touch();
  }

  /** Move a turn to a state owned by the caller's cancellation fence. */
  setState(index: number, state: 'cancelling' | 'cancelled', error?: unknown): void {
    const turn = this.turns[index];
    if (!turn) return;
    turn.state = state;
    if (state === 'cancelled') delete turn.error;
    else if (error !== undefined) turn.error = errorMessage(error);
    this.touch();
  }

  invalidate(): void {
    this.layouts.clear();
    this.markdownTheme = getMarkdownTheme();
    for (const turn of this.turns) {
      turn.markdown = new Markdown(turn.answer, 0, 0, this.markdownTheme);
      turn.markdownText = turn.answer;
    }
  }

  render(width: number): string[] {
    if (!Number.isFinite(width) || width < 1) return [];
    const available = Math.max(1, Math.floor(width));
    const cached = this.layouts.get(available);
    if (cached && cached.revision === this.revision) return cached.lines;
    const lines = this.build(available);
    // Bounded: the dock only ever alternates between two adjacent widths.
    this.layouts.delete(available);
    this.layouts.set(available, { revision: this.revision, lines });
    while (this.layouts.size > TRANSCRIPT_LAYOUT_WIDTHS) {
      const oldest = this.layouts.keys().next();
      if (oldest.done) break;
      this.layouts.delete(oldest.value);
    }
    return lines;
  }

  private touch(): void {
    this.revision++;
  }

  private build(width: number): string[] {
    if (this.turns.length === 0) {
      return [this.theme.fg('muted', 'Ask a side question. The main conversation is not modified.')];
    }

    const lines: string[] = [];
    for (const turn of this.turns) {
      if (lines.length > 0) lines.push('');
      lines.push(...this.questionLines(turn.question, width));
      lines.push(...this.answerLines(turn, width));
    }
    return lines;
  }

  private questionLines(question: string, width: number): string[] {
    const prefix = this.theme.fg('accent', QUESTION_PREFIX);
    const prefixWidth = visibleWidth(prefix);
    const bodyWidth = Math.max(1, width - prefixWidth);
    const body = wrapTextWithAnsi(stripTerminalSequences(question), bodyWidth);
    if (body.length === 0) body.push('');
    const lines = [prefix + body[0]];
    for (let index = 1; index < body.length; index++) {
      lines.push(' '.repeat(prefixWidth) + (body[index] ?? ''));
    }
    return lines;
  }

  private answerLines(turn: BtwTurn, width: number): string[] {
    const indentWidth = visibleWidth(ANSWER_INDENT);
    const bodyWidth = Math.max(1, width - indentWidth);
    const lines: string[] = [];
    const answer = stripTerminalSequences(turn.answer);
    const hasAnswer = answer.trim().length > 0;

    if (hasAnswer) {
      if (turn.markdownText !== answer) {
        turn.markdown.setText(answer);
        turn.markdownText = answer;
      }
      lines.push(...turn.markdown.render(bodyWidth));
    } else if (turn.state === 'streaming') {
      lines.push(this.theme.fg('muted', '…'));
    } else if (turn.state === 'complete') {
      lines.push(this.theme.fg('muted', '(no answer)'));
    }

    if (turn.state === 'cancelling') {
      lines.push(this.theme.fg('muted', 'Cancelling…'));
    } else if (turn.state === 'cancelled') {
      lines.push(this.theme.fg('muted', 'Cancelled'));
    } else if (turn.state === 'error') {
      const message = turn.error ?? 'side question failed';
      lines.push(...wrapTextWithAnsi(this.theme.fg('error', `Error: ${message}`), bodyWidth));
    }

    return lines.map((line) => ANSWER_INDENT + line);
  }
}
