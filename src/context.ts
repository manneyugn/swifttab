import * as vscode from 'vscode';
import { topSnippets, Snippet } from './similarity';

const HASH = new Set([
  'python', 'shellscript', 'ruby', 'yaml', 'perl', 'r', 'dockerfile', 'makefile', 'toml', 'powershell',
  'elixir', 'julia', 'coffeescript', 'nim', 'crystal', 'properties', 'ini',
]);
const DASH = new Set(['sql', 'lua', 'haskell', 'elm', 'ada', 'vhdl']);
const PERCENT = new Set(['latex', 'tex', 'matlab', 'erlang', 'prolog']);
const SEMI = new Set(['clojure', 'lisp', 'scheme', 'racket']);
const HTMLISH = new Set(['html', 'xml', 'vue-html', 'svg', 'xsl']);

export function commentLine(language: string, text: string): string {
  if (HASH.has(language)) {
    return `# ${text}`;
  }
  if (DASH.has(language)) {
    return `-- ${text}`;
  }
  if (PERCENT.has(language)) {
    return `% ${text}`;
  }
  if (SEMI.has(language)) {
    return `; ${text}`;
  }
  if (HTMLISH.has(language)) {
    return `<!-- ${text} -->`;
  }
  return `// ${text}`;
}

const FAMILIES: string[][] = [
  ['typescript', 'typescriptreact', 'javascript', 'javascriptreact', 'vue', 'svelte'],
  ['c', 'cpp', 'objective-c', 'objective-cpp', 'cuda-cpp'],
  ['css', 'scss', 'less', 'html'],
];

function related(a: string, b: string): boolean {
  return a === b || FAMILIES.some((f) => f.includes(a) && f.includes(b));
}

/** Tracks recently focused documents so cross-file context favours what you are working on. */
export class RecentDocs implements vscode.Disposable {
  private readonly order: string[] = [];
  private readonly sub: vscode.Disposable;

  constructor() {
    const touch = (e?: vscode.TextEditor) => {
      if (!e || e.document.uri.scheme !== 'file') {
        return;
      }
      const k = e.document.uri.toString();
      const i = this.order.indexOf(k);
      if (i >= 0) {
        this.order.splice(i, 1);
      }
      this.order.unshift(k);
      this.order.length = Math.min(this.order.length, 30);
    };
    touch(vscode.window.activeTextEditor);
    this.sub = vscode.window.onDidChangeActiveTextEditor(touch);
  }

  documents(exclude: vscode.Uri, language: string, max = 12): vscode.TextDocument[] {
    const open = new Map(vscode.workspace.textDocuments.map((d) => [d.uri.toString(), d]));
    const out: vscode.TextDocument[] = [];
    const ordered = [...this.order, ...open.keys()];
    const seen = new Set<string>();
    for (const k of ordered) {
      if (seen.has(k)) {
        continue;
      }
      seen.add(k);
      const d = open.get(k);
      if (!d || k === exclude.toString() || d.uri.scheme !== 'file' || !related(d.languageId, language)) {
        continue;
      }
      if (d.getText().length > 300_000) {
        continue;
      }
      out.push(d);
      if (out.length >= max) {
        break;
      }
    }
    return out;
  }

  dispose(): void {
    this.sub.dispose();
  }
}

export interface EditorContext {
  relPath: string;
  language: string;
  rawPrefix: string;
  suffix: string;
  linePrefix: string;
  lineSuffix: string;
  offset: number;
  snippets: Snippet[];
}

export function gatherContext(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  maxPrefix: number,
  maxSuffix: number,
  crossFileChars: number,
  recent: RecentDocs | undefined
): EditorContext {
  const offset = doc.offsetAt(pos);
  const text = doc.getText();

  // Align the prefix window to a line start and the suffix window to a line end.
  let start = Math.max(0, offset - maxPrefix);
  if (start > 0) {
    const nl = text.indexOf('\n', start);
    start = nl >= 0 && nl < offset ? nl + 1 : start;
  }
  let end = Math.min(text.length, offset + maxSuffix);
  if (end < text.length) {
    const nl = text.lastIndexOf('\n', end);
    end = nl > offset ? nl : end;
  }

  const line = doc.lineAt(pos.line).text;
  const relPath = vscode.workspace.asRelativePath(doc.uri, false);
  const rawPrefix = text.slice(start, offset);

  let snippets: Snippet[] = [];
  if (recent && crossFileChars > 0) {
    // The ~20 lines around the cursor are the best query for "what is relevant elsewhere".
    const query = text.slice(Math.max(0, offset - 1500), offset);
    const docs = recent.documents(doc.uri, doc.languageId).map((d) => ({
      path: vscode.workspace.asRelativePath(d.uri, false),
      text: d.getText(),
    }));
    snippets = topSnippets(query, docs, crossFileChars);
  }

  return {
    relPath,
    language: doc.languageId,
    rawPrefix,
    suffix: text.slice(offset, end),
    linePrefix: line.slice(0, pos.character),
    lineSuffix: line.slice(pos.character),
    offset,
    snippets,
  };
}

/** For FIM models: put file path and related snippets at the top of the prompt, as comments. */
export function fimHeader(ctx: EditorContext): string {
  const out: string[] = [];
  for (const s of ctx.snippets) {
    out.push(commentLine(ctx.language, `Path: ${s.path}`));
    for (const l of s.text.split('\n')) {
      out.push(commentLine(ctx.language, l));
    }
    out.push('');
  }
  out.push(commentLine(ctx.language, `Path: ${ctx.relPath}`));
  return out.join('\n') + '\n';
}

/** For chat models: related snippets as fenced blocks. */
export function chatCrossFile(ctx: EditorContext): string {
  return ctx.snippets.map((s) => `${s.path}:\n\`\`\`\n${s.text}\n\`\`\``).join('\n\n');
}
