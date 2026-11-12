import * as vscode from 'vscode';
import { FimTemplate, ProviderId, ProviderMode, ProviderSpec } from './providers/types';
import { PROVIDERS, resolveFimTemplate, resolveMode } from './providers';

export const SECTION = 'swiftTab';

export interface Settings {
  enabled: boolean;
  provider: ProviderId;
  spec: ProviderSpec;
  model: string;
  baseUrl: string;
  /** Resolved mode (setting + what the provider supports). */
  mode: ProviderMode;
  fimTemplate: FimTemplate;
  extraHeaders: Record<string, string>;
  debounceMs: number;
  multiline: 'auto' | 'always' | 'never';
  maxTokens: number;
  maxLines: number;
  temperature: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  crossFileContext: boolean;
  crossFileChars: number;
  workspaceContext: boolean;
  workspaceMaxFiles: number;
  timeoutMs: number;
  disabledLanguages: string[];
  suggestAfterAccept: boolean;
  extraBody: Record<string, unknown>;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  const provider = c.get<ProviderId>('provider', 'codestral');
  const spec = PROVIDERS[provider] ?? PROVIDERS.codestral;
  const model = c.get<string>('model', '').trim() || spec.defaultModel;
  let wanted = c.get<'auto' | ProviderMode>('mode', 'auto');
  if (wanted === 'auto' && spec.id === 'openaiCompatible') {
    // Older setting, still honoured.
    wanted = c.get<ProviderMode>('openaiCompatible.mode', 'chat');
  }
  return {
    enabled: c.get('enabled', true),
    provider: spec.id,
    spec,
    model,
    baseUrl: c.get<string>('baseUrl', '').trim() || spec.baseUrl,
    mode: resolveMode(spec, wanted),
    fimTemplate: resolveFimTemplate(spec, c.get<'auto' | FimTemplate>('fimTemplate', 'auto'), model),
    extraHeaders: c.get<Record<string, string>>('extraHeaders', {}) ?? {},
    debounceMs: c.get('debounceMs', 200),
    multiline: c.get('multiline', 'auto'),
    maxTokens: c.get('maxTokens', 256),
    maxLines: c.get('maxLines', 40),
    temperature: c.get('temperature', 0.1),
    maxPrefixChars: c.get('maxPrefixChars', 8000),
    maxSuffixChars: c.get('maxSuffixChars', 2000),
    crossFileContext: c.get('crossFileContext', true),
    crossFileChars: c.get('crossFileChars', 4000),
    workspaceContext: c.get('workspaceContext', true),
    workspaceMaxFiles: c.get('workspaceMaxFiles', 5000),
    timeoutMs: c.get('timeoutMs', 8000),
    disabledLanguages: c.get<string[]>('disabledLanguages', []),
    suggestAfterAccept: c.get('suggestAfterAccept', true),
    extraBody: c.get<Record<string, unknown>>('extraBody', {}) ?? {},
  };
}

export async function update(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}

/** API keys live in VS Code SecretStorage (OS keychain), never in settings.json. */
export class KeyStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private name(id: ProviderId): string {
    return `${SECTION}.apiKey.${id}`;
  }

  get(id: ProviderId): Thenable<string | undefined> {
    return this.secrets.get(this.name(id));
  }

  set(id: ProviderId, key: string): Thenable<void> {
    return this.secrets.store(this.name(id), key);
  }

  delete(id: ProviderId): Thenable<void> {
    return this.secrets.delete(this.name(id));
  }
}
