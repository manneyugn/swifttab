export type ProviderId =
  // FIM-native clouds
  | 'codestral'
  | 'mistral'
  | 'deepseek'
  | 'inception'
  // Chat clouds
  | 'openai'
  | 'azure'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'groq'
  | 'together'
  | 'fireworks'
  | 'deepinfra'
  | 'xai'
  | 'cerebras'
  | 'huggingface'
  | 'qwen'
  | 'moonshot'
  | 'zai'
  // Self-hosted / local
  | 'ollama'
  | 'llamacpp'
  | 'lmstudio'
  | 'openaiCompatible';

export type ProviderMode = 'fim' | 'chat';

/** How a provider's wire protocol looks. */
export type ProviderKind = 'mistral' | 'openai' | 'anthropic' | 'gemini' | 'llamacpp';

/**
 * How FIM is requested on an OpenAI-style /completions endpoint:
 * - 'suffix': send `prompt` + `suffix` and let the server apply the model's template
 * - a template name: build the raw FIM prompt ourselves (vLLM, Together, Fireworks… reject `suffix`)
 */
export type FimTemplate = 'suffix' | 'qwen' | 'starcoder' | 'codellama' | 'deepseek' | 'codestral' | 'codegemma';

export type AuthStyle = 'bearer' | 'api-key' | 'x-api-key' | 'goog' | 'none';

export interface Snippet {
  path: string;
  text: string;
}

export interface CompletionRequest {
  /** Code before the cursor, without any context header. */
  prefix: string;
  /** Code after the cursor. */
  suffix: string;
  language: string;
  /** Workspace-relative path of the file being edited. */
  filePath: string;
  /** Workspace folder name (used by repo-level FIM templates). */
  repoName: string;
  /** Related code from other files, most relevant first. */
  snippets: Snippet[];
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
  extraHeaders: Record<string, string>;
  /** Resolved FIM template for OpenAI-style FIM ('suffix' or a template name). */
  fimTemplate: FimTemplate;
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
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  /** Mode used when `swiftTab.mode` is 'auto'. */
  defaultMode: ProviderMode;
  /** Modes this provider can do at all. */
  modes: ProviderMode[];
  /** FIM strategy for 'openai' kind when `swiftTab.fimTemplate` is 'auto' and the model gives no hint. */
  fim?: 'suffix' | 'template';
  /** Path of the FIM endpoint relative to the base URL (FIM-native providers). */
  fimPath?: string;
  auth?: AuthStyle;
  keyUrl: string;
  /** Base URL must be entered by the user (placeholder shown in the prompt). */
  needsBaseUrl?: string;
  /** Works without an API key (local servers, open gateways). */
  optionalKey?: boolean;
}
