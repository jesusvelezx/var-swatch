/**
 * Document analysis: finds the value sites that reference variables or color
 * functions, evaluates them and computes theme variants.
 */
import { type Color, sameColor } from './color/color';
import { LESS_COLOR_FUNCTION_NAMES, NATIVE_CSS_COLOR_FUNCTIONS, SASS_COLOR_FUNCTION_NAMES, isCssColorFunction } from './color/functions';
import { type ExprMode, type Node, parseExpression } from './expr';
import type { ValueSite, VarDef } from './parse';
import type { Entry, Project } from './project';
import { Request, type RequestOptions, type Scope, type Trace } from './resolver';
import { Unresolved } from './values';

export interface Variant {
  key: string;
  label: string;
  color: Color;
}

export interface Swatch {
  start: number;
  end: number;
  color: Color;
  variants: Variant[];
  /** How to re-evaluate this swatch (for hover traces). */
  target: Target;
}

export type Target =
  | { kind: 'node'; node: Node; site: ValueSite }
  | { kind: 'cssvar'; name: string; def: VarDef }
  | { kind: 'def'; def: VarDef; site: ValueSite };

export interface AnalyzeOptions {
  themes: boolean;
  /** Also show plain literal colors (for languages without a native color provider). */
  literals: boolean;
}

export interface Explanation {
  color: Color;
  variants: Variant[];
  trace: Trace;
  /** Source text of the evaluated expression. */
  text: string;
}

function exprMode(entry: Entry): ExprMode {
  const s = entry.parsed.syntax;
  return s === 'less' ? 'less' : s === 'css' ? 'css' : 'scss';
}

function hasRef(n: Node): boolean {
  switch (n.t) {
    case 'svar':
    case 'lvar':
    case 'interp':
      return true;
    case 'call':
      return !!n.ns || n.name.toLowerCase() === 'var' || n.args.some((a) => hasRef(a.value));
    case 'list':
      return n.items.some(hasRef);
    case 'map':
      return n.entries.some(([k, v]) => hasRef(k) || hasRef(v));
    case 'bin':
      return hasRef(n.l) || hasRef(n.r);
    case 'neg':
      return hasRef(n.v);
    default:
      return false;
  }
}

function isCandidate(n: Node, entry: Entry, literals: boolean): boolean {
  switch (n.t) {
    case 'svar':
    case 'lvar':
    case 'interp':
      return true;
    case 'hex':
    case 'ident':
      return literals && n.t === 'hex';
    case 'bin':
    case 'neg':
      return hasRef(n);
    case 'call': {
      const lower = n.name.toLowerCase();
      if (hasRef(n)) return true;
      if (NATIVE_CSS_COLOR_FUNCTIONS.has(lower)) return literals;
      if (isCssColorFunction(lower)) return true;
      const syntax = entry.parsed.syntax;
      if (syntax === 'scss' || syntax === 'sass') return SASS_COLOR_FUNCTION_NAMES.has(lower.replace(/_/g, '-')) || entry.parsed.functions.length > 0;
      if (syntax === 'less') return LESS_COLOR_FUNCTION_NAMES.has(lower);
      return false;
    }
    default:
      return false;
  }
}

function children(n: Node): Node[] {
  switch (n.t) {
    case 'call':
      return n.args.map((a) => a.value);
    case 'list':
      return n.items;
    case 'map':
      return n.entries.map(([, v]) => v);
    default:
      return [];
  }
}

export class Analyzer {
  constructor(
    private readonly project: Project,
    private readonly opts: AnalyzeOptions,
  ) {}

  private scope(entry: Entry, offset: number): Scope {
    const s = entry.parsed.syntax;
    return { entry, offset, src: entry.text ?? '', mode: s === 'less' ? 'less' : s === 'css' ? 'css' : 'sass' };
  }

  private evaluate(target: Target, entry: Entry, req: Request): Color {
    switch (target.kind) {
      case 'node': {
        const sc = this.scope(entry, target.site.start);
        if (target.site.kind === 'prop') {
          return req.customPropertyColor(sc.src.slice(target.node.s, target.node.e), sc);
        }
        return req.color(target.node, sc);
      }
      case 'cssvar':
        return req.cssColor(`var(${target.name})`, { ...this.scope(entry, target.def.start), mode: 'css' });
      case 'def': {
        const node = parseExpression(entry.text ?? '', target.site.start, target.site.end, exprMode(entry));
        return this.evaluate({ kind: 'node', node, site: target.site }, entry, req);
      }
    }
  }

  private tryEvaluate(target: Target, entry: Entry, opts: RequestOptions): { color: Color; req: Request } | undefined {
    const req = new Request(this.project, opts);
    try {
      return { color: this.evaluate(target, entry, req), req };
    } catch (e) {
      if (e instanceof Unresolved) return undefined;
      throw e;
    }
  }

  private variants(target: Target, entry: Entry, base: Color, req: Request): Variant[] {
    if (!this.opts.themes) return [];
    const keys = new Map<string, { label: string; scheme?: 'light' | 'dark' }>();
    const names = new Set(req.touched);
    if (target.kind === 'cssvar') names.add(target.name);
    for (const name of names) {
      for (const { def } of req.cssDefs(name, entry)) {
        for (const ctx of def.contexts ?? []) {
          if (ctx.kind === 'variant' && !keys.has(ctx.key)) keys.set(ctx.key, { label: ctx.label, scheme: ctx.scheme });
        }
      }
      if (keys.size > 12) break;
    }
    if (req.lightDark) keys.set('scheme:dark', { label: 'light-dark() · dark', scheme: 'dark' });
    const out: Variant[] = [];
    for (const [key, { label, scheme }] of keys) {
      const r = this.tryEvaluate(target, entry, { themeKey: key, scheme });
      if (r && !sameColor(r.color, base) && !out.some((v) => v.label === label)) out.push({ key, label, color: r.color });
    }
    return out;
  }

  /** All swatches of an open document. */
  analyze(entry: Entry): Swatch[] {
    const text = entry.text;
    if (text === undefined) return [];
    const out: Swatch[] = [];
    const mode = exprMode(entry);
    for (const site of entry.parsed.sites) {
      const node = parseExpression(text, site.start, site.end, site.kind === 'prop' && mode === 'css' ? 'css' : mode);
      const visit = (n: Node): void => {
        if (n.t === 'bad') return;
        if (isCandidate(n, entry, this.opts.literals)) {
          const target: Target = { kind: 'node', node: n, site };
          const r = this.tryEvaluate(target, entry, {});
          if (r) {
            out.push({ start: n.s, end: n.e, color: r.color, variants: this.variants(target, entry, r.color, r.req), target });
            return;
          }
        }
        for (const c of children(n)) visit(c);
      };
      visit(node);
    }
    return out;
  }

  /** Re-evaluates a swatch with a resolution trace, for hovers. */
  explain(entry: Entry, target: Target): Explanation | undefined {
    const r = this.tryEvaluate(target, entry, { trace: true });
    if (!r) return undefined;
    const text =
      target.kind === 'node'
        ? (entry.text ?? '').slice(target.node.s, target.node.e)
        : target.kind === 'cssvar'
          ? target.name
          : target.def.value.trim();
    return { color: r.color, variants: this.variants(target, entry, r.color, r.req), trace: r.req.root, text };
  }

  /** The variable definition whose name is at `offset`, as an evaluation target. */
  definitionAt(entry: Entry, offset: number): { target: Target; start: number; end: number } | undefined {
    for (const def of entry.parsed.vars) {
      if (offset < def.start || offset > def.nameEnd) continue;
      if (def.kind === 'css') return { target: { kind: 'cssvar', name: def.name, def }, start: def.start, end: def.nameEnd };
      const site = entry.parsed.sites.find((s) => s.start === def.valueStart || (s.start >= def.valueStart && s.end <= def.valueEnd));
      if (!site) return undefined;
      return { target: { kind: 'def', def, site }, start: def.start, end: def.nameEnd };
    }
    return undefined;
  }
}
