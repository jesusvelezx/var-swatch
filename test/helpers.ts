import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Analyzer, type Swatch } from '../src/core/analyze';
import { type Color, toHex } from '../src/core/color/color';
import { Project, normalizePath } from '../src/core/project';
import type { Host } from '../src/core/sassResolve';

export const ROOT = path.resolve('/virtual/project');

/** An in-memory file system rooted at {@link ROOT}. */
export class MemoryHost implements Host {
  readonly files = new Map<string, string>();
  constructor(files: Record<string, string> = {}) {
    for (const [rel, text] of Object.entries(files)) this.files.set(normalizePath(path.resolve(ROOT, rel)), text);
  }
  readFile(file: string): string | undefined {
    return this.files.get(normalizePath(file));
  }
  isFile(file: string): boolean {
    return this.files.has(normalizePath(file));
  }
}

export const nodeHost: Host = {
  readFile(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  isFile(file) {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
};

export interface Fixture {
  project: Project;
  analyzer: Analyzer;
  host: Host;
  root: string;
  /** Opens a document and returns its swatches. */
  swatches(rel: string): SwatchInfo[];
  file(rel: string): string;
}

export interface SwatchInfo {
  text: string;
  hex: string;
  color: Color;
  variants: { label: string; hex: string }[];
  raw: Swatch;
}

export function fixture(
  files: Record<string, string>,
  opts: { index?: boolean; themes?: boolean; literals?: boolean; host?: Host; root?: string; loadPaths?: string[] } = {},
): Fixture {
  const root = opts.root ?? ROOT;
  const host = opts.host ?? new MemoryHost(files);
  const project = new Project(host, { loadPaths: (opts.loadPaths ?? []).map((p) => path.resolve(root, p)), roots: [root] });
  if (opts.index !== false) {
    for (const rel of Object.keys(files)) {
      const file = path.resolve(root, rel);
      const text = host.readFile(file);
      if (text !== undefined) project.index(file, text);
    }
  }
  const analyzer = new Analyzer(project, { themes: opts.themes ?? true, literals: opts.literals ?? false });
  return {
    project,
    analyzer,
    host,
    root,
    file: (rel) => path.resolve(root, rel),
    swatches(rel) {
      const file = path.resolve(root, rel);
      const text = host.readFile(file) ?? files[rel];
      if (text === undefined) throw new Error(`no file ${rel}`);
      const entry = project.open(file, text)!;
      return analyzer.analyze(entry).map((s) => ({
        text: text.slice(s.start, s.end),
        hex: toHex(s.color),
        color: s.color,
        variants: s.variants.map((v) => ({ label: v.label, hex: toHex(v.color) })),
        raw: s,
      }));
    },
  };
}

/** Writes files into a fresh temp directory (for comparisons against real dart-sass). */
export function tempProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'var-swatch-'));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return dir;
}

/** Maps `text → hex` for quick assertions. */
export function byText(list: SwatchInfo[]): Record<string, string> {
  return Object.fromEntries(list.map((s) => [s.text, s.hex]));
}
