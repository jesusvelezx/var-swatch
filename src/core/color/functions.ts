/**
 * Color functions for CSS, Sass (dart-sass semantics) and Less.
 * Each implementation throws `Unresolved` for anything it cannot compute exactly.
 */
import {
  type Color,
  clamp,
  clamp01,
  hslToRgb,
  hwbToRgb,
  normalizeHue,
  rgbToHsl,
  rgbToHwb,
} from './color';
import { type Coords, type Space, fromSpace, hueIndex, parseSpace, toSpace } from './spaces';
import {
  type Value,
  asAlpha,
  asColor,
  asDegrees,
  asNumber,
  asPercent,
  colorValue,
  fail,
  num,
} from '../values';

export interface CallArgs {
  positional: Value[];
  /** Keyword arguments, keys normalized (no `$`, `_` → `-`). */
  named: Map<string, Value>;
}

export type Mode = 'sass' | 'less' | 'css';

/** Binds call arguments to parameter names. Unknown keyword arguments fail. */
export function bind(args: CallArgs, params: readonly string[]): (Value | undefined)[] {
  if (args.positional.length > params.length) fail('too many arguments');
  const out: (Value | undefined)[] = params.map((_, i) => args.positional[i]);
  for (const [key, value] of args.named) {
    const idx = params.indexOf(key);
    if (idx < 0 || out[idx] !== undefined) fail(`unexpected argument $${key}`);
    out[idx] = value;
  }
  return out;
}

const isNone = (v: Value | undefined): boolean => v?.kind === 'string' && !v.quoted && v.value.toLowerCase() === 'none';

/** Splits CSS-style channel arguments: `f(a, b, c[, d])`, `f(a b c)` or `f(a b c / d)`. */
function channelArgs(args: CallArgs): { ch: Value[]; alpha?: Value } {
  if (args.named.size) fail('named channels');
  const p = args.positional;
  if (p.length >= 3) {
    if (p.length > 4) fail('too many channels');
    return { ch: p.slice(0, 3), alpha: p[3] };
  }
  if (p.length === 1) {
    let v = p[0]!;
    let alpha: Value | undefined;
    if (v.kind === 'list' && v.sep === '/') {
      if (v.items.length !== 2) fail('bad slash');
      alpha = v.items[1];
      v = v.items[0]!;
    }
    if (v.kind === 'list' && v.sep === ' ' && v.items.length === 3) return { ch: v.items, alpha };
  }
  return fail('bad channels');
}

const alphaOf = (v: Value | undefined): number => (v === undefined || isNone(v) ? 1 : clamp01(asAlpha(v)));

/** A channel that is a number or percentage, scaled so that 100% === `pctScale`. */
function scaled(v: Value, pctScale: number): number {
  if (isNone(v)) return 0;
  const n = asNumber(v);
  if (n.unit === '%') return (n.value / 100) * pctScale;
  if (n.unit === '') return n.value;
  return fail('bad unit');
}

const hueOf = (v: Value): number => (isNone(v) ? NaN : asDegrees(v));

// ---------------------------------------------------------------------------
// CSS color functions
// ---------------------------------------------------------------------------

function cssRgb(args: CallArgs, mode: Mode): Value {
  // Sass/Less legacy overload: rgba($color, $alpha)
  if (mode === 'sass' && args.positional.length <= 2 && (args.positional[0]?.kind === 'color' || args.named.has('color'))) {
    const [c, a] = bind(args, ['color', 'alpha']);
    const color = asColor(c);
    return colorValue({ ...color, a: a === undefined ? color.a : clamp01(asAlpha(a)) });
  }
  if (mode === 'sass' && args.named.size) {
    const [r, g, b, a] = bind(args, ['red', 'green', 'blue', 'alpha']);
    return colorValue(rgbFromChannels([r!, g!, b!], a));
  }
  const { ch, alpha } = channelArgs(args);
  return colorValue(rgbFromChannels(ch, alpha));
}

function rgbFromChannels(ch: (Value | undefined)[], alpha: Value | undefined): Color {
  const [r, g, b] = ch.map((v) => (v === undefined ? fail('missing channel') : scaled(v, 255) / 255));
  return { r: clamp01(r!), g: clamp01(g!), b: clamp01(b!), a: alphaOf(alpha) };
}

function cssHsl(args: CallArgs, mode: Mode): Value {
  let h: Value | undefined, s: Value | undefined, l: Value | undefined, a: Value | undefined;
  if (mode === 'sass' && args.named.size) {
    [h, s, l, a] = bind(args, ['hue', 'saturation', 'lightness', 'alpha']);
  } else {
    const { ch, alpha } = channelArgs(args);
    [h, s, l] = ch;
    a = alpha;
  }
  if (!h || !s || !l) return fail('missing channel');
  const sat = clamp(scaled(s, 100), 0, 100) / 100;
  const light = clamp(scaled(l, 100), 0, 100) / 100;
  return colorValue(hslToRgb(hueOf(h), sat, light, alphaOf(a)));
}

function cssHwb(args: CallArgs): Value {
  const { ch, alpha } = channelArgs(args);
  const w = clamp(scaled(ch[1]!, 100), 0, 100) / 100;
  const b = clamp(scaled(ch[2]!, 100), 0, 100) / 100;
  return colorValue(hwbToRgb(hueOf(ch[0]!), w, b, alphaOf(alpha)));
}

function cssLabLike(space: 'lab' | 'lch' | 'oklab' | 'oklch', args: CallArgs): Value {
  const { ch, alpha } = channelArgs(args);
  const ok = space.startsWith('ok');
  const lightness = ok ? scaled(ch[0]!, 1) : scaled(ch[0]!, 100);
  let coords: Coords;
  if (space === 'lab' || space === 'oklab') {
    const s = ok ? 0.4 : 125;
    coords = [lightness, scaled(ch[1]!, s), scaled(ch[2]!, s)];
  } else {
    const c = Math.max(0, scaled(ch[1]!, ok ? 0.4 : 150));
    coords = [lightness, c, hueOf(ch[2]!)];
  }
  return colorValue(fromSpace(space, coords, alphaOf(alpha)));
}

function cssColor(args: CallArgs): Value {
  if (args.named.size || args.positional.length !== 1) return fail('bad color()');
  let v = args.positional[0]!;
  let alpha: Value | undefined;
  if (v.kind === 'list' && v.sep === '/') {
    alpha = v.items[1];
    v = v.items[0]!;
  }
  if (v.kind !== 'list' || v.items.length !== 4) return fail('bad color()');
  const name = v.items[0]!;
  if (name.kind !== 'string') return fail('bad color space');
  const space = parseSpace(name.value);
  const allowed: Space[] = ['srgb', 'srgb-linear', 'display-p3', 'xyz-d65', 'xyz-d50'];
  if (!space || !allowed.includes(space) || name.value.toLowerCase() === 'rgb') return fail('bad color space');
  const coords = v.items.slice(1).map((c) => scaled(c, 1)) as Coords;
  return colorValue(fromSpace(space, coords, alphaOf(alpha)));
}

type HueMethod = 'shorter' | 'longer' | 'increasing' | 'decreasing';

/** CSS `color-mix()` algorithm (CSS Color 5 §2). `p1`/`p2` are 0..100 or undefined. */
export function colorMix(
  space: Space,
  hueMethod: HueMethod,
  c1: Color,
  p1: number | undefined,
  c2: Color,
  p2: number | undefined,
): Color {
  if (p1 === undefined && p2 === undefined) p1 = p2 = 50;
  else if (p1 === undefined) p1 = 100 - p2!;
  else if (p2 === undefined) p2 = 100 - p1;
  if (p1! < 0 || p2! < 0 || p1! > 100 || p2! > 100) return fail('bad percentage');
  const sum = p1! + p2!;
  if (sum === 0) return fail('zero sum');
  const w2 = p2! / sum;
  const w1 = 1 - w2;
  const multiplier = sum < 100 ? sum / 100 : 1;

  const a = toSpace(c1, space);
  const b = toSpace(c2, space);
  const hi = hueIndex(space);
  if (hi >= 0) {
    if (Number.isNaN(a[hi]!)) a[hi] = b[hi]!;
    if (Number.isNaN(b[hi]!)) b[hi] = a[hi]!;
    if (Number.isNaN(a[hi]!)) a[hi] = b[hi] = 0;
    let h1 = a[hi]!;
    let h2 = b[hi]!;
    const diff = h2 - h1;
    switch (hueMethod) {
      case 'shorter':
        if (diff > 180) h1 += 360;
        else if (diff < -180) h2 += 360;
        break;
      case 'longer':
        if (diff > 0 && diff < 180) h1 += 360;
        else if (diff > -180 && diff <= 0) h2 += 360;
        break;
      case 'increasing':
        if (h2 < h1) h2 += 360;
        break;
      case 'decreasing':
        if (h1 < h2) h1 += 360;
        break;
    }
    a[hi] = h1;
    b[hi] = h2;
  }
  // Premultiply every non-hue channel by alpha.
  const pre = (c: Coords, alpha: number): Coords => c.map((v, i) => (i === hi ? v : v * alpha)) as Coords;
  const pa = pre(a, c1.a);
  const pb = pre(b, c2.a);
  const alpha = c1.a * w1 + c2.a * w2;
  const mixed = pa.map((v, i) => {
    const m = v * w1 + pb[i]! * w2;
    if (i === hi) return normalizeHue(m);
    return alpha === 0 ? m : m / alpha;
  }) as Coords;
  return fromSpace(space, mixed, alpha * multiplier);
}

function cssColorMix(args: CallArgs): Value {
  if (args.named.size || args.positional.length !== 3) return fail('bad color-mix()');
  const [method, x, y] = args.positional as [Value, Value, Value];
  const words = method.kind === 'list' && method.sep === ' ' ? method.items : [method];
  const names = words.map((w) => (w.kind === 'string' && !w.quoted ? w.value.toLowerCase() : fail('bad method')));
  if (names[0] !== 'in' || names.length < 2) return fail('missing in');
  const space = parseSpace(names[1]!);
  if (!space || names[1] === 'rgb') return fail('bad space');
  let hue: HueMethod = 'shorter';
  if (names.length === 4 && names[3] === 'hue' && hueIndex(space) >= 0) {
    if (!['shorter', 'longer', 'increasing', 'decreasing'].includes(names[2]!)) return fail('bad hue');
    hue = names[2] as HueMethod;
  } else if (names.length !== 2) return fail('bad method');
  const part = (v: Value): [Color, number | undefined] => {
    if (v.kind === 'color') return [v.color, undefined];
    if (v.kind === 'list' && v.sep === ' ' && v.items.length === 2) {
      const [p, q] = v.items as [Value, Value];
      if (p.kind === 'color' && q.kind === 'number' && q.unit === '%') return [p.color, q.value];
      if (q.kind === 'color' && p.kind === 'number' && p.unit === '%') return [q.color, p.value];
    }
    return fail('bad color-mix part');
  };
  const [c1, p1] = part(x);
  const [c2, p2] = part(y);
  return colorValue(colorMix(space, hue, c1, p1, c2, p2));
}

const CSS_FUNCTIONS: Record<string, (args: CallArgs, mode: Mode) => Value> = {
  rgb: cssRgb,
  rgba: cssRgb,
  hsl: cssHsl,
  hsla: cssHsl,
  hwb: (a) => cssHwb(a),
  lab: (a) => cssLabLike('lab', a),
  lch: (a) => cssLabLike('lch', a),
  oklab: (a) => cssLabLike('oklab', a),
  oklch: (a) => cssLabLike('oklch', a),
  color: (a) => cssColor(a),
  'color-mix': (a) => cssColorMix(a),
};

/** CSS functions that VS Code's built-in color provider already renders when all arguments are literals. */
export const NATIVE_CSS_COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color']);

export function isCssColorFunction(name: string): boolean {
  return name in CSS_FUNCTIONS || name === 'light-dark';
}

export function callCssFunction(name: string, args: CallArgs, mode: Mode): Value | undefined {
  const fn = CSS_FUNCTIONS[name];
  return fn ? fn(args, mode) : undefined;
}

// ---------------------------------------------------------------------------
// Sass color functions (dart-sass semantics)
// ---------------------------------------------------------------------------

function inRange(value: number, min: number, max: number, what: string): number {
  if (value < min || value > max) fail(`${what} out of range`);
  return value;
}

/** The legacy HSL channels of a color, saturation/lightness in percent (0..100). */
function hslOf(c: Color): [number, number, number] {
  const [h, s, l] = rgbToHsl(c);
  return [Number.isNaN(h) ? 0 : h, s * 100, l * 100];
}

const fromHsl = (h: number, s: number, l: number, a: number): Color =>
  hslToRgb(h, clamp(s, 0, 100) / 100, clamp(l, 0, 100) / 100, a);

function adjustHsl(c: Color, dh: number, ds: number, dl: number): Color {
  const [h, s, l] = hslOf(c);
  return fromHsl(h + dh, s + ds, l + dl, c.a);
}

/** dart-sass `mix()` (legacy RGB algorithm, weight is the proportion of `c1`). */
export function sassMix(c1: Color, c2: Color, weightPct: number): Color {
  const p = weightPct / 100;
  const w = p * 2 - 1;
  const alphaDistance = c1.a - c2.a;
  const combined = w * alphaDistance === -1 ? w : (w + alphaDistance) / (1 + w * alphaDistance);
  const w1 = (combined + 1) / 2;
  const w2 = 1 - w1;
  return {
    r: c1.r * w1 + c2.r * w2,
    g: c1.g * w1 + c2.g * w2,
    b: c1.b * w1 + c2.b * w2,
    a: c1.a * p + c2.a * (1 - p),
  };
}

type ChannelSpace = 'rgb' | 'hsl' | 'hwb' | 'lab' | 'lch' | 'oklab' | 'oklch';

interface ChannelInfo {
  space: ChannelSpace;
  index: number;
  /** Value range for clamping (legacy) and scaling. `undefined` for unbounded channels. */
  min?: number;
  max?: number;
  /** How a `%` amount maps to the channel's units. */
  pct: number;
  hue?: boolean;
}

const CHANNELS: Record<ChannelSpace, Record<string, ChannelInfo>> = {
  rgb: {
    red: { space: 'rgb', index: 0, min: 0, max: 255, pct: 255 / 100 },
    green: { space: 'rgb', index: 1, min: 0, max: 255, pct: 255 / 100 },
    blue: { space: 'rgb', index: 2, min: 0, max: 255, pct: 255 / 100 },
  },
  hsl: {
    hue: { space: 'hsl', index: 0, pct: 1, hue: true },
    saturation: { space: 'hsl', index: 1, min: 0, max: 100, pct: 1 },
    lightness: { space: 'hsl', index: 2, min: 0, max: 100, pct: 1 },
  },
  hwb: {
    hue: { space: 'hwb', index: 0, pct: 1, hue: true },
    whiteness: { space: 'hwb', index: 1, min: 0, max: 100, pct: 1 },
    blackness: { space: 'hwb', index: 2, min: 0, max: 100, pct: 1 },
  },
  lab: {
    lightness: { space: 'lab', index: 0, min: 0, max: 100, pct: 1 },
    a: { space: 'lab', index: 1, pct: 1.25 },
    b: { space: 'lab', index: 2, pct: 1.25 },
  },
  lch: {
    lightness: { space: 'lch', index: 0, min: 0, max: 100, pct: 1 },
    chroma: { space: 'lch', index: 1, pct: 1.5 },
    hue: { space: 'lch', index: 2, pct: 1, hue: true },
  },
  oklab: {
    lightness: { space: 'oklab', index: 0, min: 0, max: 1, pct: 0.01 },
    a: { space: 'oklab', index: 1, pct: 0.004 },
    b: { space: 'oklab', index: 2, pct: 0.004 },
  },
  oklch: {
    lightness: { space: 'oklch', index: 0, min: 0, max: 1, pct: 0.01 },
    chroma: { space: 'oklch', index: 1, pct: 0.004 },
    hue: { space: 'oklch', index: 2, pct: 1, hue: true },
  },
};

const LEGACY: ChannelSpace[] = ['rgb', 'hsl', 'hwb'];

/** Reads a color's channels in the units used by Sass's channel arguments. */
function readChannels(c: Color, space: ChannelSpace): Coords {
  switch (space) {
    case 'rgb':
      return [c.r * 255, c.g * 255, c.b * 255];
    case 'hsl':
      return hslOf(c);
    case 'hwb': {
      const [h, w, b] = rgbToHwb(c);
      return [Number.isNaN(h) ? 0 : h, w * 100, b * 100];
    }
    default: {
      const coords = toSpace(c, space);
      const hi = hueIndex(space);
      if (hi >= 0 && Number.isNaN(coords[hi]!)) coords[hi] = 0;
      return coords;
    }
  }
}

function writeChannels(space: ChannelSpace, coords: Coords, alpha: number): Color {
  switch (space) {
    case 'rgb':
      return { r: coords[0] / 255, g: coords[1] / 255, b: coords[2] / 255, a: alpha };
    case 'hsl':
      return fromHsl(coords[0], coords[1], coords[2], alpha);
    case 'hwb':
      return hwbToRgb(coords[0], clamp(coords[1], 0, 100) / 100, clamp(coords[2], 0, 100) / 100, alpha);
    default:
      return fromSpace(space, coords, alpha);
  }
}

/** Converts a Sass channel argument to channel units. */
function channelAmount(v: Value, info: ChannelInfo): number {
  if (info.hue) return asDegrees(v);
  const n = asNumber(v);
  if (n.unit === '%') return n.value * info.pct;
  if (n.unit === '') return n.value;
  return fail('bad channel unit');
}

type ChannelOp = 'adjust' | 'scale' | 'change';

function sassChannelFn(op: ChannelOp, args: CallArgs): Value {
  if (args.positional.length !== 1) return fail('expected one color');
  const color = asColor(args.positional[0]);
  let spaceName: ChannelSpace | undefined;
  const changes = new Map<string, Value>();
  let alpha: Value | undefined;
  for (const [key, value] of args.named) {
    if (key === 'space') {
      if (value.kind !== 'string') return fail('bad space');
      const s = value.value.toLowerCase();
      if (!(s in CHANNELS)) return fail('unsupported space');
      spaceName = s as ChannelSpace;
    } else if (key === 'alpha') alpha = value;
    else changes.set(key, value);
  }
  if (!spaceName) {
    // Infer a legacy space from the channel names, like dart-sass does for legacy colors.
    const spaces = new Set<ChannelSpace>();
    for (const key of changes.keys()) {
      const candidates = LEGACY.filter((s) => key in CHANNELS[s]);
      if (!candidates.length) return fail(`unknown channel ${key}`);
      if (candidates.length === 1) spaces.add(candidates[0]!);
    }
    if (spaces.size > 1) return fail('mixed channel spaces');
    spaceName = spaces.values().next().value ?? 'hsl';
  }
  const legacy = LEGACY.includes(spaceName);
  const coords = readChannels(color, spaceName);
  for (const [key, value] of changes) {
    const info = CHANNELS[spaceName][key];
    if (!info) return fail(`unknown channel ${key}`);
    const cur = coords[info.index]!;
    let next: number;
    if (op === 'scale') {
      if (info.hue || info.min === undefined || info.max === undefined) return fail('channel not scalable');
      const n = asNumber(value);
      if (n.unit !== '%') return fail('scale needs %');
      const f = inRange(n.value, -100, 100, 'scale') / 100;
      next = f > 0 ? cur + (info.max - cur) * f : cur + (cur - info.min) * f;
    } else {
      const amount = channelAmount(value, info);
      next = op === 'adjust' ? cur + amount : amount;
    }
    if (legacy && info.min !== undefined && info.max !== undefined) next = clamp(next, info.min, info.max);
    coords[info.index] = info.hue ? normalizeHue(next) : next;
  }
  let a = color.a;
  if (alpha !== undefined) {
    if (op === 'scale') {
      const n = asNumber(alpha);
      if (n.unit !== '%') return fail('scale needs %');
      const f = inRange(n.value, -100, 100, 'scale') / 100;
      a = f > 0 ? a + (1 - a) * f : a + a * f;
    } else {
      const v = asAlpha(alpha);
      a = clamp01(op === 'adjust' ? a + v : v);
    }
  }
  if (!changes.size) return colorValue({ ...color, a });
  return colorValue(writeChannels(spaceName, coords, a));
}

function sassMixFn(args: CallArgs): Value {
  const [c1, c2, weight, method] = bind(args, ['color1', 'color2', 'weight', 'method']);
  const w = weight === undefined ? 50 : inRange(asPercent(weight), 0, 100, 'weight');
  if (method !== undefined) {
    const words = method.kind === 'list' ? method.items : [method];
    const names = words.map((x) => (x.kind === 'string' ? x.value.toLowerCase() : fail('bad method')));
    const space = parseSpace(names[0]!);
    if (!space || names[0] === 'rgb') return fail('bad method space');
    let hue: HueMethod = 'shorter';
    if (names.length === 3 && names[2] === 'hue') hue = names[1] as HueMethod;
    else if (names.length !== 1) return fail('bad method');
    return colorValue(colorMix(space, hue, asColor(c1), w, asColor(c2), 100 - w));
  }
  return colorValue(sassMix(asColor(c1), asColor(c2), w));
}

const percentAmount = (v: Value | undefined): number => inRange(asPercent(v), 0, 100, 'amount');
const alphaAmount = (v: Value | undefined): number => inRange(asAlpha(v), 0, 1, 'amount');

function hslAdjuster(dir: 1 | -1, channel: 'saturation' | 'lightness') {
  return (args: CallArgs): Value => {
    const [c, amount] = bind(args, ['color', 'amount']);
    const d = dir * percentAmount(amount);
    return colorValue(adjustHsl(asColor(c), 0, channel === 'saturation' ? d : 0, channel === 'lightness' ? d : 0));
  };
}

function alphaAdjuster(dir: 1 | -1) {
  return (args: CallArgs): Value => {
    const [c, amount] = bind(args, ['color', 'amount']);
    const color = asColor(c);
    return colorValue({ ...color, a: clamp01(color.a + dir * alphaAmount(amount)) });
  };
}

const COLOR_ARG = (args: CallArgs): Color => asColor(bind(args, ['color'])[0]);

/** If the first argument is not a color, the call is the CSS filter function of the same name. */
const isFilterCall = (args: CallArgs): boolean => args.positional[0]?.kind === 'number';

function sassInvert(args: CallArgs): Value | undefined {
  if (isFilterCall(args)) return undefined;
  const [c, weight, space] = bind(args, ['color', 'weight', 'space']);
  if (space !== undefined) return fail('invert space unsupported');
  const color = asColor(c);
  const inverse: Color = { r: 1 - color.r, g: 1 - color.g, b: 1 - color.b, a: color.a };
  const w = weight === undefined ? 100 : inRange(asPercent(weight), 0, 100, 'weight');
  return colorValue(sassMix(inverse, color, w));
}

function sassGrayscale(args: CallArgs): Value | undefined {
  if (isFilterCall(args)) return undefined;
  const c = COLOR_ARG(args);
  const [h, , l] = hslOf(c);
  return colorValue(fromHsl(h, 0, l, c.a));
}

function sassSaturate(args: CallArgs): Value | undefined {
  // `saturate($amount)` with a single number is the CSS filter function.
  if (args.positional.length === 1 && !args.named.size && isFilterCall(args)) return undefined;
  return hslAdjuster(1, 'saturation')(args);
}

const channelReader =
  (pick: (c: Color) => number, unit = '') =>
  (args: CallArgs): Value =>
    num(pick(COLOR_ARG(args)), unit);

/** Sass global functions (and their `sass:color` module names). */
const SASS_GLOBAL: Record<string, (args: CallArgs) => Value | undefined> = {
  lighten: hslAdjuster(1, 'lightness'),
  darken: hslAdjuster(-1, 'lightness'),
  saturate: sassSaturate,
  desaturate: hslAdjuster(-1, 'saturation'),
  'adjust-hue': (args) => {
    const [c, deg] = bind(args, ['color', 'degrees']);
    return colorValue(adjustHsl(asColor(c), asDegrees(deg), 0, 0));
  },
  opacify: alphaAdjuster(1),
  'fade-in': alphaAdjuster(1),
  transparentize: alphaAdjuster(-1),
  'fade-out': alphaAdjuster(-1),
  mix: sassMixFn,
  invert: sassInvert,
  grayscale: sassGrayscale,
  complement: (args) => {
    const c = COLOR_ARG(args);
    return colorValue(adjustHsl(c, 180, 0, 0));
  },
  'adjust-color': (args) => sassChannelFn('adjust', args),
  'scale-color': (args) => sassChannelFn('scale', args),
  'change-color': (args) => sassChannelFn('change', args),
  red: channelReader((c) => c.r * 255),
  green: channelReader((c) => c.g * 255),
  blue: channelReader((c) => c.b * 255),
  hue: channelReader((c) => hslOf(c)[0], 'deg'),
  saturation: channelReader((c) => hslOf(c)[1], '%'),
  lightness: channelReader((c) => hslOf(c)[2], '%'),
  alpha: (args) => (isFilterCall(args) ? undefined : num(COLOR_ARG(args).a)),
  opacity: (args) => (isFilterCall(args) ? undefined : num(COLOR_ARG(args).a)),
};

const SASS_COLOR_MODULE: Record<string, (args: CallArgs) => Value | undefined> = {
  adjust: (args) => sassChannelFn('adjust', args),
  scale: (args) => sassChannelFn('scale', args),
  change: (args) => sassChannelFn('change', args),
  mix: sassMixFn,
  invert: sassInvert,
  grayscale: sassGrayscale,
  complement: SASS_GLOBAL.complement!,
  red: SASS_GLOBAL.red!,
  green: SASS_GLOBAL.green!,
  blue: SASS_GLOBAL.blue!,
  hue: SASS_GLOBAL.hue!,
  saturation: SASS_GLOBAL.saturation!,
  lightness: SASS_GLOBAL.lightness!,
  alpha: SASS_GLOBAL.alpha!,
  opacity: SASS_GLOBAL.opacity!,
  hwb: (args) => cssHwb(args),
  // Converting between spaces never changes the color itself.
  'to-space': (args) => colorValue(asColor(args.positional[0])),
  'to-gamut': (args) => colorValue(asColor(args.positional[0])),
};

export function callSassGlobal(name: string, args: CallArgs): Value | undefined {
  const fn = SASS_GLOBAL[name];
  return fn ? fn(args) : callCssFunction(name, args, 'sass');
}

export function callSassColorModule(name: string, args: CallArgs): Value | undefined {
  const fn = SASS_COLOR_MODULE[name];
  if (fn) return fn(args);
  return fail(`unknown color.${name}`);
}

export const SASS_COLOR_FUNCTION_NAMES = new Set([...Object.keys(SASS_GLOBAL)].filter(
  (n) => !['red', 'green', 'blue', 'hue', 'saturation', 'lightness', 'alpha', 'opacity'].includes(n),
));

// ---------------------------------------------------------------------------
// Less color functions (basic)
// ---------------------------------------------------------------------------

const lessPercent = (v: Value | undefined): number => asPercent(v);

const LESS_FUNCTIONS: Record<string, (args: CallArgs) => Value> = {
  lighten: (a) => colorValue(adjustHsl(asColor(a.positional[0]), 0, 0, lessPercent(a.positional[1]))),
  darken: (a) => colorValue(adjustHsl(asColor(a.positional[0]), 0, 0, -lessPercent(a.positional[1]))),
  saturate: (a) => colorValue(adjustHsl(asColor(a.positional[0]), 0, lessPercent(a.positional[1]), 0)),
  desaturate: (a) => colorValue(adjustHsl(asColor(a.positional[0]), 0, -lessPercent(a.positional[1]), 0)),
  spin: (a) => colorValue(adjustHsl(asColor(a.positional[0]), asDegrees(a.positional[1]), 0, 0)),
  fade: (a) => colorValue({ ...asColor(a.positional[0]), a: clamp01(lessPercent(a.positional[1]) / 100) }),
  fadein: (a) => {
    const c = asColor(a.positional[0]);
    return colorValue({ ...c, a: clamp01(c.a + lessPercent(a.positional[1]) / 100) });
  },
  fadeout: (a) => {
    const c = asColor(a.positional[0]);
    return colorValue({ ...c, a: clamp01(c.a - lessPercent(a.positional[1]) / 100) });
  },
  mix: (a) =>
    colorValue(
      sassMix(asColor(a.positional[0]), asColor(a.positional[1]), a.positional[2] ? lessPercent(a.positional[2]) : 50),
    ),
  tint: (a) => colorValue(sassMix({ r: 1, g: 1, b: 1, a: 1 }, asColor(a.positional[0]), lessPercent(a.positional[1]))),
  shade: (a) => colorValue(sassMix({ r: 0, g: 0, b: 0, a: 1 }, asColor(a.positional[0]), lessPercent(a.positional[1]))),
  greyscale: (a) => colorValue(adjustHsl(asColor(a.positional[0]), 0, -100, 0)),
};

export function callLessFunction(name: string, args: CallArgs): Value | undefined {
  const fn = LESS_FUNCTIONS[name];
  return fn ? fn(args) : callCssFunction(name, args, 'less');
}

export const LESS_COLOR_FUNCTION_NAMES = new Set(Object.keys(LESS_FUNCTIONS));
