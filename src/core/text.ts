export type Syntax = 'css' | 'scss' | 'sass' | 'less';

export function syntaxFromPath(path: string): Syntax | 'embedded' | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'css':
    case 'pcss':
    case 'postcss':
      return 'css';
    case 'scss':
      return 'scss';
    case 'sass':
      return 'sass';
    case 'less':
      return 'less';
    case 'html':
    case 'htm':
    case 'vue':
    case 'svelte':
    case 'astro':
      return 'embedded';
    default:
      return undefined;
  }
}

const isIdentChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95 || c > 127;

/** Index just past a quoted string starting at `i` (stops at an unescaped newline). */
export function skipString(src: string, i: number): number {
  const q = src.charCodeAt(i);
  let j = i + 1;
  while (j < src.length) {
    const c = src.charCodeAt(j);
    if (c === 92 /* \ */) j += 2;
    else if (c === q) return j + 1;
    else if (c === 10) return j;
    else j++;
  }
  return j;
}

/** If `url(` (unquoted) starts at `i`, returns the index just past its `)`. */
export function skipUrl(src: string, i: number): number | undefined {
  if ((src.charCodeAt(i) | 32) !== 117 || src.slice(i, i + 4).toLowerCase() !== 'url(') return undefined;
  if (i > 0 && isIdentChar(src.charCodeAt(i - 1))) return undefined;
  let j = i + 4;
  while (j < src.length && /\s/.test(src[j]!)) j++;
  const c = src.charCodeAt(j);
  if (c === 34 || c === 39) return undefined; // quoted url: regular string handling is enough
  while (j < src.length) {
    const d = src.charCodeAt(j);
    if (d === 41 /* ) */) return j + 1;
    if (d === 10) return j;
    if (d === 92) j++;
    j++;
  }
  return j;
}

const blankOut = (s: string): string => s.replace(/[^\r\n]/g, ' ');

/**
 * Replaces comments with spaces (newlines are kept) so that offsets into the
 * result are offsets into the original text.
 */
export function maskComments(src: string, lineComments: boolean, indented = false): string {
  let out = '';
  let last = 0;
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 34 || c === 39) {
      i = skipString(src, i);
      continue;
    }
    if (c === 47 /* / */) {
      const d = src.charCodeAt(i + 1);
      if (d === 42 /* * */) {
        const end = src.indexOf('*/', i + 2);
        let stop = end < 0 ? n : end + 2;
        if (indented) {
          // Indented syntax: block comments without */ end with the line.
          const eol = src.indexOf('\n', i);
          if (eol >= 0 && (end < 0 || eol < end)) stop = eol;
          else if (end < 0) stop = n;
        }
        out += src.slice(last, i) + blankOut(src.slice(i, stop));
        last = i = stop;
        continue;
      }
      if (d === 47 && lineComments) {
        let stop = src.indexOf('\n', i);
        if (stop < 0) stop = n;
        if (src.charCodeAt(stop - 1) === 13) stop--;
        out += src.slice(last, i) + blankOut(src.slice(i, stop));
        last = i = stop;
        continue;
      }
    }
    if (c === 117 || c === 85) {
      const end = skipUrl(src, i);
      if (end !== undefined) {
        i = end;
        continue;
      }
    }
    i++;
  }
  return last === 0 ? src : out + src.slice(last);
}

export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** Zero-based line/column of `offset`. */
export function lineCol(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo]! };
}

/**
 * Splits `text` at top-level occurrences of `sep` (outside parentheses,
 * brackets, strings and interpolation). Returns [start, end) pairs.
 */
export function splitTopLevel(text: string, sep: string, from = 0, to = text.length): [number, number][] {
  const out: [number, number][] = [];
  let depth = 0;
  let start = from;
  let i = from;
  while (i < to) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = Math.min(skipString(text, i), to);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0 && c === sep) {
      out.push([start, i]);
      start = i + 1;
    }
    i++;
  }
  out.push([start, to]);
  return out;
}

/** Finds the index of the parenthesis matching the one at `open`, or -1. */
export function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      i = skipString(text, i) - 1;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Trims whitespace from a [start, end) range of `text`. */
export function trimRange(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return [start, end];
}

/** Sass treats `-` and `_` as equivalent in identifiers. */
export const normalizeSassName = (name: string): string => name.replace(/_/g, '-');
