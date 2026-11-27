type Decision = boolean | undefined;

const MAX_COMMAND_CHARS = 8192;
const MAX_WORDS = 512;
const MAX_SEGMENTS = 64;
const VARIABLE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const RESERVED = new Set(['!', 'if', 'then', 'else', 'elif', 'fi', 'for', 'select', 'while', 'until', 'do', 'done', 'case', 'esac', 'function', 'time', 'coproc']);

interface Word { readonly text: string; readonly bare: boolean; readonly dynamic: boolean; readonly assignment: boolean }
interface Segment { readonly verb?: string; readonly uncertain?: true }

/** Recognize a bounded subset of literal POSIX simple commands for Hook matching. */
function segments(command: string): readonly Segment[] | undefined {
  if (command.length > MAX_COMMAND_CHARS) return undefined;
  const result: Segment[] = [];
  let quote: "'" | '"' | undefined;
  let word: Word | undefined;
  let verb: string | undefined;
  let uncertain = false;
  let redirect = false;
  let words = 0;
  let afterOperator = false;
  let segmentStarted = false;

  const append = (char: string, bare: boolean, dynamic = false): void => {
    const assignment = word?.assignment === true || (char === '=' && bare && word?.bare === true && VARIABLE.test(word.text));
    word = { text: (word?.text ?? '') + char, bare: (word?.bare ?? true) && bare, dynamic: (word?.dynamic ?? false) || dynamic, assignment };
  };
  const finishWord = (): void => {
    if (word === undefined) return;
    segmentStarted = true;
    words += 1;
    if (redirect) redirect = false;
    else if (verb === undefined && !word.assignment) {
      verb = word.text;
      if (word.dynamic || (word.bare && RESERVED.has(verb))) uncertain = true;
    }
    word = undefined;
    afterOperator = false;
  };
  const finishSegment = (): boolean => {
    finishWord();
    if (redirect || afterOperator) return false;
    if (segmentStarted) result.push({ ...(verb === undefined ? {} : { verb }), ...(uncertain ? { uncertain: true } : {}) });
    segmentStarted = false;
    verb = undefined;
    uncertain = false;
    return result.length <= MAX_SEGMENTS;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];
    if (quote === "'") {
      if (char === quote) quote = undefined;
      else append(char, false);
      continue;
    }
    if (char === '\\' && quote === '"' && next !== undefined && !'"\\$`\n'.includes(next)) {
      append(char, false);
      continue;
    }
    if (char === '\\') {
      if (next === undefined) return undefined;
      index += 1;
      if (next !== '\n') append(next, false);
      continue;
    }
    // Commands inside compound syntax are intentionally not inspected.
    if (char === '`' || (char === '$' && (next === '(' || next === '{'))) return undefined;
    if (quote === '"') {
      if (char === quote) quote = undefined;
      else append(char, false, char === '$');
      continue;
    }
    if (char === "'" || char === '"') { quote = char; append('', false); continue; }
    if (char === '#' && word === undefined) {
      const end = command.indexOf('\n', index);
      if (end < 0) break;
      index = end - 1;
      continue;
    }
    if ('(){}'.includes(char) || (char === '&' && next !== '&') || (char === '<' && next === '<') || (char === '|' && next === '&')) return undefined;
    if (char === '<' || char === '>') {
      if (word !== undefined && word.bare && /^\d+$/.test(word.text)) word = undefined;
      finishWord();
      if (redirect || next === '&' || next === '|') return undefined;
      if (char === '>' && next === '>') index += 1;
      redirect = true;
    } else if ('|&;\n'.includes(char)) {
      if (char === '\n' && afterOperator) continue;
      finishWord();
      if (char !== '\n' && !segmentStarted) return undefined;
      if (!finishSegment()) return undefined;
      if ((char === '|' || char === '&') && next === char) index += 1;
      afterOperator = char === '|' || char === '&';
    } else if (/\s/.test(char)) {
      finishWord();
    } else {
      append(char, true, '$*?[]~'.includes(char));
    }
    if (words > MAX_WORDS) return undefined;
  }
  return quote === undefined && finishSegment() && words <= MAX_WORDS ? result : undefined;
}

export function shellCommandMatches(command: string, verbs: ReadonlySet<string>, standalone: boolean): Decision {
  const parsed = segments(command);
  if (parsed === undefined) return undefined;
  // A trailing semicolon ends a simple command; multiple segments do not qualify.
  if (standalone && parsed.length > 1) return false;
  let unknown = false;
  for (const segment of parsed) {
    if (segment.uncertain) unknown = true;
    else if (segment.verb !== undefined && (verbs.has(segment.verb)
        || (segment.verb.startsWith('/') && verbs.has(segment.verb.slice(segment.verb.lastIndexOf('/') + 1))))) return true;
  }
  return unknown ? undefined : false;
}
