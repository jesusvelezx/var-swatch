# Var Swatch demo project

Press <kbd>F5</kbd> in the extension repo: this folder opens in the Extension
Development Host. Things to try:

| File | What it shows |
| --- | --- |
| `styles/main.scss` | `@use` namespaces, `@forward` prefixes, `with()`, `pkg:`, color functions, maps, user functions |
| `styles/legacy/_buttons.scss` | a partial resolved through the file that `@import`s it |
| `css/app.css` | `var()` chains, fallbacks, `rgba(var(--rgb), .25)`, `color-mix()`, theme variants (small extra squares) |
| `less/theme.less`, `sass/indented.sass` | Less and the indented Sass syntax |
| `components/*`, `pages/*`, `index.html` | `<style>` blocks and `style=""` attributes |

Hover any swatch for the resolution chain, the definition link and WCAG contrast.
