import * as vscode from 'vscode';
import { ProviderId } from './providers/types';
import { PROVIDERS } from './providers';

export const SECTION = 'byokComplete';

export interface Settings {
  enabled: boolean;
  provider: ProviderId;
  model: string;
  baseUrl: string;
  compatMode: 'fim' | 'chat';
  debounceMs: number;
  multiline: 'auto' | 'always' | 'never';
  maxTokens: number;
  maxLines: number;
  temperature: number;
  maxPrefixChars: number;
  maxSuffixChars: number;
  crossFileContext: boolean;
  crossFileChars: number;
  timeoutMs: number;
  disabledLanguages: string[];
  extraBody: Record<string, unknown>;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  const provider = c.get<ProviderId>('provider', 'codestral');
  const spec = PROVIDERS[provider] ?? PROVIDERS.codestral;
  return {
    enabled: c.get('enabled', true),
    provider: spec.id,
    model: c.get<string>('model', '').trim() || spec.defaultModel,
    baseUrl: c.get<string>('baseUrl', '').trim() || spec.baseUrl,
    compatMode: c.get('openaiCompatible.mode', 'chat'),
    debounceMs: c.get('debounceMs', 200),
    multiline: c.get('multiline', 'auto'),
    maxTokens: c.get('maxTokens', 256),
    maxLines: c.get('maxLines', 40),
    temperature: c.get('temperature', 0.1),
    maxPrefixChars: c.get('maxPrefixChars', 8000),
    maxSuffixChars: c.get('maxSuffixChars', 2000),
    crossFileContext: c.get('crossFileContext', true),
    crossFileChars: c.get('crossFileChars', 3000),
    timeoutMs: c.get('timeoutMs', 8000),
    disabledLanguages: c.get<string[]>('disabledLanguages', []),
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
