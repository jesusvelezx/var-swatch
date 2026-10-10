import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Analyzer, type Swatch, type Target } from './core/analyze';
import { type Color, clipToGamut, toHex, toHslString, toRgbString, toCss } from './core/color/color';
import { buildHover, type HoverLinks } from './core/hover';
import { type Entry, Project } from './core/project';
import type { Host } from './core/sassResolve';
import { type Config, readConfig } from './config';
import { globToRegExp, matchesAny } from './glob';

const LANGUAGES = ['css', 'scss', 'sass', 'less', 'html', 'vue', 'svelte', 'astro'];
const SELECTOR: vscode.DocumentSelector = [
  ...LANGUAGES.flatMap((language) => [
    { language, scheme: 'file' },
    { language, scheme: 'untitled' },
  ]),
  // .sass files opened without a Sass language extension.
  { pattern: '**/*.sass' },
];
const MAX_DOCUMENT = 3_000_000;
const EXT_FOR_LANGUAGE: Record<string, string> = { plaintext: 'sass' };

const nodeHost: Host = {
  readFile(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  isFile(file) {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  },
};

const toVsColor = (c: Color): vscode.Color => {
  const g = clipToGamut(c);
  return new vscode.Color(g.r, g.g, g.b, g.a);
};

interface Analysis {
  version: number;
  gen: number;
  entry: Entry;
  swatches: Swatch[];
}

class VarSwatch implements vscode.Disposable {
  private config: Config = readConfig();
  private project: Project;
  private analyzers!: { plain: Analyzer; literals: Analyzer };
  private readonly cache = new Map<string, Analysis>();
  private readonly versions = new Map<string, number>();
  private readonly disposables: vscode.Disposable[] = [];
  private watchers: vscode.Disposable[] = [];
  private colorProvider?: vscode.Disposable;
  private excludes: RegExp[] = [];
  private indexing?: vscode.CancellationTokenSource;
  private refreshTimer?: NodeJS.Timeout;
  private readonly syncTimers = new Map<string, NodeJS.Timeout>();
  private readonly inlineType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly variantTypes = [0, 1, 2].map(() =>
    vscode.window.createTextEditorDecorationType({ rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }),
  );
  private readonly output = vscode.window.createOutputChannel('Var Swatch', { log: true });

  constructor() {
    this.project = new Project(nodeHost, this.projectOptions());
    this.applyConfig();
  }

  start(): void {
    const d = this.disposables;
    this.registerColorProvider();
    d.push(
      vscode.languages.registerHoverProvider(SELECTOR, { provideHover: (doc, pos) => this.provideHover(doc, pos) }),
      vscode.commands.registerCommand('varSwatch.reindex', () => this.indexWorkspace()),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.onDocumentClosed(doc)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.updateDecorations()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('varSwatch')) this.onConfigChanged();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.project.setOptions(this.projectOptions());
        this.createWatchers();
        void this.indexWorkspace();
      }),
      this.output,
      this.inlineType,
      ...this.variantTypes,
    );
    this.createWatchers();
    void this.indexWorkspace();
  }

  dispose(): void {
    this.indexing?.cancel();
    clearTimeout(this.refreshTimer);
    for (const t of this.syncTimers.values()) clearTimeout(t);
    this.colorProvider?.dispose();
    for (const w of this.watchers) w.dispose();
    for (const d of this.disposables) d.dispose();
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  private projectOptions(): { loadPaths: string[]; roots: string[] } {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const base = roots[0] ?? process.cwd();
    return { loadPaths: this.config.loadPaths.map((p) => path.resolve(base, p)), roots };
  }

  private applyConfig(): void {
    const opts = { themes: this.config.themes };
    this.analyzers = {
      plain: new Analyzer(this.project, { ...opts, literals: false }),
      literals: new Analyzer(this.project, { ...opts, literals: true }),
    };
    this.excludes = this.config.exclude.map(globToRegExp);
    this.cache.clear();
  }

  private onConfigChanged(): void {
    const prev = this.config;
    this.config = readConfig();
    this.applyConfig();
    const reindex =
      JSON.stringify([prev.include, prev.exclude, prev.loadPaths, prev.maxFiles]) !==
      JSON.stringify([this.config.include, this.config.exclude, this.config.loadPaths, this.config.maxFiles]);
    if (reindex) {
      this.project.setOptions(this.projectOptions());
      this.createWatchers();
      void this.indexWorkspace();
    } else {
      this.scheduleRefresh(0);
    }
  }

  // -------------------------------------------------------------------------
  // Workspace index
  // -------------------------------------------------------------------------

  private isExcluded(file: string): boolean {
    const rel = vscode.workspace.asRelativePath(file, false);
    return matchesAny(rel, this.excludes);
  }

  private async indexWorkspace(): Promise<void> {
    this.indexing?.cancel();
    const cts = (this.indexing = new vscode.CancellationTokenSource());
    const token = cts.token;
    if (!this.config.enable || !vscode.workspace.workspaceFolders?.length) return;
    const started = Date.now();
    const work = (async () => {
      const exclude = this.config.exclude.length ? `{${this.config.exclude.join(',')}}` : undefined;
      const files = new Map<string, vscode.Uri>();
      for (const include of this.config.include) {
        const found = await vscode.workspace.findFiles(include, exclude, this.config.maxFiles, token);
        for (const uri of found) if (uri.scheme === 'file') files.set(uri.fsPath, uri);
        if (token.isCancellationRequested) return;
      }
      this.project.clear();
      this.versions.clear();
      this.cache.clear();
      const list = [...files.keys()].slice(0, this.config.maxFiles);
      const BATCH = 64;
      for (let i = 0; i < list.length; i += BATCH) {
        if (token.isCancellationRequested) return;
        const batch = list.slice(i, i + BATCH);
        const texts = await Promise.all(batch.map((f) => fs.promises.readFile(f, 'utf8').catch(() => undefined)));
        batch.forEach((f, k) => {
          const text = texts[k];
          if (text !== undefined) this.project.index(f, text);
        });
        // Yield to keep the extension host responsive.
        await new Promise((r) => setImmediate(r));
      }
      this.output.info(`Indexed ${list.length} files in ${Date.now() - started} ms`);
      this.scheduleRefresh(0);
    })();
    vscode.window.setStatusBarMessage('$(sync~spin) Var Swatch: indexing…', work);
    try {
      await work;
    } catch (e) {
      this.output.error(`Indexing failed: ${String(e)}`);
    }
  }

  private createWatchers(): void {
    for (const w of this.watchers) w.dispose();
    this.watchers = [];
    for (const include of this.config.include) {
      const watcher = vscode.workspace.createFileSystemWatcher(include);
      const openDirty = (uri: vscode.Uri): boolean =>
        vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString() && d.isDirty);
      watcher.onDidChange((uri) => {
        if (uri.scheme !== 'file' || openDirty(uri)) return;
        this.project.changed(uri.fsPath);
        this.scheduleRefresh();
      });
      watcher.onDidCreate((uri) => {
        if (uri.scheme !== 'file') return;
        const indexIt = !this.isExcluded(uri.fsPath);
        this.project.created(uri.fsPath, indexIt ? nodeHost.readFile(uri.fsPath) : undefined, indexIt);
        this.scheduleRefresh();
      });
      watcher.onDidDelete((uri) => {
        this.project.deleted(uri.fsPath);
        this.scheduleRefresh();
      });
      this.watchers.push(watcher);
    }
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  private docPath(doc: vscode.TextDocument): string {
    if (doc.uri.scheme === 'file') {
      // Plain-text .sass files: the path already has the right extension.
      return doc.uri.fsPath;
    }
    const ext = EXT_FOR_LANGUAGE[doc.languageId] ?? doc.languageId;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    return path.join(root, `.untitled-${doc.uri.path.replace(/\W/g, '_')}.${ext}`);
  }

  private isSupported(doc: vscode.TextDocument): boolean {
    return vscode.languages.match(SELECTOR, doc) > 0;
  }

  private sync(doc: vscode.TextDocument): Entry | undefined {
    const key = doc.uri.toString();
    const file = this.docPath(doc);
    if (this.versions.get(key) === doc.version) {
      const entry = this.project.get(file);
      if (entry?.overlay) return entry;
    }
    const text = doc.getText();
    if (text.length > MAX_DOCUMENT) return undefined;
    const entry = this.project.open(file, text);
    this.versions.set(key, doc.version);
    return entry;
  }

  private analysis(doc: vscode.TextDocument): Analysis | undefined {
    if (!this.config.enable || !this.isSupported(doc)) return undefined;
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (cached && cached.version === doc.version && cached.gen === this.project.gen) return cached;
    const entry = this.sync(doc);
    if (!entry) return undefined;
    const analyzer = doc.languageId === 'sass' || doc.languageId === 'plaintext' ? this.analyzers.literals : this.analyzers.plain;
    let swatches: Swatch[] = [];
    try {
      swatches = analyzer.analyze(entry);
    } catch (e) {
      this.output.error(`Analysis failed for ${doc.uri.fsPath}: ${String(e)}`);
    }
    const result: Analysis = { version: doc.version, gen: this.project.gen, entry, swatches };
    this.cache.set(key, result);
    return result;
  }

  private onDocumentChanged(doc: vscode.TextDocument): void {
    if (!this.isSupported(doc)) return;
    const key = doc.uri.toString();
    clearTimeout(this.syncTimers.get(key));
    this.syncTimers.set(
      key,
      setTimeout(() => {
        this.syncTimers.delete(key);
        if (doc.isClosed) return;
        this.sync(doc);
        this.updateDecorations();
        // Other visible documents may depend on this one: ask VS Code to re-request their colors.
        const others = vscode.window.visibleTextEditors.some((e) => e.document !== doc && this.isSupported(e.document));
        if (others) this.scheduleRefresh();
      }, 150),
    );
  }

  private onDocumentClosed(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    if (!this.versions.has(key)) return;
    this.versions.delete(key);
    this.cache.delete(key);
    this.project.closeOverlay(this.docPath(doc));
  }

  // -------------------------------------------------------------------------
  // Providers
  // -------------------------------------------------------------------------

  private registerColorProvider(): void {
    this.colorProvider?.dispose();
    this.colorProvider = vscode.languages.registerColorProvider(SELECTOR, {
      provideDocumentColors: (doc) => {
        if (!this.usesNativeColors()) return [];
        const a = this.analysis(doc);
        if (!a) return [];
        return a.swatches.map(
          (s) => new vscode.ColorInformation(new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.end)), toVsColor(s.color)),
        );
      },
      provideColorPresentations: (color, { document, range }) => {
        // Picking a color must never overwrite a variable reference: the first
        // presentation keeps the original text; literal formats are offered as alternatives.
        const original = document.getText(range);
        const keep = new vscode.ColorPresentation(original);
        keep.textEdit = vscode.TextEdit.replace(range, original);
        const c: Color = { r: color.red, g: color.green, b: color.blue, a: color.alpha };
        return [keep, ...[toHex(c), toRgbString(c), toHslString(c)].map((l) => new vscode.ColorPresentation(l))];
      },
    });
  }

  private usesNativeColors(): boolean {
    return this.config.decorationStyle === 'native' || this.config.decorationStyle === 'native+variants';
  }

  private usesInlineColors(): boolean {
    return this.config.decorationStyle === 'inline' || this.config.decorationStyle === 'inline+variants';
  }

  private usesVariantColors(): boolean {
    return this.config.decorationStyle === 'native+variants' || this.config.decorationStyle === 'inline+variants';
  }

  /** Re-registering the provider is the only way to make VS Code re-request colors. */
  private scheduleRefresh(delay = 400): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.registerColorProvider();
      this.updateDecorations();
    }, delay);
  }

  private readonly links: HoverLinks = {
    link: (loc) => vscode.Uri.file(loc.path).with({ fragment: `L${loc.line + 1},${loc.col + 1}` }).toString(),
    relative: (p) => vscode.workspace.asRelativePath(p, false),
  };

  private provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    if (!this.config.hover) return undefined;
    const a = this.analysis(doc);
    if (!a) return undefined;
    const offset = doc.offsetAt(pos);
    let target: Target | undefined;
    let start = 0;
    let end = 0;
    let best = Infinity;
    for (const s of a.swatches) {
      if (offset >= s.start && offset <= s.end && s.end - s.start < best) {
        best = s.end - s.start;
        target = s.target;
        start = s.start;
        end = s.end;
      }
    }
    const analyzer = doc.languageId === 'sass' ? this.analyzers.literals : this.analyzers.plain;
    if (!target) {
      const def = analyzer.definitionAt(a.entry, offset);
      if (!def) return undefined;
      ({ target, start, end } = def);
    }
    const ex = analyzer.explain(a.entry, target);
    if (!ex) return undefined;
    const md = new vscode.MarkdownString(buildHover(ex, this.links));
    return new vscode.Hover(md, new vscode.Range(doc.positionAt(start), doc.positionAt(end)));
  }

  // -------------------------------------------------------------------------
  // Theme variant decorations
  // -------------------------------------------------------------------------

  private updateDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const doc = editor.document;
      const a = this.usesInlineColors() || this.usesVariantColors() ? this.analysis(doc) : undefined;
      if (this.usesInlineColors() && a) {
        const options: vscode.DecorationOptions[] = [];
        for (const s of a.swatches) {
          const pos = doc.positionAt(s.end);
          const hex = toHex(clipToGamut(s.color));
          const md = new vscode.MarkdownString(`Resolved color: \`${hex}\``);
          options.push({
            range: new vscode.Range(pos, pos),
            hoverMessage: md,
            renderOptions: {
              after: {
                contentText: ' ',
                backgroundColor: toCss(clipToGamut(s.color)),
                border: '1px solid rgba(128, 128, 128, 0.75)',
                width: '0.72em',
                height: '0.72em',
                margin: '0 0.1em 0 0.35em',
                textDecoration: 'none; display: inline-block; vertical-align: middle; border-radius: 2px; box-sizing: border-box;',
              },
            },
          });
        }
        editor.setDecorations(this.inlineType, options);
      } else {
        editor.setDecorations(this.inlineType, []);
      }
      this.variantTypes.forEach((type, i) => {
        if (!a || !this.usesVariantColors()) {
          editor.setDecorations(type, []);
          return;
        }
        const options: vscode.DecorationOptions[] = [];
        for (const s of a.swatches) {
          const v = s.variants[i];
          if (!v) continue;
          const pos = doc.positionAt(s.end);
          const md = new vscode.MarkdownString(`**${v.label}**: \`${toHex(v.color)}\``);
          options.push({
            range: new vscode.Range(pos, pos),
            hoverMessage: md,
            renderOptions: {
              after: {
                contentText: '​',
                backgroundColor: toCss(clipToGamut(v.color)),
                border: '1px solid rgba(128, 128, 128, 0.7)',
                width: '0.7em',
                height: '0.7em',
                margin: i === 0 && !this.usesInlineColors() ? '0 0.1em 0 0.25em' : '0 0.1em 0 0',
                textDecoration: 'none; display: inline-block; vertical-align: middle; border-radius: 2px; box-sizing: border-box;',
              },
            },
          });
        }
        editor.setDecorations(type, options);
      });
    }
  }
}

let instance: VarSwatch | undefined;

export function activate(context: vscode.ExtensionContext): void {
  instance = new VarSwatch();
  context.subscriptions.push(instance);
  instance.start();
}

export function deactivate(): void {
  instance?.dispose();
  instance = undefined;
}
