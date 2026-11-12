export type ProviderId =
  | 'codestral'
  | 'mistral'
  | 'deepseek'
  | 'openaiCompatible'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter';

export type ProviderMode = 'fim' | 'chat';

export interface CompletionRequest {
  /** Code before the cursor (may include a context header). */
  prefix: string;
  /** Code after the cursor. */
  suffix: string;
  language: string;
  filePath: string;
  /** Snippets from other files, already formatted, used by chat providers. */
  crossFile: string;
  multiline: boolean;
  maxTokens: number;
  temperature: number;
  stop: string[];
  model: string;
  signal: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  extraBody: Record<string, unknown>;
}

export interface CompletionProvider {
  readonly id: ProviderId;
  readonly mode: ProviderMode;
  /** Streams text deltas. Calls onUsage if the API reports token usage. */
  stream(req: CompletionRequest, onUsage: (u: Usage) => void): AsyncGenerator<string>;
  listModels(signal: AbortSignal): Promise<string[]>;
}

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  baseUrl: string;
  defaultModel: string;
  keyUrl: string;
  needsBaseUrl?: boolean;
}
