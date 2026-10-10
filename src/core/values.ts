import { type Color, toCss } from './color/color';

export type Value =
  | { kind: 'color'; color: Color }
  | { kind: 'number'; value: number; unit: string }
  | { kind: 'string'; value: string; quoted: boolean }
  | { kind: 'list'; items: Value[]; sep: ' ' | ',' | '/'; bracketed?: boolean }
  | { kind: 'map'; entries: [Value, Value][] }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  /** Plain CSS text that still contains `var()` (or other runtime constructs) and is resolved in the CSS phase. */
  | { kind: 'raw'; text: string };

/** Thrown whenever a value cannot be determined with certainty. Callers then show nothing. */
export class Unresolved extends Error {
  constructor(reason = 'unresolved') {
    super(reason);
  }
}

export const fail = (reason?: string): never => {
  throw new Unresolved(reason);
};

export const colorValue = (color: Color): Value => ({ kind: 'color', color });
export const num = (value: number, unit = ''): Value => ({ kind: 'number', value, unit });
export const str = (value: string, quoted = false): Value => ({ kind: 'string', value, quoted });
export const NULL: Value = { kind: 'null' };

export function asColor(v: Value | undefined): Color {
  if (v?.kind === 'color') return v.color;
  return fail('expected color');
}

export function asNumber(v: Value | undefined): { value: number; unit: string } {
  if (v?.kind === 'number') return v;
  return fail('expected number');
}

/** A percentage or unitless number, returned in percent units (10% → 10). */
export function asPercent(v: Value | undefined): number {
  const n = asNumber(v);
  if (n.unit === '%' || n.unit === '') return n.value;
  return fail('expected percentage');
}

/** An alpha-like value: unitless 0..1 or a percentage. Returns 0..1. */
export function asAlpha(v: Value | undefined): number {
  const n = asNumber(v);
  if (n.unit === '%') return n.value / 100;
  if (n.unit === '') return n.value;
  return fail('expected alpha');
}

/** An angle, returned in degrees. Unitless numbers count as degrees. */
export function asDegrees(v: Value | undefined): number {
  const n = asNumber(v);
  switch (n.unit) {
    case '':
    case 'deg':
      return n.value;
    case 'rad':
      return (n.value * 180) / Math.PI;
    case 'grad':
      return (n.value * 360) / 400;
    case 'turn':
      return n.value * 360;
    default:
      return fail('expected angle');
  }
}

const fmtNum = (n: number): string => {
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(10)));
};

/** Serializes a value to CSS text. */
export function toCssText(v: Value): string {
  switch (v.kind) {
    case 'color':
      return toCss(v.color);
    case 'number':
      return fmtNum(v.value) + v.unit;
    case 'string':
      return v.quoted ? JSON.stringify(v.value) : v.value;
    case 'list': {
      const sep = v.sep === ' ' ? ' ' : v.sep === ',' ? ', ' : ' / ';
      const body = v.items.map(toCssText).join(sep);
      return v.bracketed ? `[${body}]` : body;
    }
    case 'map':
      return fail('map is not CSS');
    case 'bool':
      return String(v.value);
    case 'null':
      return '';
    case 'raw':
      return v.text;
  }
}

export function valuesEqual(a: Value, b: Value): boolean {
  if (a.kind === 'string' && b.kind === 'string') return a.value === b.value;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'number':
      return b.kind === 'number' && a.value === b.value && a.unit === b.unit;
    case 'bool':
      return b.kind === 'bool' && a.value === b.value;
    case 'null':
      return true;
    default:
      return toCssText(a) === toCssText(b);
  }
}
