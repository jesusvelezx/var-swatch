/**
 * Evaluates expressions against the project: Sass variables (scopes, @import,
 * @use/@forward with prefixes, show/hide and `with()` configuration), Less
 * variables, CSS custom properties (textual `var()` substitution with
 * fallbacks and theme variants) and color functions.
 *
 * Anything uncertain throws `Unresolved`: callers then show nothing.
 */
import { type Color, namedColor, parseHex, sameColor } from './color/color';
import {
  type CallArgs,
  type Mode,
  callCssFunction,
  callLessFunction,
  callSassColorModule,
  callSassGlobal,
  isCssColorFunction,
  LESS_COLOR_FUNCTION_NAMES,
} from './color/functions';
import { type Arg, type ExprMode, type Node, parseExpression } from './expr';
import type { FnDef, ImportRule, VarDef } from './parse';
import { type Entry, type Project, normalizePath } from './project';
import { defaultNamespace } from './sassResolve';
import { matchParen, normalizeSassName, splitTopLevel } from './text';
import {
  NULL,
  Unresolved,
  type Value,
  asNumber,
  colorValue,
  fail,
  num,
  str,
  toCssText,
  valuesEqual,
} from './values';

export interface Location {
  path: string;
  line: number;
  col: number;
}

export interface Trace {
  label: string;
  loc?: Location;
  /** Source text of the definition's value. */
  expr?: string;
  note?: string;
  /** The value this step evaluated to, as CSS text. */
  result?: string;
  children: Trace[];
}

export interface RequestOptions {
  /** Theme variant key to resolve CSS custom properties for. */
  themeKey?: string;
  /** Color scheme used by `light-dark()`. */
  scheme?: 'light' | 'dark';
  trace?: boolean;
}

/** An import chain: names not found in a file fall back to the importing file's globals. */
interface ImportCtx {
  entry: Entry;
  offset: number;
  parent?: ImportCtx;
  key: string;
}

export interface Scope {
  entry: Entry;
  /** Position in the entry used for scoping. */
  offset: number;
  /** The text that node offsets index into. */
  src: string;
  mode: Mode;
  locals?: Map<string, Value>;
  importCtx?: ImportCtx;
  /** Module configuration (`@use ... with()`) in effect while evaluating a module's members. */
  config?: Config;
}

type Winner =
  | { kind: 'def'; entry: Entry; def: VarDef; importCtx?: ImportCtx; config?: Config; note?: string }
  | { kind: 'config'; entry: Entry; name: string; value: string; valueStart: number; line: number; note: string };

type Config = Map<string, Winner>;

const MAX_DEPTH = 64;

const nodeCache = new WeakMap<object, Node>();

function exprModeOf(entry: Entry): ExprMode {
  const s = entry.parsed.syntax;
  return s === 'less' ? 'less' : s === 'css' ? 'css' : 'scss';
}

function modeOf(entry: Entry): Mode {
  const s = entry.parsed.syntax;
  return s === 'less' ? 'less' : s === 'css' ? 'css' : 'sass';
}

export class Request {
  readonly touched = new Set<string>();
  lightDark = false;
  private depth = 0;
  private readonly active = new Set<string>();
  private readonly memo = new Map<string, Value>();
  private stack: Trace[] = [];
  readonly root: Trace = { label: '', children: [] };

  constructor(
    readonly project: Project,
    readonly opts: RequestOptions = {},
  ) {
    this.stack = [this.root];
  }

  // -------------------------------------------------------------------------
  // Entry points
  // -------------------------------------------------------------------------

  /** Evaluates a node to a color, resolving CSS-level `var()` references. */
  color(node: Node, sc: Scope): Color {
    if (sc.mode === 'css') return this.cssColor(sc.src.slice(node.s, node.e), sc);
    const v = this.eval(node, sc);
    return this.finish(v, sc);
  }

  /** Evaluates a CSS custom property value (raw tokens; Sass only interpolates `#{}`). */
  customPropertyColor(text: string, sc: Scope): Color {
    return this.cssColor(this.interpolate(text, sc), sc);
  }

  private finish(v: Value, sc: Scope): Color {
    if (v.kind === 'color') return v.color;
    if (v.kind === 'raw') return this.cssColor(v.text, sc);
    if (v.kind === 'string' && !v.quoted) return this.cssColor(v.value, sc);
    return fail('not a color');
  }

  cssColor(text: string, sc: Scope): Color {
    const resolved = this.substitute(text, sc);
    const node = parseExpression(resolved, 0, resolved.length, 'css');
    const v = this.eval(node, { ...sc, src: resolved, mode: 'css' });
    if (v.kind !== 'color') return fail('not a color');
    return v.color;
  }

  // -------------------------------------------------------------------------
  // Tracing helpers
  // -------------------------------------------------------------------------

  private enter<T>(key: string, trace: Trace | undefined, fn: () => T): T {
    if (this.active.has(key)) fail('cycle');
    if (++this.depth > MAX_DEPTH) {
      this.depth--;
      fail('too deep');
    }
    this.active.add(key);
    if (trace && this.opts.trace) {
      this.stack[this.stack.length - 1]!.children.push(trace);
      this.stack.push(trace);
    }
    try {
      const result = fn();
      if (trace && this.opts.trace) trace.result = describe(result);
      return result;
    } finally {
      this.active.delete(key);
      this.depth--;
      if (trace && this.opts.trace) this.stack.pop();
    }
  }

  private loc(entry: Entry, line: number, col: number): Location {
    return { path: entry.path, line, col };
  }

  // -------------------------------------------------------------------------
  // Expression evaluation
  // -------------------------------------------------------------------------

  eval(n: Node, sc: Scope): Value {
    switch (n.t) {
      case 'num':
        return num(n.value, n.unit.toLowerCase() === '%' ? '%' : n.unit);
      case 'hex': {
        const c = parseHex(n.text);
        return c ? colorValue(c) : fail('bad hex');
      }
      case 'ident': {
        const lower = n.name.toLowerCase();
        if (sc.mode === 'sass') {
          if (lower === 'true' || lower === 'false') return { kind: 'bool', value: lower === 'true' };
          if (lower === 'null') return NULL;
        }
        if (lower === 'currentcolor' || lower === 'inherit' || lower === 'initial' || lower === 'unset') {
          return fail('runtime keyword');
        }
        const c = namedColor(n.name);
        return c ? colorValue(c) : str(n.name);
      }
      case 'str':
        return str(n.value, true);
      case 'svar':
        if (sc.mode !== 'sass') return fail('sass var outside sass');
        return this.sassVar(n.ns, normalizeSassName(n.name), sc);
      case 'lvar':
        if (sc.mode !== 'less') return fail('less var outside less');
        return this.lessVar(n.name, sc);
      case 'interp': {
        const v = this.eval(n.inner, { ...sc, mode: sc.mode === 'less' ? 'less' : 'sass' });
        return v.kind === 'string' ? str(v.value) : v;
      }
      case 'list': {
        if (n.items.length === 1 && !n.bracketed) return this.eval(n.items[0]!, sc);
        return { kind: 'list', sep: n.sep, items: n.items.map((i) => this.eval(i, sc)), bracketed: n.bracketed };
      }
      case 'map':
        return { kind: 'map', entries: n.entries.map(([k, v]) => [this.eval(k, sc), this.eval(v, sc)]) };
      case 'bin':
        return arithmetic(n.op, this.eval(n.l, sc), this.eval(n.r, sc));
      case 'neg': {
        const v = asNumber(this.eval(n.v, sc));
        return num(-v.value, v.unit);
      }
      case 'call':
        return this.call(n, sc);
      case 'bad':
        return fail('unparseable');
    }
  }

  private args(args: Arg[], sc: Scope): CallArgs {
    const out: CallArgs = { positional: [], named: new Map() };
    for (const a of args) {
      const v = this.eval(a.value, sc);
      if (a.rest) {
        if (v.kind === 'list') out.positional.push(...v.items);
        else if (v.kind === 'map') {
          for (const [k, val] of v.entries) {
            if (k.kind !== 'string') fail('bad keyword');
            out.named.set(normalizeSassName((k as { value: string }).value), val);
          }
        } else out.positional.push(v);
      } else if (a.name) out.named.set(normalizeSassName(a.name), v);
      else out.positional.push(v);
    }
    return out;
  }

  private call(n: Extract<Node, { t: 'call' }>, sc: Scope): Value {
    const name = n.name;
    const lower = name.toLowerCase();
    const rawText = (): Value => ({ kind: 'raw', text: sc.src.slice(n.s, n.e) });

    if (lower === 'var') {
      if (sc.mode === 'css') return fail('unsubstituted var()');
      return rawText();
    }
    if (lower === 'env' || lower === 'attr' || lower === 'calc' && sc.mode === 'css') return fail('runtime function');

    if (lower === 'light-dark') {
      this.lightDark = true;
      const args = this.args(n.args, sc);
      if (args.positional.length !== 2 || args.named.size) return fail('bad light-dark()');
      const pick = args.positional[this.opts.scheme === 'dark' ? 1 : 0]!;
      if (pick.kind === 'raw') return pick;
      if (pick.kind !== 'color') return fail('bad light-dark()');
      return pick;
    }

    if (sc.mode === 'sass') {
      if (n.ns) return this.namespacedCall(n.ns, normalizeSassName(name), n, sc);
      const user = this.findFunction(sc.entry, normalizeSassName(name));
      if (user) return this.userFunction(user.entry, user.fn, this.args(n.args, sc), name);
      const special = this.sassSpecial(normalizeSassName(name), n, sc);
      if (special) return special;
    }

    const args = this.args(n.args, sc);
    const hasRaw = [...args.positional, ...args.named.values()].some(isRaw);
    if (hasRaw) {
      // Plain CSS functions pass through to the browser (var() is substituted later);
      // Sass/Less color functions can't operate on var() and fail to compile.
      const preprocessorOnly =
        !isCssColorFunction(lower) &&
        (sc.mode === 'sass' ? KNOWN_SASS.has(normalizeSassName(lower)) : sc.mode === 'less' && LESS_COLOR_FUNCTION_NAMES.has(lower));
      if (preprocessorOnly) return fail('color function with var() argument');
      return { kind: 'raw', text: serializeCall(name, args) };
    }
    let result: Value | undefined;
    if (sc.mode === 'sass') result = callSassGlobal(normalizeSassName(name), args);
    else if (sc.mode === 'less') result = callLessFunction(lower, args);
    else result = callCssFunction(lower, args, 'css');
    if (result) return result;
    // Unknown function: plain CSS text (never a color by itself).
    return { kind: 'raw', text: serializeCall(name, args) };
  }

  private sassSpecial(name: string, n: Extract<Node, { t: 'call' }>, sc: Scope): Value | undefined {
    switch (name) {
      case 'map-get':
        return mapGet(this.args(n.args, sc));
      case 'nth':
        return nth(this.args(n.args, sc));
      case 'if': {
        const args = this.args(n.args, sc);
        const [cond, a, b] = args.positional;
        if (!cond || !a || !b) return fail('bad if()');
        return truthy(cond) ? a : b;
      }
      case 'percentage':
        return num(asNumber(this.args(n.args, sc).positional[0]).value * 100, '%');
      case 'unquote': {
        const v = this.args(n.args, sc).positional[0];
        return v?.kind === 'string' ? str(v.value) : fail('bad unquote');
      }
      default:
        return undefined;
    }
  }

  private namespacedCall(ns: string, name: string, n: Extract<Node, { t: 'call' }>, sc: Scope): Value {
    const mod = this.namespace(sc.entry, ns);
    if (!mod) return fail(`unknown namespace ${ns}`);
    if ('builtin' in mod) {
      const args = this.args(n.args, sc);
      switch (mod.builtin) {
        case 'color':
          if ([...args.positional, ...args.named.values()].some(isRaw)) return fail('var() in color module');
          return callSassColorModule(name, args) ?? fail('unknown');
        case 'map':
          if (name === 'get') return mapGet(args);
          return fail('unsupported map fn');
        case 'list':
          if (name === 'nth') return nth(args);
          return fail('unsupported list fn');
        case 'math':
          return mathFn(name, args);
        default:
          return fail('unsupported module');
      }
    }
    const found = this.moduleFunction(mod.entry, name, new Set());
    if (!found) return fail('unknown module function');
    return this.userFunction(found.entry, found.fn, this.args(n.args, sc), `${ns}.${name}`);
  }

  // -------------------------------------------------------------------------
  // Sass functions
  // -------------------------------------------------------------------------

  /** Finds a user @function visible from `entry` (own file, @import graph, @use as *). */
  private findFunction(entry: Entry, name: string, seen = new Set<string>()): { entry: Entry; fn: FnDef } | undefined {
    const key = normalizePath(entry.path);
    if (seen.has(key)) return undefined;
    seen.add(key);
    const own = entry.parsed.functions.filter((f) => f.name === name).pop();
    if (own) return { entry, fn: own };
    for (let i = 0; i < entry.parsed.imports.length; i++) {
      const rule = entry.parsed.imports[i]!;
      if (rule.kind === 'use' && rule.namespace !== null) continue;
      const target = this.project.targetEntry(entry, i);
      if (!target) continue;
      const r = rule.kind === 'import' ? this.findFunction(target, name, seen) : this.moduleFunction(target, name, seen);
      if (r) return r;
    }
    return undefined;
  }

  private moduleFunction(entry: Entry, name: string, seen: Set<string>): { entry: Entry; fn: FnDef } | undefined {
    if (/^[-_]/.test(name)) return undefined;
    const key = normalizePath(entry.path) + '#mod';
    if (seen.has(key)) return undefined;
    seen.add(key);
    const own = entry.parsed.functions.filter((f) => f.name === name && !f.private).pop();
    if (own) return { entry, fn: own };
    for (let i = 0; i < entry.parsed.imports.length; i++) {
      const rule = entry.parsed.imports[i]!;
      const target = this.project.targetEntry(entry, i);
      if (!target) continue;
      if (rule.kind === 'forward') {
        const inner = forwardedName(rule, name, false);
        if (inner === undefined) continue;
        const r = this.moduleFunction(target, inner, seen);
        if (r) return r;
      } else if (rule.kind === 'import') {
        const r = this.findFunction(target, name, seen);
        if (r) return r;
      }
    }
    return undefined;
  }

  private userFunction(entry: Entry, fn: FnDef, args: CallArgs, label: string): Value {
    if (fn.complex || !fn.ret) return fail('function too complex');
    const trace: Trace = { label: `${label}()`, loc: this.loc(entry, fn.line, fn.col), expr: fn.ret.value.trim(), children: [] };
    return this.enter(`fn:${entry.path}:${fn.start}:${this.depth}`, trace, () => {
      const locals = new Map<string, Value>();
      const sc: Scope = { entry, offset: fn.ret!.start, src: '', mode: 'sass', locals };
      if (args.positional.length > fn.params.length && !fn.params.some((p) => p.rest)) fail('too many args');
      fn.params.forEach((p, i) => {
        if (p.rest) {
          locals.set(p.name, { kind: 'list', sep: ',', items: args.positional.slice(i) });
          return;
        }
        let v = args.positional[i] ?? args.named.get(p.name);
        if (v === undefined && p.value !== undefined) {
          v = this.eval(parseExpression(p.value, 0, p.value.length, 'scss'), { ...sc, src: p.value });
        }
        if (v === undefined) fail(`missing argument $${p.name}`);
        locals.set(p.name, v!);
      });
      const node = parseExpression(fn.ret!.value, 0, fn.ret!.value.length, 'scss');
      return this.eval(node, { ...sc, src: fn.ret!.value });
    });
  }

  // -------------------------------------------------------------------------
  // Sass variables
  // -------------------------------------------------------------------------

  private namespace(entry: Entry, ns: string): { builtin: string } | { entry: Entry; rule: ImportRule; index: number } | undefined {
    const imports = entry.parsed.imports;
    for (let i = 0; i < imports.length; i++) {
      const rule = imports[i]!;
      if (rule.kind !== 'use') continue;
      const name = rule.namespace === undefined ? defaultNamespace(rule.url) : rule.namespace;
      if (name !== ns) continue;
      const t = this.project.target(entry, i);
      if (!t) return undefined;
      if ('builtin' in t) return t;
      const target = this.project.get(t.file);
      return target ? { entry: target, rule, index: i } : undefined;
    }
    // Lenient: built-in module used without an explicit @use.
    if (['color', 'math', 'map', 'list', 'string', 'meta', 'selector'].includes(ns)) return { builtin: ns };
    return undefined;
  }

  private innermostBlock(entry: Entry, offset: number): number {
    const blocks = entry.parsed.blocks;
    let best = 0;
    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i]!;
      if (b.start <= offset && offset <= b.end) best = i;
      else if (b.start > offset) break;
    }
    return best;
  }

  sassVar(ns: string | undefined, name: string, sc: Scope): Value {
    if (ns) {
      const mod = this.namespace(sc.entry, ns);
      if (!mod || 'builtin' in mod) return fail('unknown namespace');
      const config = this.useConfig(sc.entry, mod.rule);
      const w = this.moduleMember(mod.entry, name, config, new Set());
      if (!w) return fail(`undefined ${ns}.$${name}`);
      return this.evalWinner(w, `${ns}.$${name}`);
    }
    if (sc.locals?.has(name)) return sc.locals.get(name)!;

    // Local scopes (innermost block outwards).
    const entry = sc.entry;
    let b = this.innermostBlock(entry, sc.offset);
    while (b > 0) {
      const block = entry.parsed.blocks[b]!;
      if (block.params?.includes(name)) return fail('parameter');
      let local: VarDef | undefined;
      for (const def of entry.parsed.vars) {
        if (def.kind === 'sass' && def.block === b && def.name === name && def.start < sc.offset && !def.isGlobal) local = def;
      }
      if (local) {
        return this.evalWinner({ kind: 'def', entry, def: local, importCtx: sc.importCtx, config: sc.config }, `${name}`, sc.locals);
      }
      b = block.parent;
    }

    const memoKey = this.opts.trace || sc.locals || sc.config ? undefined : `s|${entry.path}|${name}|${sc.offset}|${sc.importCtx?.key ?? ''}|${this.opts.themeKey ?? ''}|${this.opts.scheme ?? ''}`;
    if (memoKey && this.memo.has(memoKey)) return this.memo.get(memoKey)!;
    const v = this.sassGlobal(entry, name, sc);
    if (memoKey) this.memo.set(memoKey, v);
    return v;
  }

  private sassGlobal(entry: Entry, name: string, sc: Scope): Value {
    // Top-level definitions. For an @imported file, first replay the importers up
    // to the @import (outermost first): they share one global scope, so !default
    // in the imported file must see assignments made before it was imported.
    const state: { winner?: Winner } = {};
    const configured = sc.config?.get(name);
    if (configured) state.winner = configured;
    const chain: ImportCtx[] = [];
    for (let c = sc.importCtx; c; c = c.parent) chain.unshift(c);
    for (const c of chain) this.fold(c.entry, name, c.offset, state, new Set(), c.parent, 0, sc.config);
    this.fold(entry, name, sc.offset, state, new Set(), sc.importCtx, 0, sc.config);
    // Mixin and function bodies may use globals defined later in the file.
    if (!state.winner) this.fold(entry, name, Infinity, state, new Set(), sc.importCtx, 0, sc.config);
    if (state.winner) return this.evalWinner(state.winner, `$${name}`);
    if (sc.importCtx) return fail(`undefined $${name}`);

    // Partials are compiled in the context of the files that @import them.
    const viaImporters = this.fromImporters(entry, name, 'sass', new Set(), 0);
    if (viaImporters !== undefined) return viaImporters;

    // Last resort: a unique workspace-wide definition (only for files not using the module system).
    if (entry.parsed.imports.some((r) => r.kind === 'use' && !r.url.startsWith('sass:'))) return fail(`undefined $${name}`);
    return this.workspaceFallback(entry, 'sass', name);
  }

  private fromImporters(entry: Entry, name: string, kind: 'sass' | 'less', seen: Set<string>, depth: number): Value | undefined {
    if (depth > 4) return undefined;
    const key = normalizePath(entry.path);
    if (seen.has(key)) return undefined;
    seen.add(key);
    const results: Value[] = [];
    for (const { entry: importer, rule } of this.project.importersOf(entry)) {
      const state: { winner?: Winner } = {};
      if (kind === 'sass') this.fold(importer, name, rule.start, state, new Set([key]), undefined, 0);
      else this.lessFold(importer, name, state, new Set([key]));
      let v: Value | undefined;
      try {
        if (state.winner) v = this.evalWinner(state.winner, kind === 'sass' ? `$${name}` : `@${name}`);
        else v = this.fromImporters(importer, name, kind, seen, depth + 1);
      } catch (e) {
        if (!(e instanceof Unresolved)) throw e;
      }
      if (v !== undefined) results.push(v);
    }
    if (!results.length) return undefined;
    if (results.every((r) => valuesEqual(r, results[0]!))) return results[0];
    return fail('ambiguous across importers');
  }

  private workspaceFallback(entry: Entry, kind: 'sass' | 'less', name: string): Value {
    let candidates = this.project.defsByName(kind, name).filter((c) => c.entry !== entry);
    if (!candidates.length) return fail(`undefined ${name}`);
    // A non-!default assignment always wins over !default ones, whatever the order.
    const strong = candidates.filter((c) => !c.def.isDefault);
    if (strong.length) candidates = strong;
    const values: Value[] = [];
    for (const c of candidates.slice(0, 8)) {
      try {
        values.push(
          this.evalWinner({ kind: 'def', entry: c.entry, def: c.def, note: 'found by workspace search' }, kind === 'sass' ? `$${name}` : `@${name}`),
        );
      } catch (e) {
        if (!(e instanceof Unresolved)) throw e;
        return fail('candidate unresolved');
      }
    }
    if (values.length && values.every((v) => valuesEqual(v, values[0]!))) return values[0]!;
    return fail('ambiguous workspace definition');
  }

  /**
   * Replays the top-level statements of `entry` (inlining @import) and records
   * the assignment that wins for `name`, honouring `!default`.
   */
  private fold(
    entry: Entry,
    name: string,
    upto: number,
    state: { winner?: Winner },
    seen: Set<string>,
    importCtx: ImportCtx | undefined,
    depth: number,
    config?: Config,
  ): void {
    const key = normalizePath(entry.path);
    if (seen.has(key) || depth > 32) return;
    seen.add(key);
    for (const st of this.project.statements(entry)) {
      if (st.type === 'def') {
        const def = st.def;
        if (def.start >= upto) break;
        if (def.kind !== 'sass' || def.name !== name) continue;
        if (def.isDefault && state.winner && !isNullWinner(state.winner)) continue;
        state.winner = { kind: 'def', entry, def, importCtx, config };
        continue;
      }
      const rule = st.rule;
      if (rule.start >= upto) break;
      if (rule.kind === 'import') {
        const target = this.project.targetEntry(entry, st.index);
        if (!target) continue;
        const ctx: ImportCtx = { entry, offset: rule.start, parent: importCtx, key: `${entry.path}@${rule.start}|${importCtx?.key ?? ''}` };
        this.fold(target, name, Infinity, state, seen, ctx, depth + 1, config);
      } else if ((rule.kind === 'use' && rule.namespace === null) || (rule.kind === 'forward' && depth > 0)) {
        if (state.winner) continue;
        const target = this.project.targetEntry(entry, st.index);
        if (!target) continue;
        let inner: string | undefined = name;
        if (rule.kind === 'forward') inner = forwardedName(rule, name, true);
        if (inner === undefined) continue;
        const config = rule.kind === 'use' ? this.useConfig(entry, rule) : undefined;
        const w = this.moduleMember(target, inner, config, new Set());
        if (w) state.winner = w;
      }
    }
  }

  private useConfig(entry: Entry, rule: ImportRule): Config | undefined {
    if (!rule.config?.length) return undefined;
    const map: Config = new Map();
    for (const c of rule.config) {
      map.set(c.name, {
        kind: 'config',
        entry,
        name: c.name,
        value: c.value,
        valueStart: c.valueStart,
        line: rule.line,
        note: `configured by @use … with() in ${baseName(entry.path)}`,
      });
    }
    return map;
  }

  /** Looks up a public member of a Sass module, following @forward rules. */
  private moduleMember(entry: Entry, name: string, config: Config | undefined, seen: Set<string>): Winner | undefined {
    if (/^[-_]/.test(name)) return undefined;
    const key = normalizePath(entry.path);
    if (seen.has(key)) return undefined;
    seen.add(key);
    const state: { winner?: Winner } = {};
    const configured = config?.get(name);
    if (configured) state.winner = configured;
    this.fold(entry, name, Infinity, state, new Set(), undefined, 0, config);
    if (state.winner) {
      // Private members are not visible from outside.
      if (state.winner.kind === 'def' && state.winner.def.private) return undefined;
      return state.winner;
    }
    const imports = entry.parsed.imports;
    for (let i = 0; i < imports.length; i++) {
      const rule = imports[i]!;
      if (rule.kind !== 'forward') continue;
      const inner = forwardedName(rule, name, true);
      if (inner === undefined) continue;
      const target = this.project.targetEntry(entry, i);
      if (!target) continue;
      const childConfig: Config = new Map();
      if (config) {
        for (const [k, w] of config) {
          const stripped = rule.prefix ? (k.startsWith(rule.prefix) ? k.slice(rule.prefix.length) : undefined) : k;
          if (stripped !== undefined) childConfig.set(stripped, w);
        }
      }
      for (const c of rule.config ?? []) {
        if (c.isDefault && childConfig.has(c.name)) continue;
        childConfig.set(c.name, {
          kind: 'config',
          entry,
          name: c.name,
          value: c.value,
          valueStart: c.valueStart,
          line: rule.line,
          note: `configured by @forward … with() in ${baseName(entry.path)}`,
        });
      }
      const w = this.moduleMember(target, inner, childConfig.size ? childConfig : undefined, seen);
      if (w) return w;
    }
    return undefined;
  }

  private evalWinner(w: Winner, label: string, locals?: Map<string, Value>): Value {
    if (w.kind === 'config') {
      const trace: Trace = { label, loc: this.loc(w.entry, w.line, 0), expr: w.value.trim(), note: w.note, children: [] };
      return this.enter(`cfg:${w.entry.path}:${w.valueStart}`, trace, () =>
        this.eval(parseExpression(w.value, 0, w.value.length, 'scss'), {
          entry: w.entry,
          offset: w.valueStart,
          src: w.value,
          mode: 'sass',
        }),
      );
    }
    const def = w.def;
    const trace: Trace = { label, loc: this.loc(w.entry, def.line, def.col), expr: def.value.trim(), note: w.note, children: [] };
    return this.enter(`def:${w.entry.path}:${def.start}`, trace, () => {
      let node = nodeCache.get(def);
      if (!node) {
        node = parseExpression(def.value, 0, def.value.length, exprModeOf(w.entry));
        nodeCache.set(def, node);
      }
      return this.eval(node, {
        entry: w.entry,
        offset: def.start,
        src: def.value,
        mode: modeOf(w.entry),
        locals,
        importCtx: w.importCtx,
        config: w.config,
      });
    });
  }

  // -------------------------------------------------------------------------
  // Less variables (lazy evaluation: the last definition in scope wins)
  // -------------------------------------------------------------------------

  private lessVar(name: string, sc: Scope): Value {
    const entry = sc.entry;
    let b = this.innermostBlock(entry, sc.offset);
    while (b > 0) {
      const block = entry.parsed.blocks[b]!;
      if (block.params?.includes(name)) return fail('parameter');
      let local: VarDef | undefined;
      for (const def of entry.parsed.vars) if (def.kind === 'less' && def.block === b && def.name === name) local = def;
      if (local) return this.evalWinner({ kind: 'def', entry, def: local }, `@${name}`);
      b = block.parent;
    }
    const state: { winner?: Winner } = {};
    this.lessFold(entry, name, state, new Set());
    let ctx = sc.importCtx;
    while (!state.winner && ctx) {
      this.lessFold(ctx.entry, name, state, new Set());
      ctx = ctx.parent;
    }
    if (state.winner) return this.evalWinner(state.winner, `@${name}`);
    const viaImporters = this.fromImporters(entry, name, 'less', new Set(), 0);
    if (viaImporters !== undefined) return viaImporters;
    return this.workspaceFallback(entry, 'less', name);
  }

  private lessFold(entry: Entry, name: string, state: { winner?: Winner }, seen: Set<string>, importCtx?: ImportCtx): void {
    const key = normalizePath(entry.path);
    if (seen.has(key)) return;
    seen.add(key);
    for (const st of this.project.statements(entry)) {
      if (st.type === 'def') {
        if (st.def.kind === 'less' && st.def.name === name) state.winner = { kind: 'def', entry, def: st.def, importCtx };
      } else if (st.rule.kind === 'import') {
        const target = this.project.targetEntry(entry, st.index);
        const ctx: ImportCtx = { entry, offset: st.rule.start, parent: importCtx, key: `${entry.path}@${st.rule.start}` };
        if (target) this.lessFold(target, name, state, seen, ctx);
      }
    }
  }

  // -------------------------------------------------------------------------
  // CSS custom properties
  // -------------------------------------------------------------------------

  /** Replaces `#{...}` (Sass) and `@{...}` (Less) interpolation in raw CSS text. */
  private interpolate(text: string, sc: Scope): string {
    if (sc.entry.parsed.syntax === 'less') {
      return text.replace(/@\{([\w-]+)\}/g, (_, name: string) => toCssText(this.lessVar(name, { ...sc, mode: 'less' })));
    }
    if (sc.entry.parsed.syntax === 'css' || !text.includes('#{')) return text;
    let out = '';
    let i = 0;
    for (;;) {
      const j = text.indexOf('#{', i);
      if (j < 0) break;
      let depth = 0;
      let k = j + 1;
      for (; k < text.length; k++) {
        if (text[k] === '{') depth++;
        else if (text[k] === '}' && --depth === 0) break;
      }
      if (k >= text.length) fail('unterminated interpolation');
      const inner = text.slice(j + 2, k);
      const v = this.eval(parseExpression(inner, 0, inner.length, 'scss'), { ...sc, src: inner, mode: 'sass' });
      out += text.slice(i, j) + (v.kind === 'string' ? v.value : toCssText(v));
      i = k + 1;
    }
    return out + text.slice(i);
  }

  /** Substitutes every `var(--x[, fallback])` in `text`, recursively. */
  private substitute(text: string, sc: Scope): string {
    let out = '';
    let i = 0;
    const re = /(?<![\w-])var\(/gi;
    for (;;) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (!m) break;
      const open = m.index + 3;
      const close = matchParen(text, open);
      if (close < 0) fail('unbalanced var()');
      const [[ns, ne], ...rest] = splitTopLevel(text, ',', open + 1, close);
      const name = text.slice(ns!, ne!).trim();
      if (!/^--[^\s,()]+$/.test(name)) fail('bad var() name');
      const fallback = rest.length ? text.slice(rest[0]![0], close) : undefined;
      out += text.slice(i, m.index) + this.cssVar(name, fallback, sc);
      i = close + 1;
    }
    return out + text.slice(i);
  }

  private cssVar(name: string, fallback: string | undefined, sc: Scope): string {
    this.touched.add(name);
    const found = this.findCssVar(name, sc);
    if (!found) {
      if (fallback === undefined) return fail(`undefined ${name}`);
      const trace: Trace = { label: name, note: 'not defined, using the fallback', expr: fallback.trim(), children: [] };
      return this.enter(`fb:${name}:${this.depth}`, trace, () => this.substitute(fallback, sc));
    }
    const { entry, def } = found;
    const trace: Trace = { label: name, loc: this.loc(entry, def.line, def.col), expr: def.value.trim(), children: [] };
    const ctxLabel = def.contexts?.find((c) => c.kind !== 'root');
    if (ctxLabel) trace.note = ctxLabel.label;
    return this.enter(`css:${entry.path}:${def.start}`, trace, () => {
      const inner: Scope = { entry, offset: def.start, src: def.value, mode: 'css' };
      return this.substitute(this.interpolate(def.value, { ...inner, mode: modeOf(entry) }), inner);
    });
  }

  /** All known definitions of a custom property: indexed/open files plus files reachable from `entry`. */
  cssDefs(name: string, entry: Entry): { entry: Entry; def: VarDef }[] {
    const out = this.project.defsByName('css', name);
    const seen = new Set(out.map((d) => `${normalizePath(d.entry.path)}:${d.def.start}`));
    for (const e of this.project.reachable(entry)) {
      if (e.indexed || e.overlay) continue;
      for (const def of e.parsed.vars) {
        if (def.kind !== 'css' || def.name !== name) continue;
        const k = `${normalizePath(e.path)}:${def.start}`;
        if (!seen.has(k)) {
          seen.add(k);
          out.push({ entry: e, def });
        }
      }
    }
    return out;
  }

  private findCssVar(name: string, sc: Scope): { entry: Entry; def: VarDef } | undefined {
    const entry = sc.entry;
    const key = this.opts.themeKey;
    // 1. Same element / ancestors in the same file (nested blocks). A root-level
    //    definition still loses against the requested theme, which targets the
    //    same element with a more specific selector.
    let sameBlock: { entry: Entry; def: VarDef } | undefined;
    let b = this.innermostBlock(entry, sc.offset);
    while (b > 0 && !sameBlock) {
      let hit: VarDef | undefined;
      for (const def of entry.parsed.vars) if (def.kind === 'css' && def.name === name && def.block === b) hit = def;
      if (hit) sameBlock = { entry, def: hit };
      b = entry.parsed.blocks[b]!.parent;
    }
    if (sameBlock && !(key && sameBlock.def.contexts?.some((c) => c.kind === 'root'))) return sameBlock;
    const all = this.cssDefs(name, entry);
    const reachable = new Set(this.project.reachable(entry).map((e) => normalizePath(e.path)));
    const pick = (cands: { entry: Entry; def: VarDef }[]): { entry: Entry; def: VarDef } | undefined => {
      if (!cands.length) return undefined;
      const local = cands.filter((c) => c.entry === entry);
      if (local.length) return local[local.length - 1];
      const near = cands.filter((c) => reachable.has(normalizePath(c.entry.path)));
      if (near.length) return near[near.length - 1];
      const first = cands[0]!;
      const same = cands.every((c) => c.def.value.trim() === first.def.value.trim());
      return same ? first : fail(`ambiguous ${name}`);
    };
    // 2. The requested theme variant.
    if (key) {
      const r = pick(all.filter((c) => c.def.contexts?.some((x) => x.key === key)));
      if (r) return r;
      if (sameBlock) return sameBlock;
    }
    // 3. Default (root-level) definitions, then 4. a unique scoped one.
    return (
      pick(all.filter((c) => c.def.contexts?.some((x) => x.kind === 'root'))) ??
      pick(all.filter((c) => c.def.contexts?.every((x) => x.kind === 'scoped')))
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KNOWN_SASS = new Set([
  'lighten', 'darken', 'saturate', 'desaturate', 'adjust-hue', 'opacify', 'fade-in', 'transparentize',
  'fade-out', 'mix', 'invert', 'grayscale', 'complement', 'adjust-color', 'scale-color', 'change-color',
  'red', 'green', 'blue', 'hue', 'saturation', 'lightness', 'alpha', 'opacity',
]);
const isRaw = (v: Value): boolean =>
  v.kind === 'raw' || (v.kind === 'list' && v.items.some(isRaw));

const isNullWinner = (w: Winner): boolean => w.kind === 'def' && w.def.value.trim() === 'null';

const baseName = (p: string): string => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);

function serializeCall(name: string, args: CallArgs): string {
  if (args.named.size) fail('keyword args in CSS function');
  return `${name}(${args.positional.map(toCssText).join(', ')})`;
}

function describe(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object' && 'kind' in v) {
    try {
      return toCssText(v as Value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function truthy(v: Value): boolean {
  return !(v.kind === 'null' || (v.kind === 'bool' && !v.value));
}

/**
 * Maps an externally visible member name through a @forward rule to the
 * forwarded module's name, or undefined if the rule doesn't expose it.
 * show/hide lists use the prefixed names; variables are written with `$`.
 */
export function forwardedName(rule: ImportRule, name: string, isVar: boolean): string | undefined {
  const ext = isVar ? '$' + name : name;
  if (rule.show && !rule.show.includes(ext)) return undefined;
  if (rule.hide?.includes(ext)) return undefined;
  if (rule.prefix) {
    if (!name.startsWith(rule.prefix)) return undefined;
    return name.slice(rule.prefix.length);
  }
  return name;
}

function mapGet(args: CallArgs): Value {
  let m = args.positional[0] ?? args.named.get('map');
  const keys = args.positional.slice(1);
  if (args.named.has('key')) keys.push(args.named.get('key')!);
  if (!keys.length) return fail('map.get needs a key');
  for (const k of keys) {
    if (!m || m.kind !== 'map') {
      // Sass treats an empty list as an empty map.
      if (m?.kind === 'list' && !m.items.length) return NULL;
      return fail('not a map');
    }
    const hit = m.entries.find(([mk]) => valuesEqual(mk, k));
    if (!hit) return NULL;
    m = hit[1];
  }
  return m!;
}

function nth(args: CallArgs): Value {
  const [list, n] = args.positional;
  const idx = asNumber(n).value;
  const items = list?.kind === 'list' ? list.items : list?.kind === 'map' ? list.entries.map(([k, v]) => ({ kind: 'list', sep: ' ', items: [k, v] }) as Value) : list ? [list] : [];
  const i = idx < 0 ? items.length + idx : idx - 1;
  return items[i] ?? fail('index out of range');
}

function mathFn(name: string, args: CallArgs): Value {
  const p = args.positional;
  const n0 = (): { value: number; unit: string } => asNumber(p[0]);
  switch (name) {
    case 'div': {
      const a = asNumber(p[0]);
      const b = asNumber(p[1]);
      if (b.unit && a.unit !== b.unit) return fail('unit division');
      return num(a.value / b.value, b.unit ? '' : a.unit);
    }
    case 'percentage':
      return num(n0().value * 100, '%');
    case 'round':
      return num(Math.round(n0().value), n0().unit);
    case 'ceil':
      return num(Math.ceil(n0().value), n0().unit);
    case 'floor':
      return num(Math.floor(n0().value), n0().unit);
    case 'abs':
      return num(Math.abs(n0().value), n0().unit);
    case 'min':
    case 'max': {
      const nums = p.map(asNumber);
      const units = new Set(nums.map((x) => x.unit).filter(Boolean));
      if (units.size > 1) return fail('mixed units');
      const f = name === 'min' ? Math.min : Math.max;
      return num(f(...nums.map((x) => x.value)), [...units][0] ?? '');
    }
    default:
      return fail('unsupported math fn');
  }
}

function arithmetic(op: string, l: Value, r: Value): Value {
  if (l.kind !== 'number' || r.kind !== 'number') return fail('non-numeric arithmetic');
  const unit = l.unit || r.unit;
  if (l.unit && r.unit && l.unit !== r.unit) return fail('incompatible units');
  switch (op) {
    case '+':
      return num(l.value + r.value, unit);
    case '-':
      return num(l.value - r.value, unit);
    case '*':
      if (l.unit && r.unit) return fail('unit product');
      return num(l.value * r.value, unit);
    case '%':
      return num(l.value % r.value, unit);
    default:
      return fail('unsupported operator');
  }
}

export function colorsEqual(a: Color, b: Color): boolean {
  return sameColor(a, b);
}
