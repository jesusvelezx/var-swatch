/**
 * Classifies where a CSS custom property is defined: the default (root) value,
 * a theme variant (dark mode, data-theme, …) or a scoped override.
 */
export interface ThemeContext {
  kind: 'root' | 'variant' | 'scoped';
  /** Stable grouping key; variants with the same key are the same theme. */
  key: string;
  /** Human readable label, e.g. `[data-theme="dark"]`. */
  label: string;
  /** Which color scheme this context implies, used by `light-dark()`. */
  scheme?: 'light' | 'dark';
}

const ROOTISH = /^(?::root|html|:host|body|\*)$/i;
const ROOT_PREFIX = /^(?::root|html|:host|body)(?=[.[:#]|$)/i;
const THEME_WORD = /dark|light|theme|night|dim|contrast|scheme|mode|brand|palette/i;
const NEUTRAL_AT = /^@(?:layer|supports|scope)\b/i;
const SCHEME_MEDIA = /prefers-color-scheme\s*:\s*(dark|light)/i;

const stripNot = (s: string): string => s.replace(/:not\((?:[^()]|\([^()]*\))*\)/gi, '');

function schemeOf(text: string): 'light' | 'dark' | undefined {
  if (/\bdark\b|-dark\b|\bdark-|night/i.test(text)) return 'dark';
  if (/\blight\b|-light\b|\blight-/i.test(text)) return 'light';
  return undefined;
}

/** Collapses equivalent spellings: `html.dark` ≡ `:root.dark` ≡ `.dark`, quotes ignored. */
function normalizeQualifier(sel: string): string {
  return stripNot(sel)
    .replace(ROOT_PREFIX, '')
    .replace(/["']/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

const hasCombinator = (sel: string): boolean => /[\s>+~]/.test(sel.trim());

export function classify(selectors: string[], atRules: string[]): ThemeContext[] {
  let media: { scheme: 'light' | 'dark'; label: string } | undefined;
  let otherAt: string | undefined;
  for (const at of atRules) {
    if (NEUTRAL_AT.test(at)) continue;
    const m = SCHEME_MEDIA.exec(at);
    if (m && /^@media\b/i.test(at)) media = { scheme: m[1]!.toLowerCase() as 'light' | 'dark', label: at.trim() };
    else otherAt = at.trim();
  }
  if (!selectors.length) return [{ kind: 'scoped', key: 'scoped:(top level)', label: '(top level)' }];

  const out: ThemeContext[] = [];
  const seen = new Set<string>();
  const add = (ctx: ThemeContext): void => {
    if (seen.has(ctx.key)) return;
    seen.add(ctx.key);
    out.push(ctx);
  };
  for (const raw of selectors) {
    const sel = raw.trim().replace(/\s+/g, ' ');
    if (otherAt) {
      add({ kind: 'scoped', key: `scoped:${otherAt}|${sel}`, label: `${otherAt} ${sel}` });
      continue;
    }
    const base = stripNot(sel).trim();
    if (ROOTISH.test(base)) {
      if (media) add({ kind: 'variant', key: `media:${media.scheme}`, label: media.label, scheme: media.scheme });
      else add({ kind: 'root', key: 'root', label: sel });
      continue;
    }
    const qualifier = normalizeQualifier(sel);
    const themed = !hasCombinator(sel) && (ROOT_PREFIX.test(sel) || THEME_WORD.test(sel));
    if (themed && qualifier) {
      const scheme = media?.scheme ?? schemeOf(qualifier);
      const key = media ? `media:${media.scheme}|${qualifier}` : `sel:${qualifier}`;
      const label = media ? `${media.label} ${sel}` : sel;
      add({ kind: 'variant', key, label, scheme });
      continue;
    }
    add({ kind: 'scoped', key: `scoped:${sel}`, label: sel });
  }
  return out;
}
