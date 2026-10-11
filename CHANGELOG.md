# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-10

### Added

- `varSwatch.decoration.highlight` setting: paints each resolved variable with its own color as a background.
- `varSwatch.decoration.highlightOpacity` setting (0–1) to tone down the highlight background.

## [0.1.2] - 2026-10-10

### Changed

- Default variable previews now use Var Swatch inline decorations instead of VS Code's native color square.
- Added `inline` and `inline+variants` decoration modes while keeping the native modes available.

## [0.1.1] - 2026-10-10

### Changed

- Marketplace metadata (publisher, gallery banner, categories, keywords, repository links) and extension icon.

## [0.1.0] - 2026-10-10

### Added

- Native color squares and hovers for CSS custom properties, Sass and Less variables.
- Sass module support: `@use` (namespaces, `as *`, `with()`), `@forward` (prefixes,
  `show`/`hide`, `with()`), `@import`, partials, index files, load paths, `pkg:` URLs
  and `node_modules`.
- Color functions with dart-sass semantics (`lighten`, `darken`, `mix`, `rgba`,
  `color.adjust`, `color.scale`, `color.change`, `color.mix`, …), CSS `color-mix()`,
  `light-dark()` and CSS Color 4 color spaces.
- Variable chains, `var()` fallbacks and textual `var()` substitution.
- Theme variants from `[data-theme]`, theme classes and `prefers-color-scheme`.
- Hover with resolution chain, definition links, notes and WCAG contrast.
- Languages: CSS, SCSS, indented Sass, Less, and styles embedded in HTML, Vue,
  Svelte and Astro.
- Incremental workspace index with a file system watcher.
- Settings for include/exclude globs, load paths, themes and decoration style.
