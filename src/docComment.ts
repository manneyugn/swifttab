import * as vscode from 'vscode';
import { cursorLanguage } from './embedded';
import { docSkeleton, docStyle, hasDocAbove } from './prompt';

const DOCUMENTABLE = new Set([
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Constructor,
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
]);

/** Innermost function/method/class containing the position, from the language server's symbols. */
async function enclosingSymbol(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.DocumentSymbol | undefined> {
  let symbols: vscode.DocumentSymbol[] | undefined;
  try {
    symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      'vscode.executeDocumentSymbolProvider',
      doc.uri
    );
  } catch {
    return undefined;
  }
  let best: vscode.DocumentSymbol | undefined;
  const walk = (list: vscode.DocumentSymbol[] | undefined) => {
    for (const s of list ?? []) {
      // SymbolInformation (flat) results have no `range`/`children` shape we can use.
      if (!s.range) {
        continue;
      }
      if (s.range.contains(pos) || s.range.start.line === pos.line) {
        if (DOCUMENTABLE.has(s.kind)) {
          best = s;
        }
        walk(s.children);
      }
    }
  };
  walk(symbols);
  return best;
}

/** For Python: the line where the signature ends (`def f(\n  a,\n) -> int:`). */
function signatureEnd(doc: vscode.TextDocument, start: number): number {
  for (let l = start; l < Math.min(doc.lineCount, start + 30); l++) {
    if (/:\s*(#.*)?$/.test(doc.lineAt(l).text)) {
      return l;
    }
  }
  return start;
}

/**
 * Inserts a doc-comment skeleton for the function/class at the cursor and asks for an inline
 * suggestion to fill it. The user sees the generated comment as ghost text and accepts with Tab.
 */
export async function addDocComment(editor: vscode.TextEditor): Promise<void> {
  const doc = editor.document;
  const pos = editor.selection.active;
  const style = docStyle(cursorLanguage(doc.languageId, doc.getText(new vscode.Range(0, 0, pos.line, pos.character))).language);
  const sym = await enclosingSymbol(doc, pos);
  const declLine = sym ? sym.selectionRange.start.line : pos.line;
  // Decorators/attributes belong below the comment: start from the symbol's full range.
  const startLine = sym ? Math.min(sym.range.start.line, declLine) : pos.line;
  const name = sym?.name.replace(/\(.*$/, '') ?? '';
  const indent = doc.lineAt(declLine).text.match(/^\s*/)![0];

  let at: number;
  let skeleton;
  if (style.kind === 'docstring') {
    const end = signatureEnd(doc, declLine);
    const next = end + 1 < doc.lineCount ? doc.lineAt(end + 1).text : '';
    if (/^\s*[rRbBuU]?("""|''')/.test(next)) {
      vscode.window.showInformationMessage('SwiftTab: this already has a docstring.');
      return;
    }
    const unit = editor.options.insertSpaces === false ? '\t' : ' '.repeat(Number(editor.options.tabSize) || 4);
    const nextIndent = next.match(/^\s*/)![0];
    const bodyIndent = next.trim() && nextIndent.length > indent.length ? nextIndent : indent + unit;
    at = end + 1;
    skeleton = docSkeleton(style, bodyIndent);
  } else {
    if (hasDocAbove(style, startLine > 0 ? doc.lineAt(startLine - 1).text : undefined)) {
      vscode.window.showInformationMessage('SwiftTab: this already has a doc comment.');
      return;
    }
    at = startLine;
    skeleton = docSkeleton(style, indent, name);
  }

  const ok = await editor.edit((e) => e.insert(new vscode.Position(at, 0), skeleton.text));
  if (!ok) {
    return;
  }
  const cursor = new vscode.Position(at + skeleton.cursorLine, skeleton.cursorChar);
  editor.selection = new vscode.Selection(cursor, cursor);
  editor.revealRange(new vscode.Range(cursor, cursor));
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
}
