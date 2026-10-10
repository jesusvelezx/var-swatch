/**
 * CSS Color 4 color space conversions (matrices from the CSS Color 4 spec).
 * Every space converts through linear sRGB / XYZ-D65.
 */
import { type Color, hslToRgb, hwbToRgb, normalizeHue, rgbToHsl, rgbToHwb } from './color';

export type Space =
  | 'srgb'
  | 'srgb-linear'
  | 'display-p3'
  | 'xyz-d65'
  | 'xyz-d50'
  | 'lab'
  | 'lch'
  | 'oklab'
  | 'oklch'
  | 'hsl'
  | 'hwb';

export type Coords = [number, number, number];
type Mat = readonly [readonly [number, number, number], readonly [number, number, number], readonly [number, number, number]];

const mul = (m: Mat, [x, y, z]: Coords): Coords => [
  m[0][0] * x + m[0][1] * y + m[0][2] * z,
  m[1][0] * x + m[1][1] * y + m[1][2] * z,
  m[2][0] * x + m[2][1] * y + m[2][2] * z,
];

const SRGB_TO_XYZ: Mat = [
  [506752 / 1228815, 87881 / 245763, 12673 / 70218],
  [87098 / 409605, 175762 / 245763, 12673 / 175545],
  [7918 / 409605, 87881 / 737289, 1001167 / 1053270],
];
const XYZ_TO_SRGB: Mat = [
  [12831 / 3959, -329 / 214, -1974 / 3959],
  [-851781 / 878810, 1648619 / 878810, 36519 / 878810],
  [705 / 12673, -2585 / 12673, 705 / 667],
];
const P3_TO_XYZ: Mat = [
  [608311 / 1250200, 189793 / 714400, 198249 / 1000160],
  [35783 / 156275, 247089 / 357200, 198249 / 2500400],
  [0, 32229 / 714400, 5220557 / 5000800],
];
const XYZ_TO_P3: Mat = [
  [446124 / 178915, -333277 / 357830, -72051 / 178915],
  [-14852 / 17905, 63121 / 35810, 423 / 17905],
  [11844 / 330415, -50337 / 660830, 316169 / 330415],
];
const D65_TO_D50: Mat = [
  [1.0479297925449969, 0.022946870601609652, -0.05019226628920524],
  [0.02962780877005599, 0.9904344267538799, -0.017073799063418826],
  [-0.009243040646204504, 0.015055191490298152, 0.7518742814281371],
];
const D50_TO_D65: Mat = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124],
];
const XYZ_TO_LMS: Mat = [
  [0.819022437996703, 0.3619062600528904, -0.1288737815209879],
  [0.0329836539323885, 0.9292868615863434, 0.0361446663506424],
  [0.0481771893596242, 0.2642395317527308, 0.6335478284694309],
];
const LMS_TO_XYZ: Mat = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816],
];
const LMS_TO_OKLAB: Mat = [
  [0.210454268309314, 0.7936177747023054, -0.0040720430116193],
  [1.9779985324311684, -2.42859224204858, 0.450593709617411],
  [0.0259040424655478, 0.7827717124575296, -0.8086757549230774],
];
const OKLAB_TO_LMS: Mat = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092],
];

const D50_WHITE: Coords = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
const EPS = 216 / 24389;
const KAPPA = 24389 / 27;

const toLinear = (v: number): number => {
  const a = Math.abs(v);
  return a <= 0.04045 ? v / 12.92 : Math.sign(v) * ((a + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v: number): number => {
  const a = Math.abs(v);
  return a > 0.0031308 ? Math.sign(v) * (1.055 * a ** (1 / 2.4) - 0.055) : 12.92 * v;
};

function xyzD50ToLab(xyz: Coords): Coords {
  const f = xyz.map((v, i) => {
    const x = v / D50_WHITE[i]!;
    return x > EPS ? Math.cbrt(x) : (KAPPA * x + 16) / 116;
  }) as Coords;
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

function labToXyzD50([l, a, b]: Coords): Coords {
  const f1 = (l + 16) / 116;
  const f0 = a / 500 + f1;
  const f2 = f1 - b / 200;
  const x = f0 ** 3 > EPS ? f0 ** 3 : (116 * f0 - 16) / KAPPA;
  const y = l > KAPPA * EPS ? ((l + 16) / 116) ** 3 : l / KAPPA;
  const z = f2 ** 3 > EPS ? f2 ** 3 : (116 * f2 - 16) / KAPPA;
  return [x * D50_WHITE[0], y * D50_WHITE[1], z * D50_WHITE[2]];
}

/** Hue is "powerless" below these chroma values and is reported as NaN (missing). */
const ACHROMATIC = { lch: 1e-3, oklch: 4e-6 } as const;

function toPolar([l, a, b]: Coords, eps: number): Coords {
  const c = Math.hypot(a, b);
  const h = c < eps ? NaN : normalizeHue((Math.atan2(b, a) * 180) / Math.PI);
  return [l, c, h];
}

function fromPolar([l, c, h]: Coords): Coords {
  if (Number.isNaN(h)) return [l, 0, 0];
  const rad = (h * Math.PI) / 180;
  return [l, c * Math.cos(rad), c * Math.sin(rad)];
}

const srgbToXyz = (c: Color): Coords => mul(SRGB_TO_XYZ, [toLinear(c.r), toLinear(c.g), toLinear(c.b)]);

export function toSpace(c: Color, space: Space): Coords {
  switch (space) {
    case 'srgb':
      return [c.r, c.g, c.b];
    case 'srgb-linear':
      return [toLinear(c.r), toLinear(c.g), toLinear(c.b)];
    case 'hsl':
      return rgbToHsl(c);
    case 'hwb':
      return rgbToHwb(c);
    case 'xyz-d65':
      return srgbToXyz(c);
    case 'xyz-d50':
      return mul(D65_TO_D50, srgbToXyz(c));
    case 'display-p3':
      return mul(XYZ_TO_P3, srgbToXyz(c)).map(fromLinear) as Coords;
    case 'lab':
      return xyzD50ToLab(mul(D65_TO_D50, srgbToXyz(c)));
    case 'lch':
      return toPolar(toSpace(c, 'lab'), ACHROMATIC.lch);
    case 'oklab': {
      const lms = mul(XYZ_TO_LMS, srgbToXyz(c)).map(Math.cbrt) as Coords;
      return mul(LMS_TO_OKLAB, lms);
    }
    case 'oklch':
      return toPolar(toSpace(c, 'oklab'), ACHROMATIC.oklch);
  }
}

export function fromSpace(space: Space, coords: Coords, alpha = 1): Color {
  const fromXyz = (xyz: Coords): Color => {
    const [r, g, b] = mul(XYZ_TO_SRGB, xyz).map(fromLinear) as Coords;
    return { r, g, b, a: alpha };
  };
  switch (space) {
    case 'srgb':
      return { r: coords[0], g: coords[1], b: coords[2], a: alpha };
    case 'srgb-linear':
      return { r: fromLinear(coords[0]), g: fromLinear(coords[1]), b: fromLinear(coords[2]), a: alpha };
    case 'hsl':
      return hslToRgb(coords[0], coords[1], coords[2], alpha);
    case 'hwb':
      return hwbToRgb(coords[0], coords[1], coords[2], alpha);
    case 'xyz-d65':
      return fromXyz(coords);
    case 'xyz-d50':
      return fromXyz(mul(D50_TO_D65, coords));
    case 'display-p3':
      return fromXyz(mul(P3_TO_XYZ, coords.map(toLinear) as Coords));
    case 'lab':
      return fromXyz(mul(D50_TO_D65, labToXyzD50(coords)));
    case 'lch':
      return fromSpace('lab', fromPolar(coords), alpha);
    case 'oklab': {
      const lms = mul(OKLAB_TO_LMS, coords).map((v) => v ** 3) as Coords;
      return fromXyz(mul(LMS_TO_XYZ, lms));
    }
    case 'oklch':
      return fromSpace('oklab', fromPolar(coords), alpha);
  }
}

/** Index of the hue coordinate for polar spaces, or -1. */
export function hueIndex(space: Space): number {
  switch (space) {
    case 'hsl':
    case 'hwb':
      return 0;
    case 'lch':
    case 'oklch':
      return 2;
    default:
      return -1;
  }
}

const SPACE_ALIASES: Record<string, Space> = {
  srgb: 'srgb',
  'srgb-linear': 'srgb-linear',
  'display-p3': 'display-p3',
  xyz: 'xyz-d65',
  'xyz-d65': 'xyz-d65',
  'xyz-d50': 'xyz-d50',
  lab: 'lab',
  lch: 'lch',
  oklab: 'oklab',
  oklch: 'oklch',
  hsl: 'hsl',
  hwb: 'hwb',
  rgb: 'srgb',
};

export function parseSpace(name: string): Space | undefined {
  return SPACE_ALIASES[name.toLowerCase()];
}
