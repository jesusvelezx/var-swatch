/**
 * Builds the hover markdown (pure, no vscode dependency):
 * final value, resolution chain with links, notes, WCAG contrast and theme variants.
 */
import type { Explanation } from './analyze';
import { type Color, toHex, toHslString, toRgbString } from './color/color';
import { BLACK, WHITE, contrastRatio, wcagLevel } from './color/contrast';
import type { Location, Trace } from './resolver';

export interface HoverLinks {
  /** A URI string that opens the location. */
  link(loc: Location): string;
  /** Workspace-relative display path. */
  relative(path: string): string;
}

const code = (s: string): string => {
  const clean = s.replace(/\s+/g, ' ').trim();
  const short = clean.length > 60 ? clean.slice(0, 57) + '…' : clean;
  const ticks = short.includes('`') ? '``' : '`';
  return `${ticks}${short}${ticks}`;
};

/** A small inline SVG swatch (checkerboard behind translucent colors). */
export function swatchImage(c: Color, size = 12): string {
  const fill = toHex(c);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    (c.a < 1
      ? `<rect width="${size}" height="${size}" fill="#fff"/><path d="M0 0h${size / 2}v${size / 2}H0zM${size / 2} ${size / 2}h${size / 2}v${size / 2}h-${size / 2}z" fill="#ccc"/>`
      : '') +
    `<rect width="${size}" height="${size}" fill="${fill}" stroke="#8888" stroke-width="1"/></svg>`;
  return `![](data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')})`;
}

const isRef = (expr: string | undefined, label: string): boolean => {
  if (!expr) return false;
  const e = expr.replace(/\s+/g, '');
  const l = label.replace(/\s+/g, '');
  return e === l || e === `var(${l})` || e.startsWith(`var(${l},`) || e === `#{${l}}`;
};

function step(t: Trace, links: HoverLinks): string {
  return t.loc ? `[${code(t.label)}](${links.link(t.loc)})` : code(t.label);
}

interface Chain {
  parts: string[];
  tail: Trace;
  notes: string[];
}

/** Follows direct references (`$a: $b`) from `start` and collects the steps. */
function follow(start: Trace, links: HoverLinks): Chain {
  const parts: string[] = [];
  const notes: string[] = [];
  let cur = start;
  for (;;) {
    parts.push(step(cur, links));
    if (cur.note) notes.push(`${code(cur.label)} — ${cur.note}`);
    const only = cur.children.length === 1 ? cur.children[0]! : undefined;
    if (only && isRef(cur.expr, only.label)) {
      cur = only;
      continue;
    }
    break;
  }
  if (cur.expr && cur.children.length) parts.push(code(cur.expr));
  return { parts, tail: cur, notes };
}

export function chainLines(ex: Explanation, links: HoverLinks): { main: string; via: string[]; notes: string[]; first?: Trace } {
  const root = ex.trace;
  const final = code(toHex(ex.color));
  const only = root.children.length === 1 ? root.children[0]! : undefined;
  let chain: Chain;
  if (only && isRef(ex.text, only.label)) chain = follow(only, links);
  else chain = { parts: [code(ex.text)], tail: root, notes: [] };
  const via: string[] = [];
  const notes = [...chain.notes];
  // Expressions with several references: show where each input comes from.
  if (chain.tail.children.length && (chain.tail === root || chain.tail.expr)) {
    for (const child of chain.tail.children.slice(0, 6)) {
      const sub = follow(child, links);
      notes.push(...sub.notes);
      const result = sub.tail.result ? ` → ${code(sub.tail.result)}` : '';
      via.push(`${sub.parts.join(' → ')}${result}`);
    }
  }
  const last = chain.parts[chain.parts.length - 1];
  const main = last === final ? chain.parts.join(' → ') : [...chain.parts, final].join(' → ');
  return { main, via, notes, first: only ?? root.children[0] };
}

export function buildHover(ex: Explanation, links: HoverLinks): string {
  const c = ex.color;
  const lines: string[] = [];
  lines.push(`${swatchImage(c, 14)} **${toHex(c)}** · ${code(toRgbString(c))} · ${code(toHslString(c))}`);
  lines.push('');
  const { main, via, notes, first } = chainLines(ex, links);
  lines.push(main);
  if (via.length) {
    lines.push('');
    for (const v of via) lines.push(`- ${v}`);
  }
  if (notes.length) {
    lines.push('');
    for (const n of notes) lines.push(`_${n}_  `);
  }
  if (first?.loc) {
    lines.push('');
    lines.push(`Defined in [${links.relative(first.loc.path)}:${first.loc.line + 1}](${links.link(first.loc)})`);
  }
  lines.push('');
  lines.push('| Contrast | Ratio | WCAG |');
  lines.push('|:--|--:|:--|');
  for (const [name, bg] of [['on white', WHITE], ['on black', BLACK]] as const) {
    const r = contrastRatio(c, bg);
    const level = wcagLevel(r);
    lines.push(`| ${name} | ${r.toFixed(2)}:1 | ${level === 'Fail' ? '✗ Fail' : `✓ ${level}`} |`);
  }
  if (ex.variants.length) {
    lines.push('');
    lines.push('**Theme variants**');
    lines.push('');
    for (const v of ex.variants) lines.push(`- ${swatchImage(v.color)} ${code(toHex(v.color))} — ${code(v.label)}`);
  }
  return lines.join('\n');
}
