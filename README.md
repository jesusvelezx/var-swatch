# Var Swatch

**See the real color behind every CSS custom property, Sass and Less variable, right in VS Code.**

VS Code only shows a color square next to literal values such as `white` or `#7c3aed`.
With `background: var(--purple)` or `color: $purple` you just see a name. Var Swatch
resolves those references, including through Sass modules, color functions, chains,
fallbacks and theme overrides, and shows the color inline plus a detailed hover.

<!-- TODO: replace with real recordings -->
![Swatches next to variables](docs/images/overview.gif)
![Hover with resolution chain and contrast](docs/images/hover.png)

## Getting started

1. Install **Var Swatch** from the Visual Studio Marketplace, or run
   `ext install uxjesus.var-swatch` in the Quick Open panel (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>P</kbd>).
2. Open any `.css`, `.scss`, `.sass` or `.less` file (or a component with a `<style>` block).
3. That's it. Every variable whose color can be resolved gets a small square after it.
   Hover over it to see where the color comes from.

No configuration is required. If you want a different look, see
[Customizing the look](#customizing-the-look).

## Customizing the look

Var Swatch can show colors in a few ways. Mix and match the two settings below to get
the style you like.

### Swatch style: `varSwatch.decoration.style`

| Value | What you see |
| --- | --- |
| `inline+variants` *(default)* | A square after each variable, plus smaller squares for each theme variant (dark mode, high contrast…). |
| `inline` | Only the square after each variable. |
| `native` | VS Code's own color square before the variable (clicking it opens the color picker). |
| `native+variants` | VS Code's square plus the small theme variant squares. |
| `none` | No squares. You still get the hover. |

### Highlight: `varSwatch.decoration.highlight` and `varSwatch.decoration.highlightOpacity`

Turn on `highlight` to paint the variable name itself with its color, like a tag. The
text automatically switches to black or white so it stays readable. In
`#{$color-primary}` only `$color-primary` is painted.

Use `highlightOpacity` (from `0` to `1`) to make the background softer. Below `0.5` the
text keeps your theme's normal color, because the background is too faint to decide
between black and white.

The highlight works together with any swatch style, so you can keep the square too.

### Ready-made setups

Open your settings (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>,</kbd>, then the
**Open Settings (JSON)** icon at the top right) and paste one of these.

#### Minimal: just a square (the default)

```json
"varSwatch.decoration.style": "inline+variants",
"varSwatch.decoration.highlight": false
```

#### Highlighted names: color tags plus the square

```json
"varSwatch.decoration.style": "inline+variants",
"varSwatch.decoration.highlight": true,
"varSwatch.decoration.highlightOpacity": 1
```

#### Soft highlight: a subtle tint, no squares

```json
"varSwatch.decoration.style": "none",
"varSwatch.decoration.highlight": true,
"varSwatch.decoration.highlightOpacity": 0.35
```

#### VS Code's native square (with the built-in color picker)

```json
"varSwatch.decoration.style": "native"
```

You can also change these from the Settings UI: search for **Var Swatch**. Changes apply
right away, no reload needed. To use a style only in one project, put the settings in that
project's `.vscode/settings.json`.

## Features

| | |
| --- | --- |
| **Sass modules** | `@use 'colors' as c` → `c.$purple`, default namespaces, `@use … as *`, `@forward 'x' as brand-*` with `show` / `hide`, `@use … with (…)` (also through `@forward … with`), private members, `_index.scss`, `pkg:` URLs and `node_modules` |
| **Color functions** | `darken()`, `lighten()`, `saturate()`, `adjust-hue()`, `rgba($c, .5)`, `mix()`, `invert()`, `color.adjust()`, `color.scale()`, `color.change()`, `color.mix(…, $method)`, CSS `color-mix()`, `light-dark()`, `oklch()`, `lab()`, `color()`… computed with **dart-sass semantics** (`lighten` adds absolute HSL lightness, `scale-color` is relative) |
| **Chains** | `--primary: var(--purple)`, `$brand: $purple`, `$hover: darken($brand, 8%)` |
| **Fallbacks** | `var(--x, #fff)`, `var(--x, var(--y))`, and textual substitution like browsers do: `rgba(var(--bs-primary-rgb), .25)` |
| **Themes** | If `--purple` is redefined in `[data-theme="dark"]`, `.dark`, `html.high-contrast` or `@media (prefers-color-scheme: dark)`, every variant is shown as an extra square and listed in the hover, even through chains |
| **Hover** | Final value (hex / rgb / hsl), resolution chain `$brand → $purple → #7c3aed` with links to each definition, notes (configured by `with()`, fallback used, …) and WCAG contrast against white and black |
| **Customizable** | Squares, VS Code's native square, colored highlights with adjustable opacity, or hover only. See [Customizing the look](#customizing-the-look) |
| **Never a fake color** | If a value can't be determined with certainty (mixin parameters, undefined or ambiguous variables, `currentColor`, `calc()`, `darken(var(--x))`, …) nothing is shown |
| **Lightweight** | No language server, zero runtime dependencies, a ~80 KB bundle. Incremental index: a file change re-parses only that file |

### Supported languages

`css`, `scss`, `sass` (indented syntax), `less` (basic: variables, imports and common color
functions), plus `<style>` blocks (with `lang="scss|sass|less"`) and `style="…"` attributes
in `html`, `vue`, `svelte` and `astro` files.

## All settings

| Setting | Default | Description |
| --- | --- | --- |
| `varSwatch.enable` | `true` | Turn the extension on or off. |
| `varSwatch.decoration.style` | `inline+variants` | How colors are shown: `inline`, `inline+variants`, `native`, `native+variants` or `none`. See [Swatch style](#swatch-style-varswatchdecorationstyle). |
| `varSwatch.decoration.highlight` | `false` | Paint the variable name with its color. Works with any `decoration.style`. |
| `varSwatch.decoration.highlightOpacity` | `1` | Opacity of the highlight background, from `0` (transparent) to `1` (solid). Below `0.5` the text keeps the theme's color. |
| `varSwatch.hover.enable` | `true` | Show the hover with the resolution chain, source links and contrast. |
| `varSwatch.themes.enable` | `true` | Detect theme overrides and show every variant. |
| `varSwatch.include` | `["**/*.{css,scss,sass,less}"]` | Files indexed in the workspace. Add `vue`, `svelte`, … to find variables defined inside components. |
| `varSwatch.exclude` | `node_modules`, `dist`, `build`, `out`, `.git`, `*.min.css` | Files skipped when indexing. Files reached through `@use`/`@import` are still resolved on demand. |
| `varSwatch.loadPaths` | `[]` | Extra Sass load paths, relative to the workspace folder. |
| `varSwatch.maxFiles` | `5000` | Upper limit of files indexed at startup. |

Command: **Var Swatch: Reindex Workspace** (from the Command Palette, <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>).

## Troubleshooting

- **A variable has no color.** Var Swatch only shows a color when it is certain. Hover over
  the variable to see why, and check the [known limitations](#known-limitations).
- **Variables defined in another file aren't found.** Make sure that file matches
  `varSwatch.include` and isn't in `varSwatch.exclude`. For Sass imports from custom folders,
  add them to `varSwatch.loadPaths`. Then run **Var Swatch: Reindex Workspace**.
- **I see two squares per variable.** Another color extension (or VS Code's own
  `editor.colorDecorators`) is also drawing squares. Disable one of them, or set
  `varSwatch.decoration.style` to `none` and use the highlight instead.
- **The highlight text is hard to read.** Raise `varSwatch.decoration.highlightOpacity` to
  `0.5` or more so the text switches to black or white.

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

## Known limitations

- `calc()`, relative color syntax (`rgb(from …)`), `@if` / `@each` inside functions and
  mixin output are not evaluated (nothing is shown).
- Less support covers variables, `@import` and common color functions only.
- Theme variants are detected for CSS custom properties; Sass variables have no runtime themes.

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

To try the extension, launch **Run Extension (fixtures)** from the Run and Debug view
(<kbd>F5</kbd>, or <kbd>fn</kbd>+<kbd>F5</kbd> on a Mac keyboard). It opens an Extension
Development Host with [`fixtures/demo-project`](fixtures/demo-project), which exercises
every feature. Without the debugger:

```sh
pnpm run build
code --extensionDevelopmentPath="$PWD" --disable-extensions fixtures/demo-project
```

## License

[MIT](LICENSE)
