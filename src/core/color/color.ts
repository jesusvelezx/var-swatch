/**
 * Color primitives. Colors are stored as sRGB channels in the 0..1 range
 * (unclamped, so out-of-gamut intermediate results survive) plus alpha.
 */
export interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function rgb(r: number, g: number, b: number, a = 1): Color {
  return { r, g, b, a };
}

export const clamp = (x: number, min: number, max: number): number =>
  x < min ? min : x > max ? max : x;

export const clamp01 = (x: number): number => clamp(x, 0, 1);

export function normalizeHue(h: number): number {
  const r = h % 360;
  return r < 0 ? r + 360 : r;
}

/** Clips a color into the sRGB gamut for display. */
export function clipToGamut(c: Color): Color {
  return { r: clamp01(c.r), g: clamp01(c.g), b: clamp01(c.b), a: clamp01(c.a) };
}

/** RGB → HSL. Returns hue in degrees (NaN when achromatic), saturation and lightness in 0..1. */
export function rgbToHsl(c: Color): [number, number, number] {
  const { r, g, b } = c;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = NaN;
  let s = 0;
  if (d !== 0) {
    s = l === 0 || l === 1 ? 0 : (max - l) / Math.min(l, 1 - l);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    // Out-of-gamut colors can yield a negative saturation (CSS Color 4 §7.1).
    if (s < 0) {
      h += 180;
      s = Math.abs(s);
    }
    h = normalizeHue(h);
  }
  return [h, s, l];
}

/** HSL → RGB (CSS Color 4 algorithm). Saturation/lightness in 0..1, hue in degrees. */
export function hslToRgb(h: number, s: number, l: number, a = 1): Color {
  const hue = Number.isNaN(h) ? 0 : normalizeHue(h);
  const f = (n: number): number => {
    const k = (n + hue / 30) % 12;
    const amp = s * Math.min(l, 1 - l);
    return l - amp * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: f(0), g: f(8), b: f(4), a };
}

/** RGB → HWB. Hue in degrees (NaN when achromatic), whiteness/blackness in 0..1. */
export function rgbToHwb(c: Color): [number, number, number] {
  const [h] = rgbToHsl(c);
  const w = Math.min(c.r, c.g, c.b);
  const bk = 1 - Math.max(c.r, c.g, c.b);
  return [h, w, bk];
}

export function hwbToRgb(h: number, w: number, bk: number, a = 1): Color {
  if (w + bk >= 1) {
    const gray = w / (w + bk);
    return { r: gray, g: gray, b: gray, a };
  }
  const base = hslToRgb(h, 1, 0.5);
  const k = 1 - w - bk;
  return { r: base.r * k + w, g: base.g * k + w, b: base.b * k + w, a };
}

export function parseHex(text: string): Color | undefined {
  const hex = text.startsWith('#') ? text.slice(1) : text;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return undefined;
  const ch = (s: string): number => parseInt(s, 16) / 255;
  switch (hex.length) {
    case 3:
    case 4:
      return {
        r: ch(hex[0]! + hex[0]),
        g: ch(hex[1]! + hex[1]),
        b: ch(hex[2]! + hex[2]),
        a: hex.length === 4 ? ch(hex[3]! + hex[3]) : 1,
      };
    case 6:
    case 8:
      return {
        r: ch(hex.slice(0, 2)),
        g: ch(hex.slice(2, 4)),
        b: ch(hex.slice(4, 6)),
        a: hex.length === 8 ? ch(hex.slice(6, 8)) : 1,
      };
    default:
      return undefined;
  }
}

const to255 = (x: number): number => Math.round(clamp01(x) * 255);
const hex2 = (n: number): string => n.toString(16).padStart(2, '0');

export function toHex(c: Color): string {
  const base = `#${hex2(to255(c.r))}${hex2(to255(c.g))}${hex2(to255(c.b))}`;
  return c.a < 1 ? base + hex2(to255(c.a)) : base;
}

const fmt = (n: number, digits = 2): string => {
  const s = n.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

export function toRgbString(c: Color): string {
  const body = `${to255(c.r)} ${to255(c.g)} ${to255(c.b)}`;
  return c.a < 1 ? `rgb(${body} / ${fmt(c.a)})` : `rgb(${body})`;
}

export function toHslString(c: Color): string {
  const [h, s, l] = rgbToHsl(clipToGamut(c));
  const body = `${fmt(Number.isNaN(h) ? 0 : h, 1)} ${fmt(s * 100, 1)}% ${fmt(l * 100, 1)}%`;
  return c.a < 1 ? `hsl(${body} / ${fmt(c.a)})` : `hsl(${body})`;
}

/** Serializes a color as valid CSS (hex when opaque, rgb() with alpha otherwise). */
export function toCss(c: Color): string {
  return c.a < 1 ? toRgbString(c) : toHex(c);
}

export function sameColor(x: Color, y: Color, eps = 0.5 / 255): boolean {
  return (
    Math.abs(clamp01(x.r) - clamp01(y.r)) <= eps &&
    Math.abs(clamp01(x.g) - clamp01(y.g)) <= eps &&
    Math.abs(clamp01(x.b) - clamp01(y.b)) <= eps &&
    Math.abs(x.a - y.a) <= 0.5 / 255
  );
}

// prettier-ignore
const NAMED_HEX = 'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32';

let namedMap: Map<string, string> | undefined;

export function namedColor(name: string): Color | undefined {
  const key = name.toLowerCase();
  if (key === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (!namedMap) {
    namedMap = new Map(NAMED_HEX.split(',').map((p) => p.split(':') as [string, string]));
  }
  const hex = namedMap.get(key);
  return hex ? parseHex(hex) : undefined;
}
