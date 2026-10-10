import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHover, chainLines, type HoverLinks } from '../src/core/hover';
import { fixture } from './helpers';

const links: HoverLinks = {
  link: (loc) => `file://${path.basename(loc.path)}#L${loc.line + 1}`,
  relative: (p) => path.basename(p),
};

function explain(files: Record<string, string>, rel: string, text: string) {
  const f = fixture(files);
  const s = f.swatches(rel).find((x) => x.text === text)!;
  expect(s, text).toBeDefined();
  const entry = f.project.get(f.file(rel))!;
  return f.analyzer.explain(entry, s.raw.target)!;
}

describe('hover', () => {
  it('shows the chain $brand → $purple → value with links', () => {
    const ex = explain(
      { '_colors.scss': `$purple: #7c3aed;`, 'a.scss': `@import 'colors';\n$brand: $purple;\na { color: $brand; }` },
      'a.scss',
      '$brand',
    );
    const { main } = chainLines(ex, links);
    expect(main).toBe('[`$brand`](file://a.scss#L2) → [`$purple`](file://_colors.scss#L1) → `#7c3aed`');
  });

  it('shows expressions and where each input comes from', () => {
    const ex = explain(
      { 'a.scss': `$purple: #7c3aed;\n$brand: $purple;\n$hover: darken($brand, 10%);\na { color: $hover; }` },
      'a.scss',
      '$hover',
    );
    const { main, via } = chainLines(ex, links);
    expect(main).toBe('[`$hover`](file://a.scss#L3) → `darken($brand, 10%)` → `#5f14e0`');
    expect(via).toEqual(['[`$brand`](file://a.scss#L2) → [`$purple`](file://a.scss#L1) → `#7c3aed`']);
  });

  it('follows CSS custom property chains and reports fallbacks', () => {
    const ex = explain(
      { 'a.css': `:root { --purple: #7c3aed; --primary: var(--purple); }\n.a { color: var(--primary); border-color: var(--nope, var(--purple)); }` },
      'a.css',
      'var(--primary)',
    );
    expect(chainLines(ex, links).main).toBe('[`--primary`](file://a.css#L1) → [`--purple`](file://a.css#L1) → `#7c3aed`');
    const fb = explain({ 'a.css': `:root { --purple: #7c3aed; }\n.a { color: var(--nope, var(--purple)); }` }, 'a.css', 'var(--nope, var(--purple))');
    const lines = chainLines(fb, links);
    expect(lines.notes).toContain('`--nope` — not defined, using the fallback');
  });

  it('includes contrast, theme variants and the definition link', () => {
    const ex = explain(
      { 'a.css': `:root { --c: #7c3aed; }\n[data-theme=dark] { --c: #a78bfa; }\n.a { color: var(--c); }` },
      'a.css',
      'var(--c)',
    );
    const md = buildHover(ex, links);
    expect(md).toContain('**#7c3aed**');
    expect(md).toContain('| on white | 5.70:1 | ✓ AA |');
    expect(md).toContain('| on black | 3.69:1 | ✓ AA Large |');
    expect(md).toContain('`#a78bfa` — `[data-theme=dark]`');
    expect(md).toContain('Defined in [a.css:1](file://a.css#L1)');
  });

  it('notes values configured through @use with()', () => {
    const ex = explain(
      { '_lib.scss': `$primary: #0000ff !default;`, 'a.scss': `@use 'lib' with ($primary: #7c3aed);\na { color: lib.$primary; }` },
      'a.scss',
      'lib.$primary',
    );
    expect(chainLines(ex, links).notes[0]).toContain('configured by @use … with() in a.scss');
  });
});
