import { CompletionProvider, ProviderConfig, ProviderId, ProviderSpec } from './types';
import { FimProvider } from './fim';
import { AnthropicProvider, GeminiProvider, OpenAIChatProvider } from './chat';

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  codestral: {
    id: 'codestral',
    label: 'Mistral Codestral (codestral.mistral.ai) — FIM, recommended',
    baseUrl: 'https://codestral.mistral.ai',
    defaultModel: 'codestral-latest',
    keyUrl: 'https://console.mistral.ai/codestral',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral (api.mistral.ai) — FIM',
    baseUrl: 'https://api.mistral.ai',
    defaultModel: 'codestral-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek (FIM beta)',
    baseUrl: 'https://api.deepseek.com/beta',
    defaultModel: 'deepseek-v4-flash',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  openaiCompatible: {
    id: 'openaiCompatible',
    label: 'OpenAI-compatible API (Groq, Together, Fireworks, …)',
    baseUrl: '',
    defaultModel: '',
    keyUrl: '',
    needsBaseUrl: true,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI — chat models',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: '',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude — chat models',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-haiku-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini — chat models',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: '',
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter — chat models',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: '',
    keyUrl: 'https://openrouter.ai/keys',
  },
};

export function createProvider(id: ProviderId, cfg: ProviderConfig, compatMode: 'fim' | 'chat'): CompletionProvider {
  switch (id) {
    case 'codestral':
    case 'mistral':
      return new FimProvider(id, 'mistral', cfg);
    case 'deepseek':
      return new FimProvider(id, 'openai', cfg);
    case 'openaiCompatible':
      return compatMode === 'fim' ? new FimProvider(id, 'openai', cfg) : new OpenAIChatProvider(id, cfg);
    case 'openai':
    case 'openrouter':
      return new OpenAIChatProvider(id, cfg);
    case 'anthropic':
      return new AnthropicProvider(cfg);
    case 'gemini':
      return new GeminiProvider(cfg);
  }
}
