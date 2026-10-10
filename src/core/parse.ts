/**
 * Stylesheet parser. A purpose-built scanner (not a full AST) that extracts
 * variable definitions, module rules, functions, block structure and value
 * sites. It never throws and recovers from incomplete code while typing.
 */
import { type ThemeContext, classify } from './themes';
import {
  type Syntax,
  lineCol,
  lineStarts,
  maskComments,
  matchParen,
  normalizeSassName,
  skipString,
  skipUrl,
  splitTopLevel,
  trimRange,
} from './text';

export type BlockKind = 'root' | 'rule' | 'at' | 'mixin' | 'function' | 'control' | 'include';

export interface Block {
  parent: number;
  kind: BlockKind;
  start: number;
  end: number;
  /** Names introduced by the block header (mixin/function params, @each/@for vars). */
  params?: string[];
}

export interface VarDef {
  kind: 'sass' | 'less' | 'css';
  /** Normalized name: `--x` for CSS, Sass names without `$` with `_` → `-`, Less names without `@`. */
  name: string;
  private: boolean;
  start: number;
  nameEnd: number;
  valueStart: number;
  valueEnd: number;
  value: string;
  isDefault: boolean;
  isGlobal: boolean;
  block: number;
  line: number;
  col: number;
  contexts?: ThemeContext[];
}

export interface ConfigEntry {
  name: string;
  value: string;
  valueStart: number;
  isDefault: boolean;
}

export interface ImportRule {
  kind: 'use' | 'forward' | 'import';
  url: string;
  start: number;
  end: number;
  line: number;
  /** `@use`: explicit namespace, `null` for `as *`, undefined for the default. */
  namespace?: string | null;
  /** `@forward ... as prefix-*` */
  prefix?: string;
  show?: string[];
  hide?: string[];
  config?: ConfigEntry[];
  /** Plain CSS import (`url()`, `.css`, media queries). */
  plainCss?: boolean;
}

export interface ParamDef {
  name: string;
  value?: string;
  valueStart?: number;
  rest?: boolean;
}

export interface FnDef {
  name: string;
  private: boolean;
  params: ParamDef[];
  block: number;
  start: number;
  line: number;
  col: number;
  ret?: { start: number; value: string };
  /** Contains control flow or several @return statements: not evaluated. */
  complex: boolean;
}

export interface ValueSite {
  start: number;
  end: number;
  value: string;
  block: number;
  kind: 'decl' | 'var' | 'prop' | 'include';
}

export interface ParsedFile {
  syntax: Syntax;
  vars: VarDef[];
  imports: ImportRule[];
  functions: FnDef[];
  blocks: Block[];
  sites: ValueSite[];
  /** Comment-masked source (same offsets as the input); only with `sites`. */
  masked?: string;
}

export interface ParseOptions {
  /** Collect value sites (needed for the open document only). */
  sites?: boolean;
}

interface Sink {
  open(start: number, end: number): void;
  close(at: number): void;
  statement(start: number, end: number): void;
}

/** Brace-based scanner shared by CSS, SCSS and Less. */
function scanBraces(m: string, sink: Sink): void {
  const n = m.length;
  let i = 0;
  let stmt = -1;
  let paren = 0;
  while (i < n) {
    const c = m.charCodeAt(i);
    if (c === 34 || c === 39) {
      if (stmt < 0) stmt = i;
      i = skipString(m, i);
      continue;
    }
    if (c === 35 /* # */ && m.charCodeAt(i + 1) === 123 /* { */) {
      if (stmt < 0) stmt = i;
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        const d = m.charCodeAt(j);
        if (d === 123) depth++;
        else if (d === 125 && --depth === 0) break;
        else if (d === 59 || d === 10) break; // unterminated interpolation: stop at line end
      }
      i = j + 1;
      continue;
    }
    if (c === 117 || c === 85) {
      const end = skipUrl(m, i);
      if (end !== undefined) {
        if (stmt < 0) stmt = i;
        i = end;
        continue;
      }
    }
    if (c === 40) paren++;
    else if (c === 41) paren = Math.max(0, paren - 1);
    else if (c === 123 || c === 125 || c === 59) {
      // Braces and semicolons never appear inside parentheses in valid code:
      // treat them as recovery points for unbalanced input.
      paren = 0;
      if (c === 123) {
        sink.open(stmt < 0 ? i : stmt, i);
      } else {
        if (stmt >= 0) sink.statement(stmt, i);
        if (c === 125) sink.close(i);
      }
      stmt = -1;
      i++;
      continue;
    }
    if (stmt < 0 && c !== 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) stmt = i;
    i++;
  }
  if (stmt >= 0) sink.statement(stmt, n);
}

/** Indentation-based scanner for the indented Sass syntax. */
function scanIndented(src: string, m: string, sink: Sink): void {
  interface Line {
    start: number;
    end: number;
    indent: number;
    comment?: boolean;
  }
  const lines: Line[] = [];
  let pos = 0;
  while (pos <= m.length) {
    let nl = m.indexOf('\n', pos);
    if (nl < 0) nl = m.length;
    let s = pos;
    while (s < nl && (src[s] === ' ' || src[s] === '\t')) s++;
    let e = nl;
    while (e > s && /\s/.test(m[e - 1]!)) e--;
    const head = src.slice(s, s + 2);
    if (e <= s && (head === '//' || head === '/*')) lines.push({ start: s, end: s, indent: s - pos, comment: true });
    else if (s < e) lines.push({ start: s, end: e, indent: s - pos });
    pos = nl + 1;
  }
  // Join lines with unbalanced parentheses (multi-line maps and argument lists).
  const logical: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i]!;
    let end = first.end;
    let depth = 0;
    const count = (l: Line): void => {
      for (let k = l.start; k < l.end; k++) {
        const ch = m[k];
        if (ch === '"' || ch === "'") k = skipString(m, k) - 1;
        else if (ch === '(') depth++;
        else if (ch === ')') depth--;
      }
    };
    count(first);
    while (depth > 0 && i + 1 < lines.length) {
      i++;
      count(lines[i]!);
      end = lines[i]!.end;
    }
    logical.push({ start: first.start, end, indent: first.indent, comment: first.comment });
  }
  const stack: number[] = [];
  let skipIndent = -1;
  for (let i = 0; i < logical.length; i++) {
    const line = logical[i]!;
    if (skipIndent >= 0) {
      if (line.indent > skipIndent) continue;
      skipIndent = -1;
    }
    while (stack.length && stack[stack.length - 1]! >= line.indent) {
      stack.pop();
      sink.close(line.start);
    }
    // A comment line swallows the more-indented lines that follow it.
    if (line.comment) {
      skipIndent = line.indent;
      continue;
    }
    const next = logical[i + 1];
    let end = line.end;
    if (m[end - 1] === ';') end--;
    if (next && next.indent > line.indent) {
      sink.open(line.start, end);
      stack.push(line.indent);
    } else {
      sink.statement(line.start, end);
    }
  }
  while (stack.length) {
    stack.pop();
    sink.close(m.length);
  }
}

const AT_BLOCK_NEUTRAL = /^@(?:media|supports|layer|container|document|scope|at-root|font-face|page|keyframes|-webkit-keyframes|starting-style)\b/i;
const CONTROL = /^@(?:if|else|each|for|while)\b/i;

function defaultFlags(value: string): { value: string; isDefault: boolean; isGlobal: boolean; trimmed: number } {
  let isDefault = false;
  let isGlobal = false;
  let v = value;
  for (;;) {
    const m = /\s*!(default|global)\s*$/i.exec(v);
    if (!m) break;
    if (m[1]!.toLowerCase() === 'default') isDefault = true;
    else isGlobal = true;
    v = v.slice(0, m.index);
  }
  return { value: v, isDefault, isGlobal, trimmed: value.length - v.length };
}

function parseParams(text: string, base: number): ParamDef[] {
  const out: ParamDef[] = [];
  const open = text.indexOf('(');
  if (open < 0) return out;
  const close = matchParen(text, open);
  const inner = close < 0 ? text.length : close;
  for (const [s, e] of splitTopLevel(text, ',', open + 1, inner)) {
    const [ts, te] = trimRange(text, s, e);
    const piece = text.slice(ts, te);
    const m = /^[$@]([\w-]+)\s*(\.\.\.)?\s*(?::\s*)?/.exec(piece);
    if (!m) continue;
    const param: ParamDef = { name: normalizeSassName(m[1]!) };
    if (m[2]) param.rest = true;
    if (piece.slice(0, m[0].length).includes(':')) {
      param.value = piece.slice(m[0].length);
      param.valueStart = base + ts + m[0].length;
    }
    out.push(param);
  }
  return out;
}

function parseConfig(text: string, open: number, base: number): ConfigEntry[] {
  const close = matchParen(text, open);
  const out: ConfigEntry[] = [];
  for (const [s, e] of splitTopLevel(text, ',', open + 1, close < 0 ? text.length : close)) {
    const [ts, te] = trimRange(text, s, e);
    const m = /^\$([\w-]+)\s*:\s*/.exec(text.slice(ts, te));
    if (!m) continue;
    const flags = defaultFlags(text.slice(ts + m[0].length, te));
    out.push({
      name: normalizeSassName(m[1]!),
      value: flags.value,
      valueStart: base + ts + m[0].length,
      isDefault: flags.isDefault,
    });
  }
  return out;
}

const URL_RE = /^(["'])((?:\\.|(?!\1).)*)\1/;

const MIXIN_CONTEXT: ThemeContext[] = [{ kind: 'scoped', key: 'scoped:@mixin', label: 'inside a mixin' }];
/** Shared (immutable) classification results: most files repeat the same few selectors. */
const CONTEXT_CACHE = new Map<string, ThemeContext[]>();

function parseNames(list: string): string[] {
  return list
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => (x.startsWith('$') ? '$' + normalizeSassName(x.slice(1)) : normalizeSassName(x)));
}

class Builder implements Sink {
  readonly file: ParsedFile;
  private readonly starts: number[];
  private readonly stack: number[] = [0];
  private readonly selectorStack: (string[] | null)[] = [null];
  private readonly atStack: string[][] = [[]];
  private readonly fnStack: (FnDef | null)[] = [null];
  private readonly blockContexts = new Map<number, ThemeContext[]>();

  constructor(
    private readonly src: string,
    private readonly m: string,
    syntax: Syntax,
    private readonly opts: ParseOptions,
  ) {
    this.starts = lineStarts(src);
    this.file = {
      syntax,
      vars: [],
      imports: [],
      functions: [],
      blocks: [{ parent: -1, kind: 'root', start: 0, end: src.length }],
      sites: [],
    };
  }

  private get block(): number {
    return this.stack[this.stack.length - 1]!;
  }

  private pos(offset: number): { line: number; col: number } {
    return lineCol(this.starts, offset);
  }

  open(start: number, end: number): void {
    const [s, e] = trimRange(this.m, start, end);
    const text = this.m.slice(s, e);
    const parent = this.block;
    const parentSelectors = this.selectorStack[this.selectorStack.length - 1]!;
    let ats = this.atStack[this.atStack.length - 1]!;
    let selectors: string[] | null = parentSelectors;
    let kind: BlockKind = 'rule';
    let params: string[] | undefined;
    let fn: FnDef | null = this.fnStack[this.fnStack.length - 1]!;
    const syntax = this.file.syntax;

    if (text.startsWith('@') || (syntax === 'sass' && (text.startsWith('=') || text.startsWith('+')))) {
      const at = text.startsWith('=') ? '@mixin ' + text.slice(1) : text.startsWith('+') ? '@include ' + text.slice(1) : text;
      if (/^@(?:mixin|function)\b/i.test(at)) {
        const isFn = /^@function/i.test(at);
        kind = isFn ? 'function' : 'mixin';
        const offsetInText = text.startsWith('=') ? -6 : 0;
        const ps = parseParams(at, s + offsetInText);
        params = ps.map((p) => p.name);
        if (isFn) {
          const name = /^@function\s+([\w-]+)/i.exec(at)?.[1];
          if (name) {
            const { line, col } = this.pos(s);
            fn = {
              name: normalizeSassName(name),
              private: /^[-_]/.test(name),
              params: ps,
              block: this.file.blocks.length,
              start: s,
              line,
              col,
              complex: false,
            };
            if (this.stack.length === 1) this.file.functions.push(fn);
          }
        }
      } else if (CONTROL.test(at)) {
        kind = 'control';
        const each = /^@(?:each|for)\s+(.*?)\s+(?:in|from)\b/i.exec(at);
        if (each) params = [...each[1]!.matchAll(/\$([\w-]+)/g)].map((x) => normalizeSassName(x[1]!));
        if (fn) fn.complex = true;
      } else if (/^@include\b/i.test(at)) {
        kind = 'include';
        const using = /\busing\s*\((.*)\)/i.exec(at);
        if (using) params = [...using[1]!.matchAll(/\$([\w-]+)/g)].map((x) => normalizeSassName(x[1]!));
        this.addIncludeSite(at, s + (at.length - text.length) * -1);
      } else if (AT_BLOCK_NEUTRAL.test(at) || /^@[\w-]+/.test(at)) {
        kind = 'at';
        if (/^@(?:media|supports|layer|container|scope)\b/i.test(at)) ats = [...ats, at.replace(/\s+/g, ' ')];
        if (/^@at-root\b/i.test(at)) selectors = null;
      }
    } else if (syntax === 'less' && /^[.#][\w-]+\s*\(/.test(text)) {
      // Less mixin definition: .mixin(@a; @b: 2) { }
      kind = 'mixin';
      params = [...text.matchAll(/@([\w-]+)/g)].map((x) => x[1]!);
    } else {
      selectors = resolveSelectors(parentSelectors, text);
    }

    const id = this.file.blocks.length;
    const block: Block = { parent, kind, start: s, end: this.src.length };
    if (params?.length) block.params = params;
    this.file.blocks.push(block);
    this.stack.push(id);
    this.selectorStack.push(selectors);
    this.atStack.push(ats);
    this.fnStack.push(fn);
  }

  close(at: number): void {
    if (this.stack.length <= 1) return; // stray }
    const id = this.stack.pop()!;
    this.file.blocks[id]!.end = at;
    this.selectorStack.pop();
    this.atStack.pop();
    this.fnStack.pop();
  }

  statement(start: number, end: number): void {
    const [s, e] = trimRange(this.m, start, end);
    if (s >= e) return;
    const text = this.m.slice(s, e);
    const c = text[0];
    const syntax = this.file.syntax;
    if (c === '$' && syntax !== 'css' && syntax !== 'less') return this.sassVar(text, s);
    if (c === '@') {
      if (syntax === 'less' && /^@[\w-]+\s*:/.test(text)) return this.lessVar(text, s);
      return this.atStatement(text, s, e);
    }
    if (c === '+' && syntax === 'sass') return this.addIncludeSite('@include ' + text.slice(1), s - 9 + 1);
    if (c === '-' && text[1] === '-') return this.customProp(text, s);
    this.declaration(text, s);
  }

  private addSite(start: number, end: number, kind: ValueSite['kind']): void {
    if (!this.opts.sites) return;
    const [s, e] = trimRange(this.src, start, end);
    if (s >= e) return;
    this.file.sites.push({ start: s, end: e, value: this.m.slice(s, e), block: this.block, kind });
  }

  /** `at` is the at-rule text starting with `@include`; `base` maps index 0 of `at` to a source offset. */
  private addIncludeSite(at: string, base: number): void {
    const m = /^@include\s+/i.exec(at);
    if (!m) return;
    let stop = at.length;
    const using = /\busing\s*\(/i.exec(at);
    if (using) stop = using.index;
    this.addSite(base + m[0].length, base + stop, 'include');
  }

  private sassVar(text: string, s: number): void {
    const m = /^\$([\w-]+)\s*:\s*/.exec(text);
    if (!m) return;
    const flags = defaultFlags(text.slice(m[0].length));
    const valueStart = s + m[0].length;
    const valueEnd = s + text.length - flags.trimmed;
    const { line, col } = this.pos(s);
    const raw = m[1]!;
    this.file.vars.push({
      kind: 'sass',
      name: normalizeSassName(raw),
      private: /^[-_]/.test(raw),
      start: s,
      nameEnd: s + 1 + raw.length,
      valueStart,
      valueEnd,
      value: flags.value,
      isDefault: flags.isDefault,
      isGlobal: flags.isGlobal,
      block: this.block,
      line,
      col,
    });
    this.addSite(valueStart, valueEnd, 'var');
  }

  private lessVar(text: string, s: number): void {
    const m = /^@([\w-]+)\s*:\s*/.exec(text)!;
    let value = text.slice(m[0].length);
    const imp = /\s*!important\s*$/i.exec(value);
    if (imp) value = value.slice(0, imp.index);
    const valueStart = s + m[0].length;
    const { line, col } = this.pos(s);
    this.file.vars.push({
      kind: 'less',
      name: m[1]!,
      private: false,
      start: s,
      nameEnd: s + 1 + m[1]!.length,
      valueStart,
      valueEnd: valueStart + value.length,
      value,
      isDefault: false,
      isGlobal: false,
      block: this.block,
      line,
      col,
    });
    this.addSite(valueStart, valueStart + value.length, 'var');
  }

  private customProp(text: string, s: number): void {
    const m = /^(--[^\s:]*)\s*:\s*/.exec(text);
    if (!m) return;
    let value = text.slice(m[0].length);
    const imp = /\s*!important\s*$/i.exec(value);
    if (imp) value = value.slice(0, imp.index);
    const valueStart = s + m[0].length;
    const { line, col } = this.pos(s);
    this.file.vars.push({
      kind: 'css',
      name: m[1]!,
      private: false,
      start: s,
      nameEnd: s + m[1]!.length,
      valueStart,
      valueEnd: valueStart + value.length,
      value,
      isDefault: false,
      isGlobal: false,
      block: this.block,
      line,
      col,
      contexts: this.contexts(),
    });
    this.addSite(valueStart, valueStart + value.length, 'prop');
  }

  /** Theme contexts are shared by every definition of a block (and identical blocks) to keep the index small. */
  private contexts(): ThemeContext[] {
    const block = this.block;
    const cached = this.blockContexts.get(block);
    if (cached) return cached;
    let result: ThemeContext[] | undefined;
    for (let i = this.stack.length - 1; i > 0; i--) {
      const kind = this.file.blocks[this.stack[i]!]!.kind;
      if (kind === 'mixin' || kind === 'function' || kind === 'include') {
        result = MIXIN_CONTEXT;
        break;
      }
    }
    if (!result) {
      const selectors = this.selectorStack[this.selectorStack.length - 1] ?? [];
      const ats = this.atStack[this.atStack.length - 1]!;
      const key = selectors.join('\n') + '\0' + ats.join('\n');
      result = CONTEXT_CACHE.get(key);
      if (!result) {
        result = classify(selectors, ats);
        if (CONTEXT_CACHE.size > 5000) CONTEXT_CACHE.clear();
        CONTEXT_CACHE.set(key, result);
      }
    }
    this.blockContexts.set(block, result);
    return result;
  }

  private declaration(text: string, s: number): void {
    if (!this.opts.sites) return;
    const m = /^(\*?[a-zA-Z-][\w-]*)\s*:/.exec(text);
    if (!m) return;
    let value = text.slice(m[0].length);
    const imp = /\s*!important\s*$/i.exec(value);
    if (imp) value = value.slice(0, imp.index);
    const valueStart = s + m[0].length;
    this.addSite(valueStart, valueStart + value.length, 'decl');
  }

  private atStatement(text: string, s: number, e: number): void {
    const name = /^@([\w-]+)/.exec(text)?.[1]?.toLowerCase();
    const { line } = this.pos(s);
    switch (name) {
      case 'use':
      case 'forward': {
        const rest = text.slice(name.length + 1).trimStart();
        const restBase = text.length - rest.length;
        const um = URL_RE.exec(rest);
        if (!um) return;
        const rule: ImportRule = { kind: name, url: um[2]!, start: s, end: e, line };
        const after = rest.slice(um[0].length);
        const afterBase = restBase + um[0].length;
        const withIdx = /\bwith\s*\(/i.exec(after);
        const head = withIdx ? after.slice(0, withIdx.index) : after;
        if (name === 'use') {
          const as = /\bas\s+(\*|[\w-]+)/i.exec(head);
          if (as) rule.namespace = as[1] === '*' ? null : as[1]!;
        } else {
          const as = /\bas\s+([\w-]*)\*/i.exec(head);
          if (as) rule.prefix = as[1]!;
          const show = /\bshow\s+(.+)$/i.exec(head);
          if (show) rule.show = parseNames(show[1]!);
          const hide = /\bhide\s+(.+)$/i.exec(head);
          if (hide) rule.hide = parseNames(hide[1]!);
        }
        if (withIdx) {
          const open = afterBase + withIdx.index + withIdx[0].length - 1;
          rule.config = parseConfig(text, open, s);
        }
        this.file.imports.push(rule);
        return;
      }
      case 'import': {
        const body = 7;
        for (const [ps, pe] of splitTopLevel(text, ',', body, text.length)) {
          const [ts, te] = trimRange(text, ps, pe);
          let piece = text.slice(ts, te);
          // Less import options: @import (reference) "foo";
          piece = piece.replace(/^\([^)]*\)\s*/, '');
          let url: string | undefined;
          let plainCss = false;
          const qm = URL_RE.exec(piece);
          const um = /^url\(\s*(["']?)([^"')]*)\1\s*\)/i.exec(piece);
          let rest = '';
          if (qm) {
            url = qm[2]!;
            rest = piece.slice(qm[0].length);
          } else if (um) {
            url = um[2]!;
            plainCss = true;
            rest = piece.slice(um[0].length);
          } else if (this.file.syntax === 'sass' && /^[^\s"']+$/.test(piece)) {
            url = piece;
          }
          if (!url) continue;
          if (rest.trim() || /\.css$/i.test(url) || /^(?:https?:)?\/\//i.test(url)) plainCss = true;
          this.file.imports.push({ kind: 'import', url, start: s, end: e, line, plainCss });
        }
        return;
      }
      case 'return': {
        const fn = this.fnStack[this.fnStack.length - 1];
        if (!fn) return;
        if (fn.ret) fn.complex = true;
        const m = /^@return\s+/i.exec(text);
        if (m) fn.ret = { start: s + m[0].length, value: text.slice(m[0].length) };
        return;
      }
      case 'include':
        this.addIncludeSite(text, s);
        return;
      default:
        return;
    }
  }
}

const MAX_SELECTORS = 64;

export function resolveSelectors(parent: string[] | null, prelude: string): string[] {
  const parts = splitTopLevel(prelude, ',').map(([s, e]) => prelude.slice(s, e).trim()).filter(Boolean);
  if (!parent?.length) return parts.slice(0, MAX_SELECTORS);
  const out: string[] = [];
  for (const p of parts) {
    for (const q of parent) {
      out.push(p.includes('&') ? p.replace(/&/g, q) : `${q} ${p}`);
      if (out.length >= MAX_SELECTORS) return out;
    }
  }
  return out;
}

export function parseStylesheet(text: string, syntax: Syntax, opts: ParseOptions = {}): ParsedFile {
  const masked = maskComments(text, syntax !== 'css', syntax === 'sass');
  const builder = new Builder(text, masked, syntax, opts);
  if (syntax === 'sass') scanIndented(text, masked, builder);
  else scanBraces(masked, builder);
  if (opts.sites) builder.file.masked = masked;
  return builder.file;
}

// ---------------------------------------------------------------------------
// Embedded <style> blocks (HTML, Vue, Svelte, Astro)
// ---------------------------------------------------------------------------

const STYLE_BLOCK = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
const STYLE_ATTR = /(?<=[\s"'])style\s*=\s*(["'])([^"']*)\1/gi;

function langOf(attrs: string): Syntax | undefined {
  const m = /\blang\s*=\s*["']?([\w-]+)/i.exec(attrs);
  const lang = m?.[1]?.toLowerCase();
  switch (lang) {
    case undefined:
    case 'css':
    case 'postcss':
    case 'pcss':
      return 'css';
    case 'scss':
      return 'scss';
    case 'sass':
      return 'sass';
    case 'less':
      return 'less';
    default:
      return undefined; // stylus etc.
  }
}

/** Keeps only the given ranges of `text`, blanking everything else (newlines kept). */
function keepRanges(text: string, ranges: [number, number][], terminated = new Set<number>()): string {
  let out = '';
  let last = 0;
  for (const [s, e] of ranges) {
    out += text.slice(last, s).replace(/[^\r\n]/g, ' ') + text.slice(s, e);
    last = e;
    // Inline style attributes: the closing quote becomes a terminating ';'.
    if (terminated.has(e) && e < text.length) {
      out += ';';
      last = e + 1;
    }
  }
  return out + text.slice(last).replace(/[^\r\n]/g, ' ');
}

export function parseEmbedded(text: string, opts: ParseOptions = {}): ParsedFile {
  const groups = new Map<Syntax, [number, number][]>();
  const attrEnds = new Set<number>();
  for (const m of text.matchAll(STYLE_BLOCK)) {
    const syntax = langOf(m[1]!);
    if (!syntax) continue;
    const start = m.index! + m[0].indexOf('>') + 1;
    const list = groups.get(syntax) ?? [];
    list.push([start, start + m[2]!.length]);
    groups.set(syntax, list);
  }
  if (opts.sites) {
    // Inline style="" attributes are parsed as CSS declaration lists.
    const list = groups.get('css') ?? [];
    for (const m of text.matchAll(STYLE_ATTR)) {
      const start = m.index! + m[0].length - 1 - m[2]!.length;
      list.push([start, start + m[2]!.length]);
      attrEnds.add(start + m[2]!.length);
    }
    if (list.length) groups.set('css', list.sort((a, b) => a[0] - b[0]));
  }
  const parts = [...groups].map(([syntax, ranges]) => parseStylesheet(keepRanges(text, ranges, attrEnds), syntax, opts));
  if (!parts.length) return parseStylesheet(keepRanges(text, []), 'css', opts);
  if (parts.length === 1) return parts[0]!;
  // Merge several syntaxes into one file, renumbering blocks (each part's root maps to 0).
  const merged: ParsedFile = { ...parts[0]!, vars: [], imports: [], functions: [], blocks: [parts[0]!.blocks[0]!], sites: [] };
  for (const part of parts) {
    const base = merged.blocks.length - 1;
    const map = (id: number): number => (id === 0 ? 0 : id + base);
    for (const b of part.blocks.slice(1)) merged.blocks.push({ ...b, parent: map(b.parent) });
    merged.vars.push(...part.vars.map((v) => ({ ...v, block: map(v.block) })));
    merged.imports.push(...part.imports);
    merged.functions.push(...part.functions.map((f) => ({ ...f, block: map(f.block) })));
    merged.sites.push(...part.sites.map((x) => ({ ...x, block: map(x.block) })));
  }
  if (opts.sites) {
    // Each group's masked text is blank outside its own ranges: overlay them.
    const chars = parts[0]!.masked!.split('');
    [...groups.values()].forEach((ranges, gi) => {
      const m = parts[gi]!.masked!;
      for (const [s, e] of ranges) for (let i = s; i < e; i++) chars[i] = m[i]!;
    });
    merged.masked = chars.join('');
  }
  merged.vars.sort((a, b) => a.start - b.start);
  merged.imports.sort((a, b) => a.start - b.start);
  merged.sites.sort((a, b) => a.start - b.start);
  return merged;
}
