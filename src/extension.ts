import * as vscode from 'vscode';
import { KeyStore, readSettings, SECTION, update } from './config';
import { InlineProvider } from './completionProvider';
import { RecentDocs } from './context';
import { PROVIDERS } from './providers';
import { ProviderId } from './providers/types';
import { Status } from './statusBar';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('BYOK Autocomplete', { log: true });
  const keys = new KeyStore(context.secrets);
  const status = new Status();
  const recent = new RecentDocs();
  const inline = new InlineProvider(keys, status, recent, log);
  await inline.reload();

  const setApiKey = async (id?: ProviderId): Promise<boolean> => {
    const provider = id ?? readSettings().provider;
    const spec = PROVIDERS[provider];
    const key = await vscode.window.showInputBox({
      title: `API key for ${spec.label}`,
      prompt: spec.keyUrl ? `Get a key at ${spec.keyUrl}. Stored in your OS keychain.` : 'Stored in your OS keychain.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Key cannot be empty'),
    });
    if (!key) {
      return false;
    }
    await keys.set(provider, key.trim());
    await inline.reload();
    vscode.window.showInformationMessage(`BYOK Autocomplete: key saved for ${provider}.`);
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
    if (spec.needsBaseUrl) {
      const url = await vscode.window.showInputBox({
        title: 'Base URL of the OpenAI-compatible API',
        placeHolder: 'https://api.example.com/v1',
        value: readSettings().baseUrl,
        ignoreFocusOut: true,
      });
      if (url) {
        await update('baseUrl', url.trim());
      }
    } else {
      await update('baseUrl', '');
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
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, inline),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        inline.reload();
      }
    }),
    context.secrets.onDidChange((e) => {
      if (e.key.startsWith(`${SECTION}.apiKey.`)) {
        inline.reload();
      }
    }),
    vscode.commands.registerCommand('byokComplete.toggle', async () => {
      await update('enabled', !readSettings().enabled);
    }),
    vscode.commands.registerCommand('byokComplete.setApiKey', () => setApiKey()),
    vscode.commands.registerCommand('byokComplete.clearApiKey', async () => {
      const id = readSettings().provider;
      await keys.delete(id);
      await inline.reload();
      vscode.window.showInformationMessage(`BYOK Autocomplete: key removed for ${id}.`);
    }),
    vscode.commands.registerCommand('byokComplete.selectProvider', selectProvider),
    vscode.commands.registerCommand('byokComplete.selectModel', selectModel),
    vscode.commands.registerCommand('byokComplete.showLog', () => log.show()),
    vscode.commands.registerCommand('byokComplete.accepted', () => {
      status.accepted++;
      status.render();
    }),
    vscode.commands.registerCommand('byokComplete.statusMenu', async () => {
      const s = readSettings();
      const actions: (vscode.QuickPickItem & { run: () => unknown })[] = [
        {
          label: s.enabled ? '$(circle-slash) Disable autocomplete' : '$(sparkle) Enable autocomplete',
          run: () => update('enabled', !s.enabled),
        },
        { label: '$(server) Select provider', description: s.provider, run: selectProvider },
        { label: '$(symbol-class) Select model', description: s.model, run: selectModel },
        { label: '$(key) Set API key', description: s.provider, run: () => setApiKey() },
        { label: '$(output) Show log', run: () => log.show() },
        {
          label: '$(gear) Open settings',
          run: () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
        },
      ];
      const pick = await vscode.window.showQuickPick(actions, { title: 'BYOK Autocomplete' });
      await pick?.run();
    })
  );

  // First run: guide the user to a key (once; the status bar shows a key icon afterwards).
  if (!context.globalState.get('welcomed') && !(await keys.get(readSettings().provider))) {
    void context.globalState.update('welcomed', true);
    void vscode.window
      .showInformationMessage('BYOK Autocomplete needs an API key from your model provider.', 'Choose provider', 'Later')
      .then((choice) => (choice === 'Choose provider' ? selectProvider() : undefined));
  }
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
