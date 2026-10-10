import * as path from 'node:path';
import * as sass from 'sass';
import { describe, expect, it } from 'vitest';
import { byText, fixture, nodeHost, tempProject } from './helpers';

describe('MVP: CSS custom properties', () => {
  it('resolves same-file definitions and chains', () => {
    const f = fixture({
      'a.css': `:root { --purple: #7c3aed; --primary: var(--purple); }
.btn { background: var(--purple); color: var(--primary); border: 1px solid var(--primary); }`,
    });
    const s = f.swatches('a.css');
    expect(s.map((x) => [x.text, x.hex])).toEqual([
      ['var(--purple)', '#7c3aed'],
      ['var(--purple)', '#7c3aed'],
      ['var(--primary)', '#7c3aed'],
      ['var(--primary)', '#7c3aed'],
    ]);
  });

  it('resolves definitions from other workspace files', () => {
    const f = fixture({
      'tokens.css': `:root { --brand: #10b981; }`,
      'app.css': `.a { color: var(--brand); }`,
    });
    expect(byText(f.swatches('app.css'))).toEqual({ 'var(--brand)': '#10b981' });
  });

  it('uses fallbacks', () => {
    const f = fixture({
      'a.css': `:root { --y: #ff0000; }
.a { color: var(--missing, #fff); }
.b { color: var(--missing, var(--y)); }
.c { color: var(--missing, var(--also-missing, #00ff00)); }
.d { color: var(--missing); }`,
    });
    expect(f.swatches('a.css').map((x) => x.hex)).toEqual(['#ffffff', '#ff0000', '#00ff00']);
  });

  it('substitutes var() textually like browsers do (Bootstrap rgb channels)', () => {
    const f = fixture({
      'a.css': `:root { --bs-primary-rgb: 13, 110, 253; --bs-bg-opacity: 0.5; }
.a { background-color: rgba(var(--bs-primary-rgb), var(--bs-bg-opacity)); }
.b { color: rgb(var(--bs-primary-rgb)); }`,
    });
    expect(f.swatches('a.css').map((x) => x.hex)).toEqual(['#0d6efd80', '#0d6efd']);
  });

  it('prefers the definition in the same rule', () => {
    const f = fixture({
      'a.css': `:root { --c: #000000; }
.card { --c: #ff0000; color: var(--c); }
.other { color: var(--c); }`,
    });
    expect(f.swatches('a.css').map((x) => x.hex)).toEqual(['#ff0000', '#000000']);
  });

  it('resolves color-mix() and light-dark() with variables', () => {
    const f = fixture({
      'a.css': `:root { --a: #ff0000; --b: #0000ff; }
.x { color: color-mix(in srgb, var(--a) 25%, var(--b)); }
.y { color: light-dark(var(--a), var(--b)); }`,
    });
    const s = f.swatches('a.css');
    expect(s[0]!.hex).toBe('#4000bf');
    expect(s[1]!.hex).toBe('#ff0000');
    expect(s[1]!.variants).toEqual([{ label: 'light-dark() · dark', hex: '#0000ff' }]);
  });
});

describe('never shows a fake color', () => {
  it('shows nothing for unresolvable values', () => {
    const f = fixture({
      'a.scss': `@mixin m($c) { color: $c; }
.a { color: $undefined; }
.b { color: var(--undefined); }
.c { color: currentColor; }
.d { width: $size; }
$size: 10px;
.e { color: calc(var(--x) + 1); }
.f { color: darken(var(--purple), 10%); }
:root { --purple: #7c3aed; }
.g { --bad: $size; }`,
    });
    // darken() can't take var(): only the (real) color of the inner var() is shown.
    expect(f.swatches('a.scss').map((x) => x.text)).toEqual(['var(--purple)']);
  });

  it('shows nothing when workspace definitions are ambiguous', () => {
    const f = fixture({
      'a/tokens.css': `:root { --brand: #ff0000; }`,
      'b/tokens.css': `:root { --brand: #0000ff; }`,
      'app.css': `.a { color: var(--brand); }`,
    });
    expect(f.swatches('app.css')).toEqual([]);
  });

  it('detects cycles', () => {
    const f = fixture({ 'a.css': `:root { --a: var(--b); --b: var(--a); } .x { color: var(--a); }` });
    expect(f.swatches('a.css')).toEqual([]);
  });
});

describe('MVP: Sass variables', () => {
  it('resolves same-file variables, chains and local scopes', () => {
    const f = fixture({
      'a.scss': `$purple: #7c3aed;
$brand: $purple;
.a { color: $brand; }
.b { $brand: #10b981; color: $brand; }
.c { color: $brand; }`,
    });
    expect(f.swatches('a.scss').map((x) => [x.text, x.hex])).toEqual([
      ['$purple', '#7c3aed'],
      ['$brand', '#7c3aed'],
      ['$brand', '#10b981'],
      ['$brand', '#7c3aed'],
    ]);
  });

  it('follows @import with partials and !default', () => {
    const f = fixture({
      'styles/_colors.scss': `$purple: #7c3aed !default;\n$brand: $purple !default;`,
      'styles/main.scss': `$purple: #ff0000;\n@import 'colors';\n.a { color: $brand; }`,
    });
    expect(byText(f.swatches('styles/main.scss'))).toEqual({ '$brand': '#ff0000' });
  });

  it('resolves a partial in the context of the file that imports it', () => {
    const f = fixture({
      '_vars.scss': `$primary: #7c3aed;`,
      '_buttons.scss': `.btn { background: $primary; }`,
      'main.scss': `@import 'vars';\n@import 'buttons';`,
    });
    expect(byText(f.swatches('_buttons.scss'))).toEqual({ '$primary': '#7c3aed' });
  });

  it('falls back to a unique workspace definition for orphan partials', () => {
    const f = fixture({
      '_vars.scss': `$primary: #7c3aed !default;`,
      '_theme.scss': `$primary: #10b981;`,
      '_orphan.scss': `.x { color: $primary; }`,
    });
    // The non-!default assignment wins whatever the import order.
    expect(byText(f.swatches('_orphan.scss'))).toEqual({ '$primary': '#10b981' });
  });

  it('evaluates Sass color functions over variables', () => {
    const f = fixture({
      'a.scss': `@use 'sass:color';
$brand: #7c3aed;
.a { color: darken($brand, 10%); background: rgba($brand, .5); border-color: color.adjust($brand, $lightness: 10%); }
.b { box-shadow: 0 0 0 3px rgba($brand, .25), inset 0 1px mix($brand, #fff, 20%); }`,
    });
    const s = f.swatches('a.scss');
    expect(s.map((x) => x.text)).toEqual([
      'darken($brand, 10%)',
      'rgba($brand, .5)',
      'color.adjust($brand, $lightness: 10%)',
      'rgba($brand, .25)',
      'mix($brand, #fff, 20%)',
    ]);
    expect(s[0]!.hex).toBe('#5f14e0'); // dart-sass: rgb(37.38%, 8.01%, 87.68%)
    expect(s[1]!.hex).toBe('#7c3aed80');
  });

  it('evaluates user @functions and maps', () => {
    const f = fixture({
      'a.scss': `@use 'sass:map';
@function tint-color($color, $weight) { @return mix(white, $color, $weight); }
$theme-colors: (primary: #7c3aed, "danger": #dc3545);
.a { color: tint-color(map.get($theme-colors, primary), 20%); }
.b { color: map-get($theme-colors, "danger"); }
.c { color: map.get($theme-colors, missing); }`,
    });
    const s = byText(f.swatches('a.scss'));
    expect(s['map-get($theme-colors, "danger")']).toBe('#dc3545');
    expect(s['tint-color(map.get($theme-colors, primary), 20%)']).toBeDefined();
    // map.get() of a missing key is null: nothing is shown for .c
    expect(Object.keys(s)).toHaveLength(2);
  });

  it('only interpolation is evaluated inside custom properties', () => {
    const f = fixture({
      'a.scss': `$purple: #7c3aed;\n:root { --brand: #{$purple}; --raw: $purple; }\n.a { color: var(--brand); }`,
    });
    expect(f.swatches('a.scss').map((x) => [x.text, x.hex])).toEqual([
      ['#{$purple}', '#7c3aed'],
      ['var(--brand)', '#7c3aed'],
    ]);
  });
});

describe('Sass modules', () => {
  it('@use with namespaces, default namespaces and as *', () => {
    const f = fixture({
      'tokens/_colors.scss': `$purple: #7c3aed;\n$-secret: #000;`,
      'a.scss': `@use 'tokens/colors';\n@use 'tokens/colors' as c;\n.a { color: colors.$purple; background: c.$purple; outline-color: c.$-secret; }`,
      'b.scss': `@use 'tokens/colors' as *;\n.b { color: $purple; }`,
    });
    expect(f.swatches('a.scss').map((x) => x.text)).toEqual(['colors.$purple', 'c.$purple']);
    expect(byText(f.swatches('b.scss'))).toEqual({ '$purple': '#7c3aed' });
  });

  it('@forward with prefix, show and hide', () => {
    const f = fixture({
      '_colors.scss': `$purple: #7c3aed;\n$green: #10b981;`,
      '_brand.scss': `@forward 'colors' as brand-* hide $brand-green;`,
      '_only.scss': `@forward 'colors' show $green;`,
      'a.scss': `@use 'brand';\n@use 'only';\n.a { color: brand.$brand-purple; background: brand.$brand-green; border-color: only.$green; outline-color: only.$purple; }`,
    });
    expect(byText(f.swatches('a.scss'))).toEqual({ 'brand.$brand-purple': '#7c3aed', 'only.$green': '#10b981' });
  });

  it('@use ... with() configures !default variables, also through @forward', () => {
    const f = fixture({
      '_lib.scss': `$primary: #0000ff !default;\n$accent: $primary;`,
      '_index-lib.scss': `@forward 'lib' as lib-*;`,
      'a.scss': `@use 'lib' with ($primary: #7c3aed);\n.a { color: lib.$accent; }`,
      'b.scss': `@use 'index-lib' as x with ($lib-primary: #10b981);\n.b { color: x.$lib-accent; }`,
      'c.scss': `@use 'lib';\n.c { color: lib.$accent; }`,
    });
    expect(byText(f.swatches('a.scss'))).toEqual({ 'lib.$accent': '#7c3aed' });
    expect(byText(f.swatches('b.scss'))).toEqual({ 'x.$lib-accent': '#10b981' });
    expect(byText(f.swatches('c.scss'))).toEqual({ 'lib.$accent': '#0000ff' });
  });

  it('resolves index files, node_modules and pkg: URLs', () => {
    const f = fixture({
      'theme/_index.scss': `$bg: #111111;`,
      'node_modules/ds/package.json': JSON.stringify({ name: 'ds', exports: { '.': { sass: './scss/_ds.scss' }, './*': { sass: './scss/_*.scss' } } }),
      'node_modules/ds/scss/_ds.scss': `$brand: #ff00ff;`,
      'node_modules/ds/scss/_extra.scss': `$extra: #00ffff;`,
      'node_modules/legacy/scss/_vars.scss': `$legacy: #abcdef;`,
      'a.scss': `@use 'theme';\n@use 'pkg:ds';\n@use 'pkg:ds/extra';\n@import 'legacy/scss/vars';\n.a { color: theme.$bg; background: ds.$brand; fill: extra.$extra; stroke: $legacy; }`,
    }, { index: false });
    expect(byText(f.swatches('a.scss'))).toEqual({
      'theme.$bg': '#111111',
      'ds.$brand': '#ff00ff',
      'extra.$extra': '#00ffff',
      '$legacy': '#abcdef',
    });
  });

  it('module members are not visible without @use', () => {
    const f = fixture({
      '_colors.scss': `$purple: #7c3aed;`,
      'a.scss': `@use 'other';\n.a { color: $purple; }`,
      '_other.scss': `$x: 1;`,
    });
    expect(f.swatches('a.scss')).toEqual([]);
  });

  it('calls functions from modules', () => {
    const f = fixture({
      '_fns.scss': `@function brand($amount) { @return lighten(#7c3aed, $amount); }`,
      'a.scss': `@use 'fns';\n.a { color: fns.brand(10%); }`,
    });
    expect(f.swatches('a.scss').map((x) => x.text)).toEqual(['fns.brand(10%)']);
  });
});

describe('theme variants', () => {
  it('reports values from [data-theme], .dark and prefers-color-scheme through chains', () => {
    const f = fixture({
      'tokens.css': `:root { --purple: #7c3aed; --primary: var(--purple); }
[data-theme="dark"] { --purple: #a78bfa; }
html.dark { --purple: #c4b5fd; }
@media (prefers-color-scheme: dark) { :root { --purple: #ddd6fe; } }
.card { --purple: #000000; }`,
      'app.css': `.a { color: var(--primary); }`,
    });
    const [s] = f.swatches('app.css');
    expect(s!.hex).toBe('#7c3aed');
    expect(s!.variants).toEqual([
      { label: '[data-theme="dark"]', hex: '#a78bfa' },
      { label: 'html.dark', hex: '#c4b5fd' },
      { label: '@media (prefers-color-scheme: dark)', hex: '#ddd6fe' },
    ]);
  });

  it('applies the theme to variables used inside root definitions', () => {
    const f = fixture({
      'a.css': `:root { --purple: #7c3aed; --primary: var(--purple); }
[data-theme=dark] { --purple: #a78bfa; }`,
    });
    const s = f.swatches('a.css');
    expect(s[0]!.variants.map((v) => v.hex)).toEqual(['#a78bfa']);
  });

  it('can be disabled', () => {
    const f = fixture({ 'a.css': `:root { --c: #fff; } .dark { --c: #000; } a { color: var(--c); }` }, { themes: false });
    expect(f.swatches('a.css')[0]!.variants).toEqual([]);
  });
});

describe('other syntaxes', () => {
  it('Less variables and functions', () => {
    const f = fixture({
      '_vars.less': `@purple: #7c3aed;`,
      'a.less': `@import "_vars";\n@brand: @purple;\n.a { color: darken(@brand, 10%); background: fade(@brand, 50%); border-color: @brand; }`,
    });
    const s = byText(f.swatches('a.less'));
    expect(s['@brand']).toBe('#7c3aed');
    expect(s['@purple']).toBe('#7c3aed');
    expect(s['fade(@brand, 50%)']).toBe('#7c3aed80');
    expect(s['darken(@brand, 10%)']).toBeDefined();
  });

  it('indented Sass syntax', () => {
    const f = fixture({
      '_colors.sass': `$purple: #7c3aed`,
      'a.sass': `@use 'colors' as c\n.a\n  color: lighten(c.$purple, 10%)\n  background: c.$purple`,
    });
    expect(f.swatches('a.sass').map((x) => x.text)).toEqual(['lighten(c.$purple, 10%)', 'c.$purple']);
  });

  it('Vue single-file components', () => {
    const f = fixture({
      'tokens.css': `:root { --brand: #10b981; }`,
      '_colors.scss': `$purple: #7c3aed;`,
      'App.vue': `<template><p style="color: var(--brand)">x</p></template>
<style lang="scss" scoped>
@use 'colors' as c;
.a { color: c.$purple; background: var(--brand); }
</style>`,
    });
    expect(f.swatches('App.vue').map((x) => [x.text, x.hex])).toEqual([
      ['var(--brand)', '#10b981'],
      ['c.$purple', '#7c3aed'],
      ['var(--brand)', '#10b981'],
    ]);
  });
});

describe('module resolution matches dart-sass on a real project', () => {
  const files: Record<string, string> = {
    'src/tokens/_colors.scss': `$purple: #7c3aed !default;\n$green: #10b981;\n$-hidden: #000;\n`,
    'src/tokens/_index.scss': `@forward 'colors';\n`,
    'src/_brand.scss': `@forward 'tokens' as brand-* hide $brand-green;\n`,
    'src/_lib.scss': `@use 'sass:color';\n$primary: #0000ff !default;\n$hover: color.adjust($primary, $lightness: -10%);\n@function tint($c, $w: 20%) { @return mix(white, $c, $w); }\n`,
    'node_modules/ds/package.json': JSON.stringify({ name: 'ds', exports: { '.': { sass: './_ds.scss' } } }),
    'node_modules/ds/_ds.scss': `$accent: #f59e0b;\n`,
    'src/main.scss': `@use 'sass:color';
@use 'brand';
@use 'lib' with ($primary: #dc2626);
@use 'pkg:ds';
@use 'tokens' as t;
.t1 { color: brand.$brand-purple; }
.t2 { color: lib.$hover; }
.t3 { color: lib.tint(t.$green, 35%); }
.t4 { color: color.scale(ds.$accent, $lightness: 25%); }
.t5 { color: rgba(t.$purple, .4); }
.t6 { color: color.mix(brand.$brand-purple, ds.$accent, 30%); }
`,
  };

  it('every swatch equals the compiled output', () => {
    const dir = tempProject(files);
    const main = path.join(dir, 'src/main.scss');
    const css = sass.compile(main, { importers: [new sass.NodePackageImporter(dir)], logger: sass.Logger.silent }).css;
    const expected = new Map<string, string>();
    for (const m of css.matchAll(/\.(t\d) \{\s*color: ([^;]+);/g)) expected.set(m[1]!, m[2]!);
    expect(expected.size).toBe(6);

    const f = fixture(files, { host: nodeHost, root: dir });
    const swatches = f.swatches('src/main.scss');
    const text = files['src/main.scss']!;
    for (const [rule, value] of expected) {
      const line = text.split('\n').find((l) => l.startsWith(`.${rule} `))!;
      const expr = /color: (.*); \}/.exec(line)![1]!;
      const ours = swatches.find((s) => s.text === expr);
      expect(ours, `${rule}: ${expr}`).toBeDefined();
      // Evaluate dart-sass's literal output with our own CSS parser for comparison.
      const lit = fixture({ 'x.css': `a { color: ${value}; }` }, { literals: true }).swatches('x.css')[0]!;
      // Channels within half a unit (dart-sass prints e.g. 247.4999 where we compute 247.5000001).
      for (const ch of ['r', 'g', 'b', 'a'] as const) {
        expect(Math.abs(ours!.color[ch] - lit.color[ch]) * 255, `${rule}: ${expr} → ${value}`).toBeLessThan(0.51);
      }
    }
  });
});
