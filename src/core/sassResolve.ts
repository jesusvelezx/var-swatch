/**
 * Resolves `@use` / `@forward` / `@import` URLs following dart-sass rules:
 * relative to the file, then load paths, partials (`_name`), index files,
 * `.import.scss` for @import, `pkg:` URLs and (like Vite/webpack) node_modules.
 */
import * as path from 'node:path';
import type { Syntax } from './text';

export interface Host {
  /** File contents, or undefined if unreadable. */
  readFile(file: string): string | undefined;
  isFile(file: string): boolean;
}

export type Resolved = { builtin: string } | { file: string };

export interface ResolveOptions {
  loadPaths: string[];
  /** Workspace roots, used to find node_modules for files outside any package. */
  roots: string[];
}

export type ImportKind = 'use' | 'forward' | 'import';

const SASS_EXTS = ['.scss', '.sass', '.css'];

export function defaultNamespace(url: string): string {
  const clean = url.replace(/^(?:pkg|sass):/, '').replace(/\/+$/, '');
  const last = clean.slice(clean.lastIndexOf('/') + 1);
  return last.replace(/^_/, '').split('.')[0]!;
}

export class SassResolver {
  constructor(
    private readonly host: Host,
    private readonly opts: ResolveOptions,
  ) {}

  private cache = new Map<string, Resolved | null>();

  /** Clears cached resolutions (call when files are created or deleted). */
  reset(): void {
    this.cache.clear();
  }

  resolve(url: string, from: string, kind: ImportKind, syntax: Syntax): Resolved | undefined {
    const key = `${kind}\0${syntax}\0${path.dirname(from)}\0${url}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    const r = this.doResolve(url, from, kind, syntax);
    this.cache.set(key, r ?? null);
    return r;
  }

  private doResolve(url: string, from: string, kind: ImportKind, syntax: Syntax): Resolved | undefined {
    if (url.startsWith('sass:')) return { builtin: url.slice(5) };
    if (/^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('data:')) return undefined;
    const dir = path.dirname(from);
    if (url.startsWith('pkg:')) {
      const file = this.resolvePkg(url.slice(4), dir);
      return file ? { file } : undefined;
    }
    const tryBase = syntax === 'less' ? (b: string) => this.tryLess(b) : (b: string) => this.trySass(b, kind);
    const webpack = url.startsWith('~');
    const u = webpack ? url.slice(1) : url;
    if (path.isAbsolute(u)) return wrap(tryBase(u));
    if (!webpack) {
      const local = tryBase(path.resolve(dir, u));
      if (local) return { file: local };
      for (const lp of this.opts.loadPaths) {
        const r = tryBase(path.resolve(lp, u));
        if (r) return { file: r };
      }
    }
    // Bare specifiers through node_modules (Vite / webpack behaviour).
    if (!u.startsWith('.')) {
      for (const nm of this.nodeModulesDirs(dir)) {
        const pkgFile = this.resolvePkgIn(nm, u);
        if (pkgFile) return { file: pkgFile };
        const r = tryBase(path.join(nm, u));
        if (r) return { file: r };
      }
    }
    return undefined;
  }

  private exists(file: string): boolean {
    return this.host.isFile(file);
  }

  private first(candidates: string[]): string | undefined {
    for (const c of candidates) if (this.exists(c)) return c;
    return undefined;
  }

  trySass(base: string, kind: ImportKind): string | undefined {
    const ext = path.extname(base).toLowerCase();
    const partial = (p: string): string => path.join(path.dirname(p), '_' + path.basename(p));
    if (SASS_EXTS.includes(ext)) return this.first([base, partial(base)]);
    const withExts = (b: string): string[] => {
      const out: string[] = [];
      if (kind === 'import') for (const e of ['.scss', '.sass']) out.push(`${b}.import${e}`, `${partial(b)}.import${e}`);
      for (const e of SASS_EXTS) out.push(b + e, partial(b) + e);
      return out;
    };
    return this.first(withExts(base)) ?? this.first(withExts(path.join(base, 'index')));
  }

  private tryLess(base: string): string | undefined {
    if (path.extname(base)) return this.first([base]);
    return this.first([base + '.less', base, base + '.css']);
  }

  private nodeModulesDirs(dir: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (start: string): void => {
      let d = start;
      for (;;) {
        const nm = path.join(d, 'node_modules');
        if (!seen.has(nm)) {
          seen.add(nm);
          out.push(nm);
        }
        const parent = path.dirname(d);
        if (parent === d) break;
        d = parent;
      }
    };
    walk(dir);
    for (const r of this.opts.roots) walk(r);
    return out;
  }

  private resolvePkg(spec: string, dir: string): string | undefined {
    for (const nm of this.nodeModulesDirs(dir)) {
      const r = this.resolvePkgIn(nm, spec, true);
      if (r) return r;
    }
    return undefined;
  }

  /**
   * Resolves `name[/subpath]` inside a node_modules directory using package.json
   * (`exports` with sass/style/default conditions, then `sass` / `style` fields).
   */
  private resolvePkgIn(nm: string, spec: string, pkgUrl = false): string | undefined {
    const parts = spec.split('/');
    const nameLen = spec.startsWith('@') ? 2 : 1;
    if (parts.length < nameLen) return undefined;
    const name = parts.slice(0, nameLen).join('/');
    const sub = parts.slice(nameLen).join('/');
    const pkgDir = path.join(nm, name);
    const json = this.host.readFile(path.join(pkgDir, 'package.json'));
    if (json === undefined) return undefined;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(json) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const fromExports = resolveExports(pkg.exports, sub ? `./${sub}` : '.');
    if (fromExports) {
      const target = path.resolve(pkgDir, fromExports);
      const r = this.exists(target) ? target : this.trySass(target, 'use');
      if (r) return r;
    }
    if (!sub) {
      for (const field of ['sass', 'style']) {
        const v = pkg[field];
        if (typeof v === 'string') {
          const target = path.resolve(pkgDir, v);
          if (this.exists(target)) return target;
        }
      }
      return pkgUrl ? this.trySass(path.join(pkgDir, 'index'), 'use') : undefined;
    }
    return pkgUrl ? this.trySass(path.join(pkgDir, sub), 'use') : undefined;
  }
}

const wrap = (file: string | undefined): Resolved | undefined => (file ? { file } : undefined);

const CONDITIONS = ['sass', 'style', 'default'];

function pickConditions(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) {
    for (const e of entry) {
      const r = pickConditions(e);
      if (r) return r;
    }
    return undefined;
  }
  if (entry && typeof entry === 'object') {
    const obj = entry as Record<string, unknown>;
    for (const c of CONDITIONS) if (c in obj) {
      const r = pickConditions(obj[c]);
      if (r) return r;
    }
  }
  return undefined;
}

function resolveExports(exports: unknown, subpath: string): string | undefined {
  if (exports === undefined || exports === null) return undefined;
  if (typeof exports === 'string' || Array.isArray(exports)) return subpath === '.' ? pickConditions(exports) : undefined;
  if (typeof exports !== 'object') return undefined;
  const obj = exports as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (!keys.some((k) => k.startsWith('.'))) return subpath === '.' ? pickConditions(obj) : undefined;
  if (subpath in obj) return pickConditions(obj[subpath]);
  // Single-wildcard patterns: "./*": "./scss/*.scss"
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star < 0) continue;
    const pre = key.slice(0, star);
    const post = key.slice(star + 1);
    if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= pre.length + post.length) {
      const match = subpath.slice(pre.length, subpath.length - post.length);
      const target = pickConditions(obj[key]);
      if (target) return target.replace(/\*/g, match);
    }
  }
  return undefined;
}
