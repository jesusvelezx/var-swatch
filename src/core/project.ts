/**
 * The workspace model: parsed files (indexed, open overlays, and files loaded
 * on demand through imports), global lookup tables and the import graph.
 * Updates are incremental: changing one file only touches that file's entries.
 */
import * as path from 'node:path';
import { type ImportRule, type ParsedFile, type VarDef, parseEmbedded, parseStylesheet } from './parse';
import { type Host, type Resolved, type ResolveOptions, SassResolver } from './sassResolve';
import { type Syntax, syntaxFromPath } from './text';

export interface Entry {
  path: string;
  parsed: ParsedFile;
  /** Comment-masked source text; only kept for open documents (overlays). */
  text?: string;
  overlay: boolean;
  indexed: boolean;
  /** Top-level statements (global var defs and imports) in source order. */
  statements?: Statement[];
  resolved?: { gen: number; targets: (Resolved | undefined)[] };
}

export type Statement = { type: 'def'; def: VarDef } | { type: 'import'; rule: ImportRule; index: number };

export interface ProjectOptions extends ResolveOptions {}

export function normalizePath(p: string): string {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

export function parseFile(file: string, text: string, sites: boolean): ParsedFile | undefined {
  const syntax = syntaxFromPath(file);
  if (!syntax) return undefined;
  if (syntax === 'embedded') return parseEmbedded(text, { sites });
  return parseStylesheet(text, syntax, { sites });
}

export class Project {
  private readonly entries = new Map<string, Entry>();
  /** CSS custom properties / Sass / Less globals by name, from indexed and open files. */
  private readonly byName = new Map<string, Map<string, VarDef[]>>();
  readonly resolver: SassResolver;
  /** Bumped on every change; caches compare against it. */
  gen = 0;
  private importersCache?: { gen: number; map: Map<string, { entry: Entry; rule: ImportRule }[]> };
  private reachableCache = new Map<string, { gen: number; set: Entry[] }>();

  constructor(
    readonly host: Host,
    private opts: ProjectOptions,
  ) {
    this.resolver = new SassResolver(host, opts);
  }

  setOptions(opts: ProjectOptions): void {
    this.opts = opts;
    (this as { resolver: SassResolver }).resolver = new SassResolver(this.host, opts);
    this.gen++;
  }

  get options(): ProjectOptions {
    return this.opts;
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** Adds or refreshes a workspace file from disk content. */
  index(file: string, text: string): void {
    const key = normalizePath(file);
    const prev = this.entries.get(key);
    if (prev?.overlay) {
      prev.indexed = true;
      return;
    }
    const parsed = parseFile(file, text, false);
    if (!parsed) return;
    this.replace(key, { path: path.resolve(file), parsed, overlay: false, indexed: true });
  }

  /** Sets the live content of an open document. */
  setOverlay(file: string, parsed: ParsedFile): Entry {
    const key = normalizePath(file);
    const prev = this.entries.get(key);
    const entry: Entry = { path: path.resolve(file), parsed, text: parsed.masked ?? '', overlay: true, indexed: prev?.indexed ?? false };
    this.replace(key, entry);
    return entry;
  }

  /** Parses and registers an open document. */
  open(file: string, text: string): Entry | undefined {
    const parsed = parseFile(file, text, true);
    return parsed ? this.setOverlay(file, parsed) : undefined;
  }

  /** The document was closed: fall back to disk content. */
  closeOverlay(file: string): void {
    const key = normalizePath(file);
    const prev = this.entries.get(key);
    if (!prev?.overlay) return;
    this.drop(key);
    if (prev.indexed) {
      const text = this.host.readFile(prev.path);
      if (text !== undefined) this.index(prev.path, text);
    }
  }

  /** A file changed on disk. */
  changed(file: string): void {
    const key = normalizePath(file);
    const prev = this.entries.get(key);
    if (prev?.overlay) return;
    if (prev?.indexed) {
      const text = this.host.readFile(prev.path);
      if (text !== undefined) this.index(prev.path, text);
      else this.drop(key);
    } else if (prev) {
      this.drop(key);
    }
  }

  /** A file was created: resolution results may change. */
  created(file: string, text: string | undefined, indexIt: boolean): void {
    this.resolver.reset();
    if (indexIt && text !== undefined) this.index(file, text);
    else this.gen++;
  }

  deleted(file: string): void {
    this.resolver.reset();
    this.drop(normalizePath(file));
    this.gen++;
  }

  clear(): void {
    this.entries.clear();
    this.byName.clear();
    this.resolver.reset();
    this.reachableCache.clear();
    this.gen++;
  }

  private replace(key: string, entry: Entry): void {
    this.drop(key);
    this.entries.set(key, entry);
    if (entry.indexed || entry.overlay) this.addNames(entry);
    this.gen++;
  }

  private drop(key: string): void {
    const prev = this.entries.get(key);
    if (!prev) return;
    this.entries.delete(key);
    if (prev.indexed || prev.overlay) this.removeNames(prev);
    this.gen++;
  }

  private nameKey(def: VarDef): string {
    return `${def.kind}:${def.name}`;
  }

  private addNames(entry: Entry): void {
    for (const def of entry.parsed.vars) {
      if (def.kind !== 'css' && def.block !== 0 && !def.isGlobal) continue;
      const k = this.nameKey(def);
      let byFile = this.byName.get(k);
      if (!byFile) this.byName.set(k, (byFile = new Map()));
      const list = byFile.get(entry.path);
      if (list) list.push(def);
      else byFile.set(entry.path, [def]);
    }
  }

  private removeNames(entry: Entry): void {
    for (const def of entry.parsed.vars) {
      const k = this.nameKey(def);
      const byFile = this.byName.get(k);
      if (!byFile) continue;
      byFile.delete(entry.path);
      if (!byFile.size) this.byName.delete(k);
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Returns the entry for a file, loading (but not indexing) it on demand. */
  get(file: string): Entry | undefined {
    const key = normalizePath(file);
    const hit = this.entries.get(key);
    if (hit) return hit;
    const text = this.host.readFile(file);
    if (text === undefined) return undefined;
    const parsed = parseFile(file, text, false);
    if (!parsed) return undefined;
    const entry: Entry = { path: path.resolve(file), parsed, overlay: false, indexed: false };
    this.entries.set(key, entry);
    return entry;
  }

  /** Global definitions of a variable across indexed and open files. */
  defsByName(kind: VarDef['kind'], name: string): { entry: Entry; def: VarDef }[] {
    const byFile = this.byName.get(`${kind}:${name}`);
    if (!byFile) return [];
    const out: { entry: Entry; def: VarDef }[] = [];
    for (const [file, defs] of byFile) {
      const entry = this.entries.get(normalizePath(file));
      if (!entry) continue;
      for (const def of defs) out.push({ entry, def });
    }
    return out;
  }

  get size(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.indexed) n++;
    return n;
  }

  statements(entry: Entry): Statement[] {
    if (entry.statements) return entry.statements;
    const out: Statement[] = [];
    for (const def of entry.parsed.vars) {
      if (def.kind === 'css') continue;
      if (def.block === 0 || def.isGlobal) out.push({ type: 'def', def });
    }
    entry.parsed.imports.forEach((rule, index) => out.push({ type: 'import', rule, index }));
    out.sort((a, b) => start(a) - start(b));
    entry.statements = out;
    return out;
  }

  /** Resolution of the `index`-th import rule of an entry. */
  target(entry: Entry, index: number): Resolved | undefined {
    if (!entry.resolved || entry.resolved.gen !== this.gen) {
      entry.resolved = {
        gen: this.gen,
        targets: entry.parsed.imports.map((rule) => this.resolveRule(entry, rule)),
      };
    }
    return entry.resolved.targets[index];
  }

  private resolveRule(entry: Entry, rule: ImportRule): Resolved | undefined {
    const syntax: Syntax = entry.parsed.syntax;
    if (rule.kind === 'import' && rule.plainCss && /^url\(|^(?:https?:)?\/\//i.test(rule.url)) return undefined;
    return this.resolver.resolve(rule.url, entry.path, rule.kind, syntax);
  }

  targetEntry(entry: Entry, index: number): Entry | undefined {
    const t = this.target(entry, index);
    return t && 'file' in t ? this.get(t.file) : undefined;
  }

  /** Files that `@import` the given file (Sass/Less/CSS import, not @use). */
  importersOf(entry: Entry): { entry: Entry; rule: ImportRule }[] {
    if (!this.importersCache || this.importersCache.gen !== this.gen) {
      const map = new Map<string, { entry: Entry; rule: ImportRule }[]>();
      for (const e of [...this.entries.values()]) {
        if (!e.indexed && !e.overlay) continue;
        e.parsed.imports.forEach((rule, i) => {
          if (rule.kind !== 'import') return;
          const t = this.target(e, i);
          if (!t || !('file' in t)) return;
          const k = normalizePath(t.file);
          const list = map.get(k) ?? [];
          list.push({ entry: e, rule });
          map.set(k, list);
        });
      }
      this.importersCache = { gen: this.gen, map };
    }
    return this.importersCache.map.get(normalizePath(entry.path)) ?? [];
  }

  /** The entry plus every file reachable from it through imports, in load order. */
  reachable(entry: Entry): Entry[] {
    const key = normalizePath(entry.path);
    const hit = this.reachableCache.get(key);
    if (hit && hit.gen === this.gen) return hit.set;
    const out: Entry[] = [];
    const seen = new Set<string>();
    const visit = (e: Entry, depth: number): void => {
      const k = normalizePath(e.path);
      if (seen.has(k) || depth > 32 || out.length > 2000) return;
      seen.add(k);
      e.parsed.imports.forEach((_, i) => {
        const child = this.targetEntry(e, i);
        if (child) visit(child, depth + 1);
      });
      out.push(e);
    };
    visit(entry, 0);
    this.reachableCache.set(key, { gen: this.gen, set: out });
    return out;
  }
}

const start = (s: Statement): number => (s.type === 'def' ? s.def.start : s.rule.start);
