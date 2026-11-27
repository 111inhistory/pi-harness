import path from 'node:path';
import { RE2JS } from 're2js';
import { shellCommandMatches } from './shell.ts';

export type WhenTrigger = 'before_agent_start' | 'tool_result';
export type WhenDecision = 'true' | 'false' | 'unknown';
export interface WhenContext {
  readonly cwd: string;
  readonly shell?: 'posix';
  readonly model?: { readonly provider: string; readonly id: string };
  readonly preset?: string;
  readonly turn?: Partial<Readonly<Record<'modelCalls' | 'toolCalls' | 'nestedToolCalls' | 'toolErrors', number>>>;
  readonly prompt?: string;
  readonly tool?: string;
  readonly nested?: boolean;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly result?: {
    readonly isError?: boolean;
    readonly truncated?: boolean;
    readonly errorKind?: string;
    readonly output?: string;
    readonly outputChars?: number;
  };
}

const MAX_SOURCE = 4096;
const MAX_TOKENS = 256;
const MAX_DEPTH = 24;
const MAX_TEXT = 8192;
const WORD = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;
const INPUT_PATH = /^input(?:\.[a-zA-Z_][a-zA-Z0-9_-]*){1,4}$/;
const TOKEN = /\s+|&&|\|\||==|!=|<=|>=|[!<>()\[\],]|"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|-?(?:0|[1-9]\d*)(?:\.\d+)?|[a-zA-Z_][a-zA-Z0-9_.-]*/gy;

type Scalar = string | number | boolean | null;
type ScalarType = 'string' | 'number' | 'boolean' | 'null';
type ValueType = ScalarType | 'dynamic' | 'list';
type Value = Scalar | readonly Scalar[] | undefined;
interface Expr {
  readonly type: ValueType;
  readonly eval: (ctx: WhenContext) => Value;
  readonly literal?: Scalar | readonly Scalar[];
  readonly field?: string;
}
export interface CompiledWhen { readonly test: (ctx: WhenContext) => WhenDecision }

const sharedFields: Readonly<Record<string, ScalarType>> = {
  'model.provider': 'string', 'model.id': 'string', preset: 'string',
  'turn.modelCalls': 'number', 'turn.toolCalls': 'number', 'turn.nestedToolCalls': 'number', 'turn.toolErrors': 'number',
};
const resultFields: Readonly<Record<string, ScalarType>> = {
  tool: 'string', nested: 'boolean', 'result.isError': 'boolean', 'result.truncated': 'boolean',
  'result.errorKind': 'string', 'result.output': 'string', 'result.outputChars': 'number',
};

function tokenize(source: string): string[] {
  if (source.length === 0 || Buffer.byteLength(source, 'utf8') > MAX_SOURCE) throw new Error('invalid when source size');
  const lexer = new RegExp(TOKEN);
  const tokens: string[] = [];
  while (lexer.lastIndex < source.length) {
    const index = lexer.lastIndex;
    const match = lexer.exec(source);
    if (!match) throw new Error(`invalid when token at offset ${index}`);
    if (match[0].trim() === '') continue;
    tokens.push(match[0]);
    if (tokens.length > MAX_TOKENS) throw new Error('when has too many tokens');
  }
  return tokens;
}

function literalOf(token: string): Scalar | undefined {
  if (token === 'true' || token === 'false') return token === 'true';
  if (token === 'null') return null;
  if (token.startsWith('"')) {
    try { return JSON.parse(token) as string; }
    catch { throw new Error('invalid escape or control character in when string literal'); }
  }
  if (token.startsWith("'")) return token.slice(1, -1).replace(/\\(['\\])/g, '$1');
  if (/^-?\d/.test(token)) {
    const value = Number(token);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function fieldValue(root: unknown, parts: readonly string[]): unknown {
  let value = root;
  for (const part of parts) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const property = Object.getOwnPropertyDescriptor(value, part);
    if (property === undefined || !Object.hasOwn(property, 'value')) return undefined;
    value = property.value;
  }
  return value;
}

function scalar(value: unknown): Scalar | undefined {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function scalarType(value: Scalar): ScalarType { return value === null ? 'null' : typeof value as ScalarType; }
function constant(value: Scalar): Expr { return { type: scalarType(value), literal: value, eval: () => value }; }
function bool(value: Value): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function text(value: Value): string | undefined { return typeof value === 'string' && value.length <= MAX_TEXT ? value : undefined; }
function booleanExpr(eval_: (ctx: WhenContext) => boolean | undefined): Expr { return { type: 'boolean', eval: eval_ }; }
function allows(expr: Expr, type: ScalarType): boolean { return expr.type === type || expr.type === 'dynamic'; }

function withinWorkspace(ctx: WhenContext, value: string): boolean | undefined {
  if (!path.isAbsolute(ctx.cwd) || value === '' || value.includes('\0')) return undefined;
  if (process.platform === 'win32' && /^[a-zA-Z]:[^\\/]/.test(value)) return undefined;
  const relative = path.relative(ctx.cwd, path.resolve(ctx.cwd, value));
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function functionCall(name: string, args: readonly Expr[]): Expr {
  const wrong = (): never => { throw new Error(`invalid arguments for ${name}()`); };
  const first = args[0];
  if (!first) return wrong();
  if (name === 'exists') {
    if (args.length !== 1 || first.field === undefined || !INPUT_PATH.test(first.field)) return wrong();
    const parts = first.field.split('.');
    return booleanExpr(ctx => {
      const input = fieldValue(ctx, ['input']);
      if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
      return fieldValue(input, parts.slice(1)) !== undefined;
    });
  }
  if (!allows(first, 'string')) return wrong();
  if (name === 'inWorkspace') {
    if (args.length !== 1) return wrong();
    return booleanExpr(ctx => {
      const value = text(first.eval(ctx));
      return value === undefined ? undefined : withinWorkspace(ctx, value);
    });
  }
  if (name === 'contains') {
    const second = args[1];
    if (args.length !== 2 || !second || !allows(second, 'string')) return wrong();
    return booleanExpr(ctx => {
      const haystack = text(first.eval(ctx));
      const needle = text(second.eval(ctx));
      return haystack === undefined || needle === undefined ? undefined : haystack.includes(needle);
    });
  }
  if (name === 'regex') {
    const pattern = args[1]?.literal;
    const flags = args.length === 2 ? '' : args[2]?.literal;
    if ((args.length !== 2 && args.length !== 3) || typeof pattern !== 'string' || typeof flags !== 'string' || !/^(?:i?m?|mi)$/.test(flags)) return wrong();
    // Reject counted expansions so even compilation has a predictable bound.
    if (pattern.length > 256 || pattern.includes('{')) throw new Error('regex pattern is too large or uses counted repetition');
    const compiled = RE2JS.compile(pattern,
      (flags.includes('i') ? RE2JS.CASE_INSENSITIVE : 0) | (flags.includes('m') ? RE2JS.MULTILINE : 0));
    return booleanExpr(ctx => {
      const value = text(first.eval(ctx));
      return value === undefined ? undefined : compiled.test(value);
    });
  }
  if (name === 'shellStandalone' || name === 'shellHasCommand') {
    const list = args[1]?.literal;
    if (args.length !== 2 || !Array.isArray(list) || list.length === 0
        || !list.every(verb => typeof verb === 'string' && /^[a-zA-Z0-9_.+-]{1,64}$/.test(verb))) return wrong();
    const verbs = new Set<string>(list);
    return booleanExpr(ctx => {
      if (ctx.shell !== 'posix') return undefined;
      const value = text(first.eval(ctx));
      return value === undefined ? undefined : shellCommandMatches(value, verbs, name === 'shellStandalone');
    });
  }
  throw new Error(`unknown when function: ${name}`);
}

function compare(left: Expr, op: string, right: Expr): Expr {
  if (op === 'in') {
    const list = right.literal;
    if (!Array.isArray(list) || left.type === 'list' || (list.length > 0 && !allows(left, scalarType(list[0]!)))) {
      throw new Error('in requires a scalar and a compatible literal list');
    }
    return booleanExpr(ctx => {
      const value = scalar(left.eval(ctx));
      if (value === undefined || (list.length > 0 && scalarType(value) !== scalarType(list[0]!))) return undefined;
      return list.includes(value);
    });
  }
  if (op === '==' || op === '!=') {
    if (left.type === 'list' || right.type === 'list'
        || (left.type !== right.type && left.type !== 'dynamic' && right.type !== 'dynamic')) throw new Error('incompatible equality operands');
    return booleanExpr(ctx => {
      const a = scalar(left.eval(ctx));
      const b = scalar(right.eval(ctx));
      if (a === undefined || b === undefined || scalarType(a) !== scalarType(b)) return undefined;
      return op === '==' ? a === b : a !== b;
    });
  }
  if (!allows(left, 'number') || !allows(right, 'number')) throw new Error('ordering comparisons require numbers');
  return booleanExpr(ctx => {
    const a = left.eval(ctx);
    const b = right.eval(ctx);
    if (typeof a !== 'number' || typeof b !== 'number') return undefined;
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
    return op === '>' ? a > b : a >= b;
  });
}

export function compileWhen(source: string, trigger: WhenTrigger): CompiledWhen {
  const tokens = tokenize(source);
  let offset = 0;
  const peek = () => tokens[offset];
  const take = (token: string): boolean => {
    if (peek() !== token) return false;
    offset += 1;
    return true;
  };
  const requireToken = (token: string): void => { if (!take(token)) throw new Error(`expected ${token} in when`); };
  const primary = (depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new Error('when expression nesting is too deep');
    if (take('(')) {
      const value = logical('||', depth + 1);
      requireToken(')');
      return value;
    }
    if (take('[')) {
      const list: Scalar[] = [];
      if (!take(']')) {
        do {
          const token = tokens[offset++];
          const value = token === undefined ? undefined : literalOf(token);
          if (value === undefined || (list.length > 0 && scalarType(value) !== scalarType(list[0]!))) {
            throw new Error('when arrays must contain literal values of one type');
          }
          list.push(value);
          if (list.length > 32) throw new Error('when list is too large');
        } while (take(','));
        requireToken(']');
      }
      return { type: 'list', literal: list, eval: () => list };
    }
    const token = tokens[offset++];
    if (token === undefined) throw new Error('expected a value in when');
    const literal = literalOf(token);
    if (literal !== undefined) return constant(literal);
    if (!WORD.test(token)) throw new Error(`unexpected ${token} in when`);
    if (take('(')) {
      const args: Expr[] = [];
      if (!take(')')) {
        do {
          args.push(logical('||', depth + 1));
          if (args.length > 3) throw new Error('too many when function arguments');
        } while (take(','));
        requireToken(')');
      }
      return functionCall(token, args);
    }
    const fields = trigger === 'tool_result' ? resultFields : { prompt: 'string' } as const;
    const type = Object.hasOwn(sharedFields, token) ? sharedFields[token]
      : Object.hasOwn(fields, token) ? (fields as Readonly<Record<string, ScalarType>>)[token]
        : trigger === 'tool_result' && INPUT_PATH.test(token) ? 'dynamic' : undefined;
    if (type === undefined) throw new Error(`when field ${token} is unavailable for ${trigger}`);
    const parts = token.split('.');
    return { type, field: token, eval: ctx => {
      const value = scalar(fieldValue(ctx, parts));
      return value !== undefined && (type === 'dynamic' || scalarType(value) === type) ? value : undefined;
    } };
  };
  const unary = (depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new Error('when expression nesting is too deep');
    if (!take('!')) return primary(depth);
    const expr = unary(depth + 1);
    if (!allows(expr, 'boolean')) throw new Error('! requires a boolean');
    return booleanExpr(ctx => {
      const value = bool(expr.eval(ctx));
      return value === undefined ? undefined : !value;
    });
  };
  const comparison = (depth: number): Expr => {
    const first = unary(depth);
    const op = peek();
    if (op === undefined || !['<', '<=', '>', '>=', '==', '!=', 'in'].includes(op)) return first;
    offset += 1;
    return compare(first, op, unary(depth));
  };
  const logical = (op: '||' | '&&', depth: number): Expr => {
    const operand = () => op === '||' ? logical('&&', depth) : comparison(depth);
    let left = operand();
    while (take(op)) {
      const first = left;
      const right = operand();
      if (!allows(first, 'boolean') || !allows(right, 'boolean')) throw new Error(`${op} requires boolean operands`);
      left = booleanExpr(ctx => {
        const a = bool(first.eval(ctx));
        const decisive = op === '||';
        if (a === decisive) return decisive;
        const b = bool(right.eval(ctx));
        return b === decisive ? decisive : a === undefined || b === undefined ? undefined : !decisive;
      });
    }
    return left;
  };
  const compiled = logical('||', 0);
  if (offset !== tokens.length) throw new Error(`unexpected ${peek()} in when`);
  if (!allows(compiled, 'boolean')) throw new Error('when must produce a boolean');
  return { test(ctx) {
    const result = bool(compiled.eval(ctx));
    return result === undefined ? 'unknown' : result ? 'true' : 'false';
  } };
}

export function evaluateWhen(compiled: CompiledWhen, context: WhenContext): WhenDecision {
  return compiled.test(context);
}
