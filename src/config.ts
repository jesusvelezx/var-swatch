import * as vscode from 'vscode';

export type DecorationStyle = 'native' | 'native+variants' | 'inline' | 'inline+variants' | 'none';

export interface Config {
  enable: boolean;
  include: string[];
  exclude: string[];
  maxFiles: number;
  loadPaths: string[];
  themes: boolean;
  decorationStyle: DecorationStyle;
  hover: boolean;
}

export function readConfig(): Config {
  const c = vscode.workspace.getConfiguration('varSwatch');
  return {
    enable: c.get('enable', true),
    include: c.get('include', ['**/*.{css,scss,sass,less}']),
    exclude: c.get('exclude', ['**/node_modules/**']),
    maxFiles: c.get('maxFiles', 5000),
    loadPaths: c.get('loadPaths', []),
    themes: c.get('themes.enable', true),
    decorationStyle: c.get<DecorationStyle>('decoration.style', 'inline+variants'),
    hover: c.get('hover.enable', true),
  };
}
