import { CompletionProvider, FimTemplate, ProviderConfig, ProviderId, ProviderMode, ProviderSpec } from './types';
import { FimProvider, LlamaCppProvider } from './fim';
import { AnthropicProvider, GeminiProvider, OpenAIChatProvider } from './chat';
import { inferFimTemplate } from '../prompt';

const CHAT: ProviderMode[] = ['chat'];
const BOTH: ProviderMode[] = ['fim', 'chat'];

/** OpenAI-compatible cloud that serves chat, plus raw /completions for FIM with open-weight coder models. */
function openaiCloud(
  id: ProviderId,
  label: string,
  baseUrl: string,
  keyUrl: string,
  opts: Partial<ProviderSpec> = {}
): ProviderSpec {
  return { id, label, kind: 'openai', baseUrl, defaultModel: '', defaultMode: 'chat', modes: CHAT, keyUrl, ...opts };
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  // ── FIM-native clouds: fastest and most accurate for autocomplete ──
  codestral: {
    id: 'codestral',
    label: 'Mistral Codestral (codestral.mistral.ai) — FIM, recommended',
    kind: 'mistral',
    baseUrl: 'https://codestral.mistral.ai',
    fimPath: 'v1/fim/completions',
    defaultModel: 'codestral-latest',
    defaultMode: 'fim',
    modes: BOTH,
    keyUrl: 'https://console.mistral.ai/codestral',
  },
  mistral: {
    id: 'mistral',
    label: 'Mistral (api.mistral.ai) — FIM',
    kind: 'mistral',
    baseUrl: 'https://api.mistral.ai',
    fimPath: 'v1/fim/completions',
    defaultModel: 'codestral-latest',
    defaultMode: 'fim',
    modes: BOTH,
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek — FIM (beta endpoint)',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/beta',
    fim: 'suffix',
    defaultModel: 'deepseek-v4-flash',
    defaultMode: 'fim',
    modes: BOTH,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  inception: {
    id: 'inception',
    label: 'Inception Mercury Coder — FIM',
    kind: 'openai',
    baseUrl: 'https://api.inceptionlabs.ai/v1',
    fimPath: 'fim/completions',
    defaultModel: 'mercury-coder',
    defaultMode: 'fim',
    modes: BOTH,
    keyUrl: 'https://platform.inceptionlabs.ai',
  },

  // ── Chat clouds ──
  openai: openaiCloud('openai', 'OpenAI — chat', 'https://api.openai.com/v1', 'https://platform.openai.com/api-keys'),
  azure: openaiCloud('azure', 'Azure OpenAI / Azure AI Foundry — chat', '', 'https://ai.azure.com', {
    auth: 'api-key',
    needsBaseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1',
  }),
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude — chat',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-haiku-5-5',
    defaultMode: 'chat',
    modes: CHAT,
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini — chat',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: '',
    defaultMode: 'chat',
    modes: CHAT,
    keyUrl: 'https://aistudio.google.com/apikey',
  },
  openrouter: openaiCloud('openrouter', 'OpenRouter — chat', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/keys'),
  groq: openaiCloud('groq', 'Groq — chat', 'https://api.groq.com/openai/v1', 'https://console.groq.com/keys'),
  together: openaiCloud('together', 'Together AI — chat, or FIM with coder models', 'https://api.together.xyz/v1', 'https://api.together.ai/settings/api-keys', { modes: BOTH, fim: 'template' }),
  fireworks: openaiCloud('fireworks', 'Fireworks AI — chat, or FIM with coder models', 'https://api.fireworks.ai/inference/v1', 'https://fireworks.ai/account/api-keys', { modes: BOTH, fim: 'template' }),
  deepinfra: openaiCloud('deepinfra', 'DeepInfra — chat, or FIM with coder models', 'https://api.deepinfra.com/v1/openai', 'https://deepinfra.com/dash/api_keys', { modes: BOTH, fim: 'template' }),
  xai: openaiCloud('xai', 'xAI Grok — chat', 'https://api.x.ai/v1', 'https://console.x.ai'),
  cerebras: openaiCloud('cerebras', 'Cerebras — chat', 'https://api.cerebras.ai/v1', 'https://cloud.cerebras.ai'),
  huggingface: openaiCloud('huggingface', 'Hugging Face Inference Providers — chat', 'https://router.huggingface.co/v1', 'https://huggingface.co/settings/tokens'),
  qwen: openaiCloud('qwen', 'Alibaba Qwen (DashScope) — chat, or FIM with Qwen-Coder', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://modelstudio.console.alibabacloud.com', { modes: BOTH, fim: 'template' }),
  moonshot: openaiCloud('moonshot', 'Moonshot Kimi — chat', 'https://api.moonshot.ai/v1', 'https://platform.moonshot.ai/console/api-keys'),
  zai: openaiCloud('zai', 'Z.ai GLM — chat', 'https://api.z.ai/api/paas/v4', 'https://z.ai/manage-apikey/apikey-list'),

  // ── Self-hosted / local ──
  ollama: {
    id: 'ollama',
    label: 'Ollama (local) — FIM',
    kind: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    fim: 'suffix',
    defaultModel: 'qwen2.5-coder:1.5b',
    defaultMode: 'fim',
    modes: BOTH,
    keyUrl: '',
    optionalKey: true,
  },
  llamacpp: {
    id: 'llamacpp',
    label: 'llama.cpp server — FIM via /infill',
    kind: 'llamacpp',
    baseUrl: 'http://localhost:8080',
    defaultModel: 'default',
    defaultMode: 'fim',
    modes: ['fim'],
    keyUrl: '',
    optionalKey: true,
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio (local) — FIM or chat',
    kind: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    fim: 'template',
    defaultModel: '',
    defaultMode: 'fim',
    modes: BOTH,
    keyUrl: '',
    optionalKey: true,
  },
  openaiCompatible: {
    id: 'openaiCompatible',
    label: 'OpenAI-compatible API (vLLM, LiteLLM, TGI, SGLang, any gateway)',
    kind: 'openai',
    baseUrl: '',
    fim: 'template',
    defaultModel: '',
    defaultMode: 'chat',
    modes: BOTH,
    keyUrl: '',
    needsBaseUrl: 'https://your-server.example.com/v1',
    optionalKey: true,
  },
};

/** Picks the mode to use: the user's choice if the provider supports it, otherwise the provider's default. */
export function resolveMode(spec: ProviderSpec, wanted: 'auto' | ProviderMode): ProviderMode {
  return wanted !== 'auto' && spec.modes.includes(wanted) ? wanted : spec.defaultMode;
}

/** 'suffix' (server applies the template) or a concrete raw template for OpenAI-style FIM. */
export function resolveFimTemplate(spec: ProviderSpec, setting: 'auto' | FimTemplate, model: string): FimTemplate {
  if (setting !== 'auto') {
    return setting;
  }
  if (spec.fim === 'template') {
    return inferFimTemplate(model) ?? 'suffix';
  }
  return 'suffix';
}

export function createProvider(spec: ProviderSpec, cfg: ProviderConfig, mode: ProviderMode): CompletionProvider {
  switch (spec.kind) {
    case 'anthropic':
      return new AnthropicProvider(cfg);
    case 'gemini':
      return new GeminiProvider(cfg);
    case 'llamacpp':
      return new LlamaCppProvider(cfg);
    case 'mistral':
    case 'openai':
      return mode === 'fim' ? new FimProvider(spec, cfg) : new OpenAIChatProvider(spec, cfg);
  }
}
