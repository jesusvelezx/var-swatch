# Var Swatch

**See the real color behind every CSS custom property, Sass and Less variable, right in VS Code.**

VS Code only shows a color square next to literal values such as `white` or `#7c3aed`.
With `background: var(--purple)` or `color: $purple` you just see a name. Var Swatch
resolves those references, including through Sass modules, color functions, chains,
fallbacks and theme overrides, and shows the native color square plus a detailed hover.

<!-- TODO: replace with real recordings -->
![Swatches next to variables](docs/images/overview.gif)
![Hover with resolution chain and contrast](docs/images/hover.png)

## Features

| | |
| --- | --- |
| **Sass modules** | `@use 'colors' as c` → `c.$purple`, default namespaces, `@use … as *`, `@forward 'x' as brand-*` with `show` / `hide`, `@use … with (…)` (also through `@forward … with`), private members, `_index.scss`, `pkg:` URLs and `node_modules` |
| **Color functions** | `darken()`, `lighten()`, `saturate()`, `adjust-hue()`, `rgba($c, .5)`, `mix()`, `invert()`, `color.adjust()`, `color.scale()`, `color.change()`, `color.mix(…, $method)`, CSS `color-mix()`, `light-dark()`, `oklch()`, `lab()`, `color()`… computed with **dart-sass semantics** (`lighten` adds absolute HSL lightness, `scale-color` is relative) |
| **Chains** | `--primary: var(--purple)`, `$brand: $purple`, `$hover: darken($brand, 8%)` |
| **Fallbacks** | `var(--x, #fff)`, `var(--x, var(--y))`, and textual substitution like browsers do: `rgba(var(--bs-primary-rgb), .25)` |
| **Themes** | If `--purple` is redefined in `[data-theme="dark"]`, `.dark`, `html.high-contrast` or `@media (prefers-color-scheme: dark)`, every variant is shown as an extra square and listed in the hover, even through chains |
| **Hover** | Final value (hex / rgb / hsl), resolution chain `$brand → $purple → #7c3aed` with links to each definition, notes (configured by `with()`, fallback used, …) and WCAG contrast against white and black |
| **Never a fake color** | If a value can't be determined with certainty (mixin parameters, undefined or ambiguous variables, `currentColor`, `calc()`, `darken(var(--x))`, …) nothing is shown |
| **Lightweight** | No language server, zero runtime dependencies, a ~80 KB bundle. Incremental index: a file change re-parses only that file |

### Supported languages

`css`, `scss`, `sass` (indented syntax), `less` (basic: variables, imports and common color
functions), plus `<style>` blocks (with `lang="scss|sass|less"`) and `style="…"` attributes
in `html`, `vue`, `svelte` and `astro` files.

## How values are resolved

- **Sass**: the same rules as dart-sass. Local scopes, `!default`, `!global`, `@import`
  (including partials compiled in the context of the file that imports them),
  `@use` / `@forward` module semantics with configuration, user `@function`s with a
  single `@return`, `map.get()` / `map-get()`. URLs resolve relative to the file, then
  the configured load paths, then `node_modules` (`~` prefixes are accepted), trying
  `_partial`, `.scss` / `.sass` / `.css`, `index` files and `.import.scss`.
- **CSS custom properties**: `var()` is substituted textually like in the browser. The
  definition in the same rule wins; otherwise the root definition (`:root`, `html`, `:host`)
  from the current file, its imports, or a unique one in the workspace. Inside a custom
  property, Sass only evaluates `#{…}` interpolation, exactly like the compiler.
- **Themes**: definitions under theme selectors or `prefers-color-scheme` media queries
  are grouped into variants; each variant re-evaluates the whole chain.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `varSwatch.enable` | `true` | Enable the extension. |
| `varSwatch.include` | `["**/*.{css,scss,sass,less}"]` | Files indexed in the workspace. Add `vue`, `svelte`, … to index definitions inside components. |
| `varSwatch.exclude` | `node_modules`, `dist`, `build`, `out`, `.git`, `*.min.css` | Excluded from indexing. Files reached through `@use`/`@import` are still resolved on demand. |
| `varSwatch.maxFiles` | `5000` | Upper bound for the initial index. |
| `varSwatch.loadPaths` | `[]` | Extra Sass load paths, relative to the workspace folder. |
| `varSwatch.themes.enable` | `true` | Detect theme overrides and show every variant. |
| `varSwatch.decoration.style` | `native+variants` | `native` (only the native square), `native+variants` (plus small squares for theme variants) or `none` (hover only). |
| `varSwatch.hover.enable` | `true` | Show the resolution hover. |

Command: **Var Swatch: Reindex Workspace**.

## Performance

Measured on a synthetic workspace of 4,000 SCSS files (16.6 MB, 240,000 definitions):
initial index in ~0.6 s using ~70 MB, re-indexing a changed file in under 1 ms, and
analyzing a document with 120 swatches in ~4–7 ms. A typical project uses a few MB.

The index stores only definitions, module rules and block structure per file (no ASTs),
open documents are kept as live overlays, and indexing runs in batches that yield to
the extension host.

## Design notes

- **Own tokenizer instead of postcss / postcss-scss.** One small scanner handles CSS,
  SCSS, Less, embedded styles *and* the indented Sass syntax (which postcss can't parse).
  It recovers from half-typed code instead of throwing, and keeps a compact index
  instead of full ASTs, which is the main source of memory use in similar tools.
- **Own color engine, no culori.** Sass functions must match dart-sass exactly (HSL
  clamping, `mix()` alpha weighting, channel scaling), so they are implemented directly.
  The CSS Color 4 conversions (oklab/oklch/lab/lch/display-p3/xyz) are a few hundred
  lines with the spec's matrices, so the extension has no runtime dependencies at all.
- **Verified against dart-sass.** The test suite compiles real Sass (functions, module
  graphs with `@forward`/`with()`/`pkg:`, and the demo project) and compares every
  swatch with the compiled output.

## Known limitations

- `calc()`, relative color syntax (`rgb(from …)`), `@if` / `@each` inside functions and
  mixin output are not evaluated (nothing is shown).
- Less support covers variables, `@import` and common color functions only.
- Theme variants are detected for CSS custom properties; Sass variables have no runtime themes.

## Development

The extension runs on the Node.js bundled with VS Code (targets Node 20). The dev tooling
(vitest 5, vsce 4) needs Node 22+ and pnpm.

```sh
pnpm install
pnpm test          # vitest: parser, resolver and color engine (compared against dart-sass)
pnpm run typecheck
pnpm run build     # esbuild → dist/extension.js
pnpm run package   # production build + .vsix
```

Press <kbd>F5</kbd> to launch an Extension Development Host with
[`fixtures/demo-project`](fixtures/demo-project), which exercises every feature.

## License

[MIT](LICENSE)
