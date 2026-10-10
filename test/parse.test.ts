import { describe, expect, it } from 'vitest';
import { parseExpression } from '../src/core/expr';
import { parseEmbedded, parseStylesheet } from '../src/core/parse';
import { classify } from '../src/core/themes';

describe('parseStylesheet (scss)', () => {
  const src = `@use 'sass:math';
@use "./tokens/colors" as c;
@use 'theme' with ($primary: #f00, $radius: 4px !default);
@forward 'src/list' as list-* hide list-reset, $horizontal-gap;
@import 'a', 'b.css', url(c.css);

// $commented: red;
/* $also: blue; */
$purple: #7c3aed !default;
$brand_color: $purple !global;
$_private: 1px;

:root {
  --purple: #{$purple};
  --primary: var(--purple, #000) !important;
}

.btn {
  $local: red;
  color: $local;
  background: url(http://example.com/x.png);
  @include button-variant($brand_color, darken($purple, 10%));
  &:hover { border-color: c.$purple; }
}

@function tint($color, $weight: 10%) {
  @return mix(white, $color, $weight);
}

@mixin m($a, $b...) { color: $a; }
@each $name, $value in $map { .x-#{$name} { color: $value; } }
`;
  const f = parseStylesheet(src, 'scss', { sites: true });

  it('extracts variables with flags and normalized names', () => {
    const sass = f.vars.filter((v) => v.kind === 'sass');
    expect(sass.map((v) => [v.name, v.value, v.isDefault, v.isGlobal, v.private])).toEqual([
      ['purple', '#7c3aed', true, false, false],
      ['brand-color', '$purple', false, true, false],
      ['-private', '1px', false, false, true],
      ['local', 'red', false, false, false],
    ]);
    expect(sass[0]!.line).toBe(8);
  });

  it('ignores commented-out code', () => {
    expect(f.vars.some((v) => v.name === 'commented' || v.name === 'also')).toBe(false);
  });

  it('extracts custom properties with root context', () => {
    const css = f.vars.filter((v) => v.kind === 'css');
    expect(css.map((v) => [v.name, v.value])).toEqual([
      ['--purple', '#{$purple}'],
      ['--primary', 'var(--purple, #000)'],
    ]);
    expect(css[0]!.contexts).toEqual([{ kind: 'root', key: 'root', label: ':root' }]);
  });

  it('parses @use / @forward / @import', () => {
    expect(f.imports.map((i) => [i.kind, i.url, i.namespace, i.prefix])).toEqual([
      ['use', 'sass:math', undefined, undefined],
      ['use', './tokens/colors', 'c', undefined],
      ['use', 'theme', undefined, undefined],
      ['forward', 'src/list', undefined, 'list-'],
      ['import', 'a', undefined, undefined],
      ['import', 'b.css', undefined, undefined],
      ['import', 'c.css', undefined, undefined],
    ]);
    expect(f.imports[2]!.config!.map((c) => [c.name, c.value, c.isDefault])).toEqual([
      ['primary', '#f00', false],
      ['radius', '4px', true],
    ]);
    expect(f.imports[3]!.hide).toEqual(['list-reset', '$horizontal-gap']);
    expect(f.imports.filter((i) => i.plainCss).map((i) => i.url)).toEqual(['b.css', 'c.css']);
  });

  it('records functions with a single @return', () => {
    expect(f.functions).toHaveLength(1);
    const fn = f.functions[0]!;
    expect(fn.name).toBe('tint');
    expect(fn.params).toEqual([
      { name: 'color' },
      { name: 'weight', value: '10%', valueStart: expect.any(Number) },
    ]);
    expect(fn.ret!.value).toBe('mix(white, $color, $weight)');
    expect(fn.complex).toBe(false);
  });

  it('records block params for mixins and @each', () => {
    const params = f.blocks.filter((b) => b.params).map((b) => b.params);
    expect(params).toEqual([['color', 'weight'], ['a', 'b'], ['name', 'value']]);
  });

  it('collects value sites including @include arguments', () => {
    const sites = f.sites.map((s) => [s.kind, s.value]);
    expect(sites).toContainEqual(['include', 'button-variant($brand_color, darken($purple, 10%))']);
    expect(sites).toContainEqual(['decl', 'c.$purple']);
    expect(sites).toContainEqual(['prop', '#{$purple}']);
    expect(sites).toContainEqual(['decl', 'url(http://example.com/x.png)']);
  });
});

describe('error tolerance', () => {
  it('recovers from unbalanced parentheses while typing', () => {
    const f = parseStylesheet(`a { color: rgba($x, ; }\n$ok: blue;\nb { color: $ok; }`, 'scss', { sites: true });
    expect(f.vars.map((v) => v.name)).toContain('ok');
    expect(f.sites.map((s) => s.value)).toContain('$ok');
  });
  it('handles unterminated blocks and strings', () => {
    // Like browsers, an unterminated string ends at the newline and the bad declaration runs to ';'.
    const f = parseStylesheet(`a { --x: "oops\n; --y: red; }\n.b { color: var(--y)`, 'css', { sites: true });
    expect(f.vars.map((v) => v.name)).toContain('--y');
    expect(f.sites.map((s) => s.value)).toContain('var(--y)');
  });
});

describe('indented Sass syntax', () => {
  const src = `@use 'colors' as c
// comment line
  that continues
$brand: c.$purple
=theme($accent)
  color: $accent

.card
  background: $brand
  +theme(darken($brand, 10%))
  &:hover
    color: lighten($brand, 5%)
:root
  --brand: #{$brand}
`;
  const f = parseStylesheet(src, 'sass', { sites: true });
  it('extracts variables, imports and blocks', () => {
    expect(f.imports.map((i) => [i.url, i.namespace])).toEqual([['colors', 'c']]);
    expect(f.vars.map((v) => [v.kind, v.name, v.value])).toEqual([
      ['sass', 'brand', 'c.$purple'],
      ['css', '--brand', '#{$brand}'],
    ]);
    expect(f.vars[1]!.contexts![0]!.kind).toBe('root');
  });
  it('collects sites for declarations and +include', () => {
    expect(f.sites.map((s) => s.value)).toEqual([
      'c.$purple',
      '$accent',
      '$brand',
      'theme(darken($brand, 10%))',
      'lighten($brand, 5%)',
      '#{$brand}',
    ]);
  });
  it('records mixin params', () => {
    expect(f.blocks.find((b) => b.kind === 'mixin')!.params).toEqual(['accent']);
  });
});

describe('Less', () => {
  it('extracts @variables and imports', () => {
    const f = parseStylesheet(`@import (reference) "base";\n@primary: #7c3aed;\n@media (min-width: 1px) { a { color: @primary; } }`, 'less', { sites: true });
    expect(f.vars.map((v) => [v.kind, v.name, v.value])).toEqual([['less', 'primary', '#7c3aed']]);
    expect(f.imports.map((i) => i.url)).toEqual(['base']);
    expect(f.sites.map((s) => s.value)).toContain('@primary');
  });
});

describe('embedded styles', () => {
  it('parses <style> blocks with lang and inline style attributes', () => {
    const html = `<template><div style="color: var(--a)"></div></template>
<style scoped lang="scss">
$x: #fff;
.a { color: $x; }
</style>
<style>
:root { --a: #000; }
</style>`;
    const f = parseEmbedded(html, { sites: true });
    expect(f.vars.map((v) => v.name).sort()).toEqual(['--a', 'x']);
    expect(f.sites.map((s) => html.slice(s.start, s.end))).toEqual(['var(--a)', '#fff', '$x', '#000']);
    expect(f.masked!.length).toBe(html.length);
  });
});

describe('theme classification', () => {
  const kinds = (sel: string[], at: string[] = []) => classify(sel, at).map((c) => [c.kind, c.key]);
  it('detects root, variants and scoped definitions', () => {
    expect(kinds([':root'])).toEqual([['root', 'root']]);
    expect(kinds(['html', ':host'])).toEqual([['root', 'root']]);
    expect(kinds(['[data-theme="dark"]'])).toEqual([['variant', 'sel:[data-theme=dark]']]);
    expect(kinds([':root[data-theme=dark]'])).toEqual([['variant', 'sel:[data-theme=dark]']]);
    expect(kinds(['html.dark'])).toEqual([['variant', 'sel:.dark']]);
    expect(kinds(['.dark'])).toEqual([['variant', 'sel:.dark']]);
    expect(kinds([':root'], ['@media (prefers-color-scheme: dark)'])).toEqual([['variant', 'media:dark']]);
    expect(kinds([':root:not([data-theme=light])'], ['@media (prefers-color-scheme: dark)'])).toEqual([['variant', 'media:dark']]);
    expect(kinds(['.card'])).toEqual([['scoped', 'scoped:.card']]);
    expect(kinds(['.dark .card'])).toEqual([['scoped', 'scoped:.dark .card']]);
    expect(kinds([':root'], ['@media (min-width: 600px)'])[0]![0]).toBe('scoped');
    expect(kinds([':root'], ['@layer base'])).toEqual([['root', 'root']]);
    expect(kinds([':root', '[data-theme="light"]'])).toEqual([['root', 'root'], ['variant', 'sel:[data-theme=light]']]);
  });
  it('infers the color scheme of a variant', () => {
    expect(classify(['.theme-dark'], [])[0]!.scheme).toBe('dark');
    expect(classify(['[data-mode=light]'], [])[0]!.scheme).toBe('light');
  });
});

describe('parseExpression', () => {
  const p = (s: string, mode: 'css' | 'scss' | 'less' = 'scss') => parseExpression(s, 0, s.length, mode);
  it('parses namespaced members and keyword arguments', () => {
    const n = p('color.adjust(c.$purple, $lightness: -10%)');
    expect(n).toMatchObject({
      t: 'call',
      ns: 'color',
      name: 'adjust',
      args: [{ value: { t: 'svar', ns: 'c', name: 'purple' } }, { name: 'lightness', value: { t: 'num', value: -10, unit: '%' } }],
    });
  });
  it('distinguishes subtraction, negative numbers and space lists', () => {
    expect(p('$a - $b')).toMatchObject({ t: 'bin', op: '-' });
    expect(p('10px -5px')).toMatchObject({ t: 'list', sep: ' ', items: [{ value: 10 }, { value: -5 }] });
    expect(p('-$x')).toMatchObject({ t: 'neg' });
  });
  it('parses maps, slash lists and interpolation', () => {
    expect(p('(primary: #fff, "secondary": $x)')).toMatchObject({ t: 'map', entries: [[{ name: 'primary' }, { t: 'hex' }], [{ t: 'str' }, { t: 'svar' }]] });
    expect(p('rgb(0 0 0 / 50%)', 'css')).toMatchObject({ t: 'call', args: [{ value: { t: 'list', sep: '/' } }] });
    expect(p('#{$x}')).toMatchObject({ t: 'interp', inner: { t: 'svar', name: 'x' } });
  });
  it('treats unquoted url() as opaque', () => {
    expect(p('url(data:image/png;base64,abc) $x')).toMatchObject({ t: 'list', items: [{ t: 'bad' }, { t: 'svar' }] });
  });
});
