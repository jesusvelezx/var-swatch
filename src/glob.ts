/** Minimal glob → RegExp (supports `**`, `*`, `?`, `{a,b}` and `[...]`), matched against `/`-separated paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let braces = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories.
        const slash = glob[i + 2] === '/';
        re += slash ? '(?:.*/)?' : '.*';
        i += slash ? 3 : 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces) {
      braces--;
      re += ')';
    } else if (c === ',' && braces) re += '|';
    else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end > i) {
        re += glob.slice(i, end + 1).replace(/^\[!/, '[^');
        i = end + 1;
        continue;
      }
      re += '\\[';
    } else re += /[.+^$()|\\]/.test(c) ? `\\${c}` : c;
    i++;
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

export function matchesAny(relativePath: string, globs: RegExp[]): boolean {
  const p = relativePath.replace(/\\/g, '/');
  return globs.some((g) => g.test(p));
}
