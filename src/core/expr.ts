/**
 * A small, error-tolerant expression parser for CSS / Sass / Less values.
 * Offsets are absolute positions in the source text.
 */
import { skipString } from './text';

export type ExprMode = 'css' | 'scss' | 'less';

export interface Arg {
  name?: string;
  value: Node;
  rest?: boolean;
}

export type Node =
  | { t: 'num'; value: number; unit: string; s: number; e: number }
  | { t: 'hex'; text: string; s: number; e: number }
  | { t: 'ident'; name: string; s: number; e: number }
  | { t: 'str'; value: string; s: number; e: number }
  | { t: 'svar'; ns?: string; name: string; s: number; e: number }
  | { t: 'lvar'; name: string; s: number; e: number }
  | { t: 'call'; ns?: string; name: string; args: Arg[]; s: number; e: number }
  | { t: 'list'; sep: ' ' | ',' | '/'; items: Node[]; bracketed: boolean; s: number; e: number }
  | { t: 'map'; entries: [Node, Node][]; s: number; e: number }
  | { t: 'bin'; op: string; l: Node; r: Node; s: number; e: number }
  | { t: 'neg'; v: Node; s: number; e: number }
  | { t: 'interp'; inner: Node; s: number; e: number }
  | { t: 'bad'; s: number; e: number };

type Tok =
  | { t: 'num'; value: number; unit: string; s: number; e: number; ws: boolean }
  | { t: 'hex'; text: string; s: number; e: number; ws: boolean }
  | { t: 'ident'; name: string; s: number; e: number; ws: boolean }
  | { t: 'fn'; ns?: string; name: string; s: number; e: number; ws: boolean }
  | { t: 'svar'; ns?: string; name: string; s: number; e: number; ws: boolean }
  | { t: 'lvar'; name: string; s: number; e: number; ws: boolean }
  | { t: 'str'; value: string; s: number; e: number; ws: boolean }
  | { t: 'interp'; is: number; ie: number; s: number; e: number; ws: boolean }
  | { t: 'p'; v: string; s: number; e: number; ws: boolean }
  | { t: 'other'; s: number; e: number; ws: boolean };

const NUM_RE = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const UNIT_RE = /%|[a-zA-Z_][a-zA-Z0-9_-]*/y;
const IDENT_RE = /-?(?:[a-zA-Z_\u0080-￿]|\\.)(?:[a-zA-Z0-9_\-\u0080-￿]|\\.)*|--(?:[a-zA-Z0-9_\-\u0080-￿]|\\.)*/y;
const NAME_RE = /[a-zA-Z0-9_\-\u0080-￿]+/y;
const HEX_RE = /[0-9a-fA-F]+/y;

const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isIdentStart = (c: string | undefined): boolean =>
  c !== undefined && (/[a-zA-Z_\u0080-￿\\]/.test(c));

function matchAt(re: RegExp, text: string, i: number): string | undefined {
  re.lastIndex = i;
  const m = re.exec(text);
  return m ? m[0] : undefined;
}

function tokenize(text: string, start: number, end: number, mode: ExprMode): Tok[] {
  const out: Tok[] = [];
  let i = start;
  let ws = false;
  const prevAllowsSign = (): boolean => {
    const p = out[out.length - 1];
    if (!p) return true;
    if (ws) return true;
    return p.t === 'p' && p.v !== ')' && p.v !== ']';
  };
  while (i < end) {
    const c = text[i]!;
    if (isSpace(c)) {
      ws = true;
      i++;
      continue;
    }
    const s = i;
    const push = (tok: Tok): void => {
      out.push(tok);
      ws = false;
    };
    if (c === '"' || c === "'") {
      i = Math.min(skipString(text, i), end);
      push({ t: 'str', value: text.slice(s + 1, text[i - 1] === c ? i - 1 : i), s, e: i, ws });
      continue;
    }
    const n1 = text[i + 1];
    const startsNumber = isDigit(c) || (c === '.' && isDigit(n1));
    const signedNumber =
      (c === '-' || c === '+') && (isDigit(n1) || (n1 === '.' && isDigit(text[i + 2]))) && prevAllowsSign();
    if (startsNumber || signedNumber) {
      const sign = signedNumber ? (c === '-' ? -1 : 1) : 1;
      const numStart = signedNumber ? i + 1 : i;
      const digits = matchAt(NUM_RE, text, numStart)!;
      i = numStart + digits.length;
      let unit = '';
      if (i < end) {
        const u = matchAt(UNIT_RE, text, i);
        if (u && i + u.length <= end) {
          unit = u;
          i += u.length;
        }
      }
      push({ t: 'num', value: sign * parseFloat(digits), unit, s, e: i, ws });
      continue;
    }
    if (c === '#') {
      if (n1 === '{') {
        let depth = 0;
        let j = i + 1;
        for (; j < end; j++) {
          const d = text[j];
          if (d === '{') depth++;
          else if (d === '}' && --depth === 0) break;
        }
        i = Math.min(j + 1, end);
        push({ t: 'interp', is: s + 2, ie: Math.min(j, end), s, e: i, ws });
        continue;
      }
      const hex = matchAt(HEX_RE, text, i + 1) ?? '';
      const after = text[i + 1 + hex.length];
      i = i + 1 + hex.length;
      if ([3, 4, 6, 8].includes(hex.length) && !(after && /[\w-]/.test(after))) {
        push({ t: 'hex', text: '#' + hex, s, e: i, ws });
      } else {
        const rest = matchAt(NAME_RE, text, i);
        if (rest) i += rest.length;
        push({ t: 'other', s, e: i, ws });
      }
      continue;
    }
    if (c === '$' && mode === 'scss') {
      const name = matchAt(NAME_RE, text, i + 1);
      if (name) {
        i += 1 + name.length;
        push({ t: 'svar', name, s, e: i, ws });
        continue;
      }
    }
    if (c === '@' && mode === 'less') {
      const name = matchAt(NAME_RE, text, i + 1);
      if (name) {
        i += 1 + name.length;
        push({ t: 'lvar', name, s, e: i, ws });
        continue;
      }
    }
    if (isIdentStart(c) || (c === '-' && (isIdentStart(n1) || n1 === '-'))) {
      const ident = matchAt(IDENT_RE, text, i);
      if (ident) {
        i += ident.length;
        // Unquoted url(...) is opaque.
        if (ident.toLowerCase() === 'url' && text[i] === '(') {
          let j = i + 1;
          while (j < end && isSpace(text[j])) j++;
          if (text[j] !== '"' && text[j] !== "'") {
            const close = text.indexOf(')', j);
            i = close < 0 || close >= end ? end : close + 1;
            push({ t: 'other', s, e: i, ws });
            continue;
          }
        }
        if (text[i] === '(' && i < end) {
          i++;
          push({ t: 'fn', name: ident, s, e: i, ws });
          continue;
        }
        // Sass module members: ns.$var / ns.fn(
        if (mode === 'scss' && text[i] === '.' && i + 1 < end) {
          if (text[i + 1] === '$') {
            const name = matchAt(NAME_RE, text, i + 2);
            if (name) {
              i += 2 + name.length;
              push({ t: 'svar', ns: ident, name, s, e: i, ws });
              continue;
            }
          } else {
            const fname = matchAt(NAME_RE, text, i + 1);
            if (fname && text[i + 1 + fname.length] === '(') {
              i += 2 + fname.length;
              push({ t: 'fn', ns: ident, name: fname, s, e: i, ws });
              continue;
            }
          }
        }
        push({ t: 'ident', name: ident, s, e: i, ws });
        continue;
      }
    }
    if (c === '.' && text.startsWith('...', i)) {
      i += 3;
      push({ t: 'p', v: '...', s, e: i, ws });
      continue;
    }
    if ('()[],/:*+-%=<>!'.includes(c)) {
      i++;
      push({ t: 'p', v: c, s, e: i, ws });
      continue;
    }
    i++;
    push({ t: 'other', s, e: i, ws });
  }
  return out;
}

class Parser {
  private p = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly text: string,
    private readonly mode: ExprMode,
    private readonly end: number,
  ) {}

  private peek(k = 0): Tok | undefined {
    return this.toks[this.p + k];
  }
  private isP(v: string, k = 0): boolean {
    const t = this.peek(k);
    return t?.t === 'p' && t.v === v;
  }
  private atStop(): boolean {
    const t = this.peek();
    return !t || (t.t === 'p' && [',', ')', ']', '/', ':', '...'].includes(t.v));
  }

  parseTop(): Node {
    const node = this.parseComma();
    if (this.p < this.toks.length) {
      const first = this.toks[this.p]!;
      return { t: 'list', sep: ' ', items: [node, { t: 'bad', s: first.s, e: this.end }], bracketed: false, s: node.s, e: this.end };
    }
    return node;
  }

  private parseComma(): Node {
    const first = this.parseSlash();
    if (!this.isP(',')) return first;
    const items = [first];
    while (this.isP(',')) {
      this.p++;
      if (this.atStop() && !this.isP('/')) break;
      items.push(this.parseSlash());
    }
    return { t: 'list', sep: ',', items, bracketed: false, s: first.s, e: items[items.length - 1]!.e };
  }

  private parseSlash(): Node {
    const first = this.parseSpace();
    if (!this.isP('/')) return first;
    const items = [first];
    while (this.isP('/')) {
      this.p++;
      items.push(this.parseSpace());
    }
    return { t: 'list', sep: '/', items, bracketed: false, s: first.s, e: items[items.length - 1]!.e };
  }

  private parseSpace(): Node {
    const first = this.parseAdd();
    const items = [first];
    while (!this.atStop()) items.push(this.parseAdd());
    if (items.length === 1) return first;
    return { t: 'list', sep: ' ', items, bracketed: false, s: first.s, e: items[items.length - 1]!.e };
  }

  private isBinary(): boolean {
    const t = this.peek();
    if (t?.t !== 'p' || (t.v !== '+' && t.v !== '-')) return false;
    const next = this.peek(1);
    if (!next) return false;
    return t.ws === next.ws;
  }

  private parseAdd(): Node {
    let l = this.parseMul();
    while (this.mode !== 'css' && this.isBinary()) {
      const op = (this.toks[this.p++] as { v: string }).v;
      const r = this.parseMul();
      l = { t: 'bin', op, l, r, s: l.s, e: r.e };
    }
    return l;
  }

  private parseMul(): Node {
    let l = this.parseUnary();
    while (this.mode !== 'css' && (this.isP('*') || (this.isP('%') && this.peek()!.ws))) {
      const op = (this.toks[this.p++] as { v: string }).v;
      const r = this.parseUnary();
      l = { t: 'bin', op, l, r, s: l.s, e: r.e };
    }
    return l;
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (t?.t === 'p' && (t.v === '-' || t.v === '+') && this.mode !== 'css') {
      this.p++;
      const v = this.parseUnary();
      return t.v === '-' ? { t: 'neg', v, s: t.s, e: v.e } : v;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.toks[this.p++];
    if (!t) return { t: 'bad', s: this.end, e: this.end };
    switch (t.t) {
      case 'num':
        return { t: 'num', value: t.value, unit: t.unit, s: t.s, e: t.e };
      case 'hex':
        return { t: 'hex', text: t.text, s: t.s, e: t.e };
      case 'ident':
        return { t: 'ident', name: t.name, s: t.s, e: t.e };
      case 'str':
        return { t: 'str', value: t.value, s: t.s, e: t.e };
      case 'svar':
        return { t: 'svar', ns: t.ns, name: t.name, s: t.s, e: t.e };
      case 'lvar':
        return { t: 'lvar', name: t.name, s: t.s, e: t.e };
      case 'interp': {
        const inner = parseExpression(this.text, t.is, t.ie, this.mode === 'css' ? 'scss' : this.mode);
        return { t: 'interp', inner, s: t.s, e: t.e };
      }
      case 'fn': {
        const args = this.parseArgs();
        const close = this.peek();
        let e = this.end;
        if (close?.t === 'p' && close.v === ')') {
          e = close.e;
          this.p++;
        }
        return { t: 'call', ns: t.ns, name: t.name, args, s: t.s, e };
      }
      case 'p':
        if (t.v === '(') return this.parseParen(t.s);
        if (t.v === '[') {
          const inner = this.isP(']') ? undefined : this.parseComma();
          const close = this.peek();
          const e = close?.t === 'p' && close.v === ']' ? (this.p++, close.e) : this.end;
          const items = !inner ? [] : inner.t === 'list' && !inner.bracketed ? inner.items : [inner];
          const sep = inner?.t === 'list' && !inner.bracketed ? inner.sep : ' ';
          return { t: 'list', sep, items, bracketed: true, s: t.s, e };
        }
        return { t: 'bad', s: t.s, e: t.e };
      default:
        return { t: 'bad', s: t.s, e: t.e };
    }
  }

  private parseParen(s: number): Node {
    if (this.isP(')')) {
      const e = this.toks[this.p++]!.e;
      return { t: 'list', sep: ' ', items: [], bracketed: false, s, e };
    }
    const first = this.parseSlash();
    if (this.isP(':')) {
      const entries: [Node, Node][] = [];
      let key = first;
      for (;;) {
        if (!this.isP(':')) break;
        this.p++;
        const value = this.parseSlash();
        entries.push([key, value]);
        if (!this.isP(',')) break;
        this.p++;
        if (this.isP(')')) break;
        key = this.parseSlash();
      }
      const e = this.closeParen();
      return { t: 'map', entries, s, e };
    }
    let node = first;
    if (this.isP(',')) {
      const items = [first];
      while (this.isP(',')) {
        this.p++;
        if (this.isP(')')) break;
        items.push(this.parseSlash());
      }
      node = { t: 'list', sep: ',', items, bracketed: false, s: first.s, e: items[items.length - 1]!.e };
    }
    this.closeParen();
    return node;
  }

  private closeParen(): number {
    const close = this.peek();
    if (close?.t === 'p' && close.v === ')') {
      this.p++;
      return close.e;
    }
    // Unbalanced: swallow the rest so the result is marked bad.
    this.p = this.toks.length;
    return this.end;
  }

  private parseArgs(): Arg[] {
    const args: Arg[] = [];
    if (this.isP(')')) return args;
    for (;;) {
      if (!this.peek()) break;
      const t = this.peek()!;
      let name: string | undefined;
      if (t.t === 'svar' && !t.ns && this.isP(':', 1)) {
        name = t.name;
        this.p += 2;
      }
      const value = this.parseSlash();
      const arg: Arg = { value };
      if (name) arg.name = name;
      if (this.isP('...')) {
        this.p++;
        arg.rest = true;
      }
      args.push(arg);
      if (this.isP(',')) {
        this.p++;
        if (this.isP(')')) break;
        continue;
      }
      if (this.isP(')') || !this.peek()) break;
      // Unexpected token inside the call: record it and skip to the closing paren.
      const bad = this.peek()!;
      args.push({ value: { t: 'bad', s: bad.s, e: bad.e } });
      let depth = 0;
      while (this.peek()) {
        const x = this.peek()!;
        if (x.t === 'fn' || (x.t === 'p' && x.v === '(')) depth++;
        if (x.t === 'p' && x.v === ')') {
          if (depth === 0) break;
          depth--;
        }
        this.p++;
      }
      break;
    }
    return args;
  }
}

export function parseExpression(text: string, start: number, end: number, mode: ExprMode): Node {
  try {
    const toks = tokenize(text, start, end, mode);
    if (!toks.length) return { t: 'bad', s: start, e: end };
    return new Parser(toks, text, mode, end).parseTop();
  } catch {
    return { t: 'bad', s: start, e: end };
  }
}

/** True if the subtree contains a node that makes it unparseable. */
export function hasBad(node: Node): boolean {
  switch (node.t) {
    case 'bad':
      return true;
    case 'call':
      return node.args.some((a) => hasBad(a.value));
    case 'list':
      return node.items.some(hasBad);
    case 'map':
      return node.entries.some(([k, v]) => hasBad(k) || hasBad(v));
    case 'bin':
      return hasBad(node.l) || hasBad(node.r);
    case 'neg':
      return hasBad(node.v);
    case 'interp':
      return hasBad(node.inner);
    default:
      return false;
  }
}
