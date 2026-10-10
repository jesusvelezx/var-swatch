import * as sass from 'sass';
import { describe, expect, it } from 'vitest';
import { type Color, parseHex, toHex } from '../src/core/color/color';
import { BLACK, WHITE, contrastRatio, wcagLevel } from '../src/core/color/contrast';
import { colorMix } from '../src/core/color/functions';
import { fixture } from './helpers';

/** Compiles `expr` with dart-sass and returns its sRGB channels (0..255) and alpha. */
function dartSass(expr: string): [number, number, number, number] {
  const css = sass.compileString(
    `@use 'sass:color';
$c: ${expr};
a { r: color.channel($c, "red", $space: rgb); g: color.channel($c, "green", $space: rgb); b: color.channel($c, "blue", $space: rgb); a: color.channel($c, "alpha"); }`,
    { logger: sass.Logger.silent },
  ).css;
  const get = (k: string): number => Number(new RegExp(`\\b${k}: (-?[\\d.e+-]+)`).exec(css)![1]);
  return [get('r'), get('g'), get('b'), get('a')];
}

/** Evaluates `expr` with var-swatch inside an SCSS document. */
function ours(expr: string): Color | undefined {
  const f = fixture({ 'a.scss': `@use 'sass:color';\na { color: ${expr}; }\n` }, { literals: true });
  const list = f.swatches('a.scss');
  const s = list.find((x) => x.text === expr);
  return s?.color;
}

const SASS_CASES = [
  'lighten(#7c3aed, 10%)',
  'darken(#7c3aed, 15%)',
  'lighten(#7c3aed, 60%)',
  'darken(#7c3aed, 100%)',
  'lighten(rebeccapurple, 20%)',
  'darken(hsl(200, 50%, 50%), 5%)',
  'saturate(#7c3aed, 20%)',
  'desaturate(#7c3aed, 30%)',
  'desaturate(#808080, 10%)',
  'adjust-hue(#7c3aed, 45deg)',
  'adjust-hue(#7c3aed, -90)',
  'rgba(#7c3aed, .5)',
  'rgba(#7c3aed, 50%)',
  'rgb(#7c3aed, 0.2)',
  'rgb(124, 58, 237)',
  'rgb(124 58 237 / 0.25)',
  'rgba(124, 58, 237, .3)',
  'rgb(50%, 20%, 90%)',
  'hsl(270, 80%, 60%)',
  'hsla(270, 80%, 60%, .4)',
  'hsl(270deg 80% 60% / 50%)',
  'hsl(1turn, 50%, 50%)',
  'mix(#7c3aed, #fff)',
  'mix(#7c3aed, #10b981, 25%)',
  'mix(rgba(#7c3aed, .5), #fff, 70%)',
  'mix(rgba(#7c3aed, .2), rgba(#10b981, .9), 40%)',
  'invert(#7c3aed)',
  'invert(#7c3aed, 30%)',
  'grayscale(#7c3aed)',
  'complement(#7c3aed)',
  'opacify(rgba(#000, .5), .2)',
  'fade-in(rgba(#fff, .1), .3)',
  'transparentize(#7c3aed, .25)',
  'fade-out(#7c3aed, .1)',
  'color.adjust(#7c3aed, $lightness: -10%)',
  'color.adjust(#7c3aed, $red: 20, $blue: -40)',
  'color.adjust(#7c3aed, $blue: 100)',
  'color.adjust(#7c3aed, $hue: 30deg, $saturation: 10%)',
  'color.adjust(#7c3aed, $alpha: -0.4)',
  'color.adjust(#7c3aed, $whiteness: 10%)',
  'color.adjust(#7c3aed, $lightness: 10%, $space: oklch)',
  'color.adjust(#7c3aed, $chroma: -0.05, $space: oklch)',
  'color.scale(#7c3aed, $lightness: 30%)',
  'color.scale(#7c3aed, $lightness: -40%, $saturation: 20%)',
  'color.scale(#7c3aed, $red: 50%)',
  'color.scale(#7c3aed, $alpha: -50%)',
  'color.scale(#7c3aed, $blackness: 20%)',
  'color.change(#7c3aed, $lightness: 40%)',
  'color.change(#7c3aed, $blue: 10, $alpha: .8)',
  'color.change(#7c3aed, $hue: 120)',
  'color.mix(#7c3aed, #f59e0b, 40%)',
  'color.mix(#7c3aed, #10b981, 50%, oklch)',
  'color.mix(#7c3aed, #10b981, 30%, $method: lab)',
  'color.mix(#7c3aed, #10b981, 50%, hsl longer hue)',
  'color.invert(#7c3aed)',
  'color.grayscale(#10b981)',
  'color.complement(#10b981)',
  'scale-color(#7c3aed, $lightness: -20%)',
  'adjust-color(#7c3aed, $green: 30)',
  'change-color(#7c3aed, $saturation: 20%)',
  'oklch(62% 0.25 293)',
  'oklch(0.7 0.1 150 / 50%)',
  'lab(50% 40 -60)',
  'lch(55% 70 290)',
  'oklab(0.6 0.1 -0.2)',
  'color(display-p3 0.5 0.3 0.9)',
  'color(srgb-linear 0.2 0.1 0.8)',
  'color(xyz-d50 0.2 0.15 0.5)',
  'hwb(270 20% 10%)',
];

describe('Sass color functions match dart-sass', () => {
  for (const expr of SASS_CASES) {
    it(expr, () => {
      const expected = dartSass(expr);
      const got = ours(expr);
      expect(got, `unresolved: ${expr}`).toBeDefined();
      const actual = [got!.r * 255, got!.g * 255, got!.b * 255, got!.a];
      for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 1);
      expect(actual[3]).toBeCloseTo(expected[3]!, 4);
    });
  }
});

describe('out-of-range HSL from color.adjust() shows the browser-rendered color', () => {
  // dart-sass emits e.g. hsl(262deg, 83%, 107.8%) without clamping; browsers clamp
  // saturation/lightness to 0..100% when parsing hsl(), so the visible color is clamped.
  it('lightness above 100% renders white', () => {
    const css = sass.compileString("@use 'sass:color'; a { b: color.adjust(#7c3aed, $lightness: 50%) }").css;
    expect(css).toMatch(/hsl\(262\.\d+, 83\.\d+%, 107\.\d+%\)/);
    expect(toHex(ours('color.adjust(#7c3aed, $lightness: 50%)')!)).toBe('#ffffff');
  });
  it('saturation above 100% is clamped', () => {
    expect(toHex(ours('color.adjust(#7c3aed, $saturation: 50%)')!)).toBe(toHex(ours('hsl(262.1229050279, 100%, 57.8431372549%)')!));
  });
});

describe('invalid Sass calls show nothing (dart-sass errors)', () => {
  for (const expr of [
    'lighten(#7c3aed, 120%)',
    'lighten(#7c3aed, -10%)',
    'darken(var(--x), 10%)',
    'mix(#fff, #000, 150%)',
    'color.adjust(#7c3aed, $red: 10, $lightness: 10%)',
    'color.scale(#7c3aed, $lightness: 10)',
    'lighten(10px, 10%)',
  ]) {
    it(expr, () => {
      expect(() => sass.compileString(`@use 'sass:color';\na { b: ${expr}; }`, { logger: sass.Logger.silent })).toThrow();
      expect(ours(expr)).toBeUndefined();
    });
  }
});

describe('CSS color-mix()', () => {
  const red = parseHex('#ff0000')!;
  const blue = parseHex('#0000ff')!;
  it('mixes in srgb with default 50/50', () => {
    const c = colorMix('srgb', 'shorter', red, undefined, blue, undefined);
    expect(c.r * 255).toBeCloseTo(127.5, 5);
    expect(c.b * 255).toBeCloseTo(127.5, 5);
  });
  it('normalizes percentages that do not sum to 100 and scales alpha', () => {
    const c = colorMix('srgb', 'shorter', red, 20, blue, 20);
    expect(c.r).toBeCloseTo(0.5, 5);
    expect(c.a).toBeCloseTo(0.4, 5);
  });
  it('matches dart-sass color.mix() with a method', () => {
    for (const space of ['oklch', 'lab', 'oklab', 'srgb', 'hsl', 'lch'] as const) {
      for (const p of [10, 35, 50, 80]) {
        const expected = dartSass(`color.mix(#7c3aed, #f59e0b, ${p}%, ${space})`);
        const css = `color-mix(in ${space}, #7c3aed ${p}%, #f59e0b)`;
        const got = ours(css)!;
        expect(got, css).toBeDefined();
        expect(got.r * 255).toBeCloseTo(expected[0], 1);
        expect(got.g * 255).toBeCloseTo(expected[1], 1);
        expect(got.b * 255).toBeCloseTo(expected[2], 1);
      }
    }
  });
  it('treats an achromatic color as having a missing hue', () => {
    const c = ours('color-mix(in oklch, white, #0000ff)')!;
    const expected = dartSass('color.mix(white, #0000ff, 50%, oklch)');
    expect(c.b * 255).toBeCloseTo(expected[2], 0);
  });
  it('supports percentages on either side and hue methods', () => {
    expect(ours('color-mix(in srgb, 25% #ff0000, #0000ff)')).toBeDefined();
    expect(ours('color-mix(in hsl longer hue, #ff0000, #0000ff)')).toBeDefined();
    expect(ours('color-mix(srgb, #ff0000, #0000ff)')).toBeUndefined();
  });
});

describe('CSS light-dark()', () => {
  it('uses the light value by default and reports a dark variant', () => {
    const f = fixture({ 'a.css': `a { color: light-dark(#ffffff, #000000); }` });
    const [s] = f.swatches('a.css');
    expect(s!.hex).toBe('#ffffff');
    expect(s!.variants).toEqual([{ label: 'light-dark() · dark', hex: '#000000' }]);
  });
});

describe('WCAG contrast', () => {
  it('computes ratios and levels', () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 5);
    expect(contrastRatio(parseHex('#777777')!, WHITE)).toBeCloseTo(4.48, 2);
    expect(wcagLevel(4.48)).toBe('AA Large');
    expect(wcagLevel(7.1)).toBe('AAA');
    expect(wcagLevel(2)).toBe('Fail');
  });
  it('composites translucent colors over the background', () => {
    const half = { ...BLACK, a: 0.5 };
    expect(contrastRatio(half, WHITE)).toBeLessThan(contrastRatio(BLACK, WHITE));
  });
  it('formats hex with alpha', () => {
    expect(toHex({ r: 1, g: 0, b: 0, a: 0.5 })).toBe('#ff000080');
  });
});
