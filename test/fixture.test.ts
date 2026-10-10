import * as fs from 'node:fs';
import * as path from 'node:path';
import * as sass from 'sass';
import { describe, expect, it } from 'vitest';
import { fixture, nodeHost } from './helpers';

const DEMO = path.resolve(__dirname, '../fixtures/demo-project');

function walk(dir: string, out: Record<string, string> = {}): Record<string, string> {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name !== 'node_modules' && name !== '.vscode') walk(full, out);
    } else if (/\.(css|scss|sass|less|vue|svelte|astro|html)$/.test(name)) {
      out[path.relative(DEMO, full).replace(/\\/g, '/')] = fs.readFileSync(full, 'utf8');
    }
  }
  return out;
}

const files = walk(DEMO);
const demo = () => fixture(files, { host: nodeHost, root: DEMO });

/** `selector → property → value` from compiled CSS. */
function compiled(rel: string): Map<string, string> {
  const css = sass.compile(path.join(DEMO, rel), {
    importers: [new sass.NodePackageImporter(DEMO)],
    logger: sass.Logger.silent,
  }).css;
  const out = new Map<string, string>();
  for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = rule[1]!.trim();
    for (const decl of rule[2]!.split(';')) {
      const m = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/s.exec(decl);
      if (m) out.set(`${sel} ${m[1]}`, m[2]!);
    }
  }
  return out;
}

const hexOf = (value: string): string => fixture({ 'x.css': `a { color: ${value}; }` }, { literals: true }).swatches('x.css')[0]!.hex;

describe('demo project', () => {
  it('styles/main.scss matches dart-sass for every color declaration', () => {
    const f = demo();
    const swatches = f.swatches('styles/main.scss');
    const css = compiled('styles/main.scss');
    const text = files['styles/main.scss']!;
    let checked = 0;
    let selector = '';
    for (const line of text.split('\n')) {
      const sel = /^([.:][\w-]+) \{/.exec(line);
      if (sel) selector = sel[1]!;
      const decl = /^\s+([\w-]+): (.+);/.exec(line);
      if (!decl || selector.startsWith(':')) continue;
      const expr = decl[2]!.replace(/\s*\/\/.*$/, '');
      const expected = css.get(`${selector} ${decl[1]}`);
      if (!expected || expected.includes('var(')) continue;
      const ours = swatches.find((s) => s.text === expr.replace(/;$/, ''));
      expect(ours, `${selector} ${decl[1]}: ${expr}`).toBeDefined();
      expect(ours!.hex, `${selector} ${decl[1]}: ${expr} → ${expected}`).toBe(hexOf(expected));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(15);
  });

  it('never shows a swatch for unresolvable values', () => {
    const f = demo();
    const main = f.swatches('styles/main.scss').map((s) => s.text);
    expect(main).not.toContain('$c');
    expect(main.filter((t) => t === '$brand')).toHaveLength(1); // .chains only, not --not-evaluated
    expect(f.swatches('css/app.css').map((s) => s.text)).not.toContain('var(--not-defined-anywhere)');
  });

  it('resolves the legacy partial through its importer', () => {
    const f = demo();
    const s = Object.fromEntries(f.swatches('styles/legacy/_buttons.scss').map((x) => [x.text, x.hex]));
    expect(s).toEqual({ '$primary': '#7c3aed', 'darken($primary, 7.5%)': hexOf(compiled('styles/legacy/main.scss').get('.btn-primary border-color')!), '$link-color': '#7c3aed' });
  });

  it('shows theme variants for CSS custom properties', () => {
    const f = demo();
    const button = f.swatches('css/app.css').find((s) => s.text === 'var(--primary)')!;
    expect(button.hex).toBe('#7c3aed');
    expect(button.variants.map((v) => [v.label, v.hex])).toEqual([
      ['[data-theme="dark"]', '#a78bfa'],
      ['html.high-contrast', '#5b21b6'],
      ['@media (prefers-color-scheme: dark)', '#c4b5fd'],
    ]);
    const surface = f.swatches('css/app.css').find((s) => s.text === 'var(--surface)')!;
    expect(surface.hex).toBe('#ffffff');
    expect(surface.variants.map((v) => v.hex)).toContain('#0b1020');
  });

  it('covers Less, indented Sass and embedded styles', () => {
    const f = demo();
    expect(f.swatches('less/theme.less').map((s) => s.text)).toEqual(['@purple', 'darken(@brand, 10%)', '@brand', 'fade(@brand, 15%)', '@brand-hover', 'spin(@brand, 30)']);
    expect(f.swatches('sass/indented.sass').map((s) => s.text)).toEqual(['lighten(t.$purple, 15%)', '$accent', 'rgba(t.$green, .2)', 't.$amber']);
    expect(f.swatches('components/Card.vue').map((s) => s.text)).toEqual(['var(--accent)', 't.$purple', 'rgba(t.$green, .1)', 'var(--primary)']);
    expect(f.swatches('components/Button.svelte').map((s) => s.text)).toEqual(['brand.$brand-purple', 'var(--surface)']);
    expect(f.swatches('pages/index.astro').map((s) => s.text)).toEqual(['var(--primary)', 'color-mix(in srgb, var(--green), black 20%)']);
    expect(f.swatches('index.html').map((s) => s.text)).toEqual(['var(--surface)', 'var(--primary)', 'var(--accent)']);
  });
});
