import * as vscode from 'vscode';
import { CodeIndex, INDEXED_EXTENSIONS, familyOfPath, looksGenerated } from './codeIndex';

const EXCLUDE =
  '**/{node_modules,.git,dist,build,out,target,vendor,.venv,venv,env,__pycache__,.next,.nuxt,coverage,Pods,.gradle,bin,obj,.dart_tool,.turbo,.cache}/**';
const MAX_FILE_BYTES = 200_000;

/**
 * Keeps a CodeIndex of the workspace up to date: an initial background scan, then
 * re-indexing on save, create and delete. Everything stays in memory on this machine;
 * only the few snippets chosen for a completion are sent to the provider.
 */
export class WorkspaceIndex implements vscode.Disposable {
  readonly index = new CodeIndex();
  private readonly subs: vscode.Disposable[] = [];
  private scanning?: Promise<void>;
  private generation = 0;

  constructor(private readonly log: vscode.LogOutputChannel) {}

  /** (Re)starts indexing, or stops it when disabled. */
  configure(enabled: boolean, maxFiles: number): void {
    this.stop();
    if (!enabled || !vscode.workspace.workspaceFolders?.length) {
      return;
    }
    const gen = ++this.generation;
    const glob = `**/*.{${INDEXED_EXTENSIONS.join(',')}}`;
    const watcher = vscode.workspace.createFileSystemWatcher(glob);
    this.subs.push(
      watcher,
      watcher.onDidCreate((u) => this.indexFile(u)),
      watcher.onDidChange((u) => this.indexFile(u)),
      watcher.onDidDelete((u) => this.index.remove(this.key(u))),
      vscode.workspace.onDidSaveTextDocument((d) => this.indexText(d.uri, d.getText()))
    );
    this.scanning = this.scan(glob, maxFiles, gen);
  }

  private stop(): void {
    this.generation++;
    this.subs.splice(0).forEach((d) => d.dispose());
  }

  private key(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, false);
  }

  private async scan(glob: string, maxFiles: number, gen: number): Promise<void> {
    const started = Date.now();
    const uris = await vscode.workspace.findFiles(glob, EXCLUDE, maxFiles);
    for (let i = 0; i < uris.length; i++) {
      if (gen !== this.generation) {
        return;
      }
      await this.indexFile(uris[i]);
      // Yield to the extension host every few files so typing stays smooth.
      if (i % 25 === 24) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    this.log.info(
      `Workspace index: ${this.index.files} files, ${this.index.size} chunks in ${Date.now() - started} ms` +
        (uris.length >= maxFiles ? ` (limit of ${maxFiles} files reached; raise swiftTab.workspaceMaxFiles)` : '')
    );
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file' || /\/(node_modules|\.git|dist|build|out|target|vendor)\//.test(uri.path)) {
      return;
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) {
        this.index.remove(this.key(uri));
        return;
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.indexText(uri, new TextDecoder().decode(bytes));
    } catch {
      this.index.remove(this.key(uri));
    }
  }

  private indexText(uri: vscode.Uri, text: string): void {
    const path = this.key(uri);
    if (!familyOfPath(path) || text.length > MAX_FILE_BYTES || looksGenerated(path, text)) {
      this.index.remove(path);
      return;
    }
    this.index.upsert(path, text);
  }

  /** Resolves when the first scan is done (for status / tests). */
  ready(): Promise<void> {
    return this.scanning ?? Promise.resolve();
  }

  dispose(): void {
    this.stop();
  }
}
