import * as vscode from 'vscode';
import { KeyStore, readSettings, SECTION, update } from './config';
import { InlineProvider } from './completionProvider';
import { RecentDocs } from './context';
import { addDocComment } from './docComment';
import { WorkspaceIndex } from './workspaceIndex';
import { PROVIDERS } from './providers';
import { ProviderId } from './providers/types';
import { Status } from './statusBar';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('SwiftTab', { log: true });
  const keys = new KeyStore(context.secrets);
  const status = new Status();
  const recent = new RecentDocs();
  const workspace = new WorkspaceIndex(log);
  const indexSettings = () => {
    const s = readSettings();
    return `${s.crossFileContext && s.workspaceContext}|${s.workspaceMaxFiles}`;
  };
  let lastIndexSettings = indexSettings();
  const startIndex = () => {
    const s = readSettings();
    workspace.configure(s.crossFileContext && s.workspaceContext, s.workspaceMaxFiles);
  };
  startIndex();
  const inline = new InlineProvider(keys, status, recent, log, workspace);
  await inline.reload();

  const setApiKey = async (id?: ProviderId): Promise<boolean> => {
    const provider = id ?? readSettings().provider;
    const spec = PROVIDERS[provider];
    const where = spec.keyUrl ? `Get a key at ${spec.keyUrl}. ` : '';
    const key = await vscode.window.showInputBox({
      title: `API key for ${spec.label}`,
      prompt: spec.optionalKey
        ? `${where}Leave empty if the server needs no key. Stored in your OS keychain.`
        : `${where}Stored in your OS keychain.`,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() || spec.optionalKey ? undefined : 'Key cannot be empty'),
    });
    if (key === undefined) {
      return false;
    }
    if (key.trim()) {
      await keys.set(provider, key.trim());
    } else {
      await keys.delete(provider);
    }
    await inline.reload();
    vscode.window.showInformationMessage(
      `SwiftTab: ${key.trim() ? 'key saved' : 'no key'} for ${provider}.`
    );
    return true;
  };

  const selectModel = async (): Promise<void> => {
    const provider = inline.current();
    if (!provider) {
      if (!(await setApiKey())) {
        return;
      }
    }
    const p = inline.current();
    if (!p) {
      return;
    }
    let models: string[] = [];
    try {
      models = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Fetching models…', cancellable: true },
        (_progress, token) => {
          const ctrl = new AbortController();
          token.onCancellationRequested(() => ctrl.abort());
          return p.listModels(ctrl.signal);
        }
      );
    } catch (err: any) {
      log.warn(`listModels failed: ${err?.message ?? err}`);
    }
    const current = readSettings().model;
    const picks: vscode.QuickPickItem[] = models
      .sort()
      .map((m) => ({ label: m, description: m === current ? 'current' : undefined }));
    picks.unshift({ label: '$(edit) Enter a model ID…', alwaysShow: true });
    const pick = await vscode.window.showQuickPick(picks, {
      title: `Model for ${p.id}${p.mode === 'fim' ? ' (FIM)' : ' (chat) — pick a small, fast model'}`,
      placeHolder: models.length ? 'Search models' : 'Could not list models — enter one manually',
      matchOnDescription: true,
    });
    if (!pick) {
      return;
    }
    let model = pick.label;
    if (model.startsWith('$(edit)')) {
      const typed = await vscode.window.showInputBox({ title: 'Model ID', value: current, ignoreFocusOut: true });
      if (!typed) {
        return;
      }
      model = typed.trim();
    }
    await update('model', model);
  };

  const selectMode = async (id?: ProviderId): Promise<void> => {
    const spec = PROVIDERS[id ?? readSettings().provider];
    const items = [
      { label: 'Automatic', description: `provider default (${spec.defaultMode})`, value: 'auto' },
      ...(spec.modes.includes('fim')
        ? [{ label: 'FIM (fill-in-the-middle)', description: 'code-completion models: faster, cheaper', value: 'fim' }]
        : []),
      ...(spec.modes.includes('chat')
        ? [{ label: 'Chat', description: 'instruction models prompted to complete code', value: 'chat' }]
        : []),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Completion mode for ${spec.label}` });
    if (pick) {
      await update('mode', pick.value);
    }
  };

  const selectProvider = async (): Promise<void> => {
    const current = readSettings().provider;
    const items = await Promise.all(
      Object.values(PROVIDERS).map(async (spec) => ({
        label: spec.label,
        description: [spec.id === current ? 'current' : '', (await keys.get(spec.id)) ? '$(key) key set' : '']
          .filter(Boolean)
          .join(' · '),
        id: spec.id,
      }))
    );
    const pick = await vscode.window.showQuickPick(items, { title: 'Completion provider' });
    if (!pick) {
      return;
    }
    const spec = PROVIDERS[pick.id];
    await update('provider', spec.id);
    await update('model', '');
    if (spec.needsBaseUrl || spec.optionalKey) {
      // Self-hosted servers: ask where it runs (prefilled with the usual local address).
      const url = await vscode.window.showInputBox({
        title: `Base URL for ${spec.label}`,
        placeHolder: spec.needsBaseUrl ?? spec.baseUrl,
        value: spec.needsBaseUrl ? readSettings().baseUrl : spec.baseUrl,
        ignoreFocusOut: true,
      });
      if (url === undefined && spec.needsBaseUrl) {
        return;
      }
      await update('baseUrl', url?.trim() === spec.baseUrl ? '' : (url?.trim() ?? ''));
    } else {
      await update('baseUrl', '');
    }
    if (spec.modes.length > 1) {
      await selectMode(spec.id);
    }
    if (!(await keys.get(spec.id)) && !(await setApiKey(spec.id))) {
      return;
    }
    await inline.reload();
    if (!readSettings().model) {
      await selectModel();
    }
  };

  context.subscriptions.push(
    log,
    status,
    recent,
    workspace,
    vscode.workspace.onDidChangeWorkspaceFolders(() => startIndex()),
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inline),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        inline.reload();
        if (indexSettings() !== lastIndexSettings) {
          lastIndexSettings = indexSettings();
          startIndex();
        }
      }
    }),
    context.secrets.onDidChange((e) => {
      if (e.key.startsWith(`${SECTION}.apiKey.`)) {
        inline.reload();
      }
    }),
    vscode.commands.registerCommand('swiftTab.toggle', async () => {
      await update('enabled', !readSettings().enabled);
    }),
    vscode.commands.registerCommand('swiftTab.setApiKey', () => setApiKey()),
    vscode.commands.registerCommand('swiftTab.clearApiKey', async () => {
      const id = readSettings().provider;
      await keys.delete(id);
      await inline.reload();
      vscode.window.showInformationMessage(`SwiftTab: key removed for ${id}.`);
    }),
    vscode.commands.registerCommand('swiftTab.selectProvider', selectProvider),
    vscode.commands.registerCommand('swiftTab.selectModel', selectModel),
    vscode.commands.registerCommand('swiftTab.selectMode', () => selectMode()),
    vscode.commands.registerCommand('swiftTab.showLog', () => log.show()),
    vscode.commands.registerTextEditorCommand('swiftTab.addDocComment', (editor) => addDocComment(editor)),
    vscode.commands.registerCommand('swiftTab.accepted', () => {
      status.accepted++;
      status.render();
      if (readSettings().suggestAfterAccept) {
        // Ask for the next suggestion right away instead of waiting for a keystroke.
        inline.onAccepted();
        void vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
      }
    }),
    vscode.commands.registerCommand('swiftTab.statusMenu', async () => {
      const s = readSettings();
      const actions: (vscode.QuickPickItem & { run: () => unknown })[] = [
        {
          label: s.enabled ? '$(circle-slash) Disable autocomplete' : '$(sparkle) Enable autocomplete',
          run: () => update('enabled', !s.enabled),
        },
        { label: '$(server) Select provider', description: s.provider, run: selectProvider },
        { label: '$(symbol-class) Select model', description: s.model, run: selectModel },
        ...(s.spec.modes.length > 1
          ? [{ label: '$(settings) Select mode', description: s.mode, run: () => selectMode() }]
          : []),
        { label: '$(key) Set API key', description: s.provider, run: () => setApiKey() },
        { label: '$(output) Show log', run: () => log.show() },
        {
          label: '$(gear) Open settings',
          run: () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
        },
      ];
      const pick = await vscode.window.showQuickPick(actions, { title: 'SwiftTab' });
      await pick?.run();
    })
  );

  // First run: guide the user to a key (once; the status bar shows a key icon afterwards).
  const first = readSettings();
  if (!context.globalState.get('welcomed') && !first.spec.optionalKey && !(await keys.get(first.provider))) {
    void context.globalState.update('welcomed', true);
    void vscode.window
      .showInformationMessage('SwiftTab needs an API key from your model provider.', 'Choose provider', 'Later')
      .then((choice) => (choice === 'Choose provider' ? selectProvider() : undefined));
  }
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
