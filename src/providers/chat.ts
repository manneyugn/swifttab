import { CompletionProvider, CompletionRequest, ProviderConfig, ProviderSpec, Usage } from './types';
import { authHeaders, deepMerge, getJson, joinUrl, parseJson, postStream, sseData } from './http';
import { listOpenAIModels } from './fim';

export const CURSOR = '<CURSOR>';

export function buildChatPrompt(req: CompletionRequest): { system: string; user: string } {
  const scope = req.multiline
    ? 'You may complete several lines, stopping at a natural boundary such as the end of the current statement or block.'
    : 'Complete only the rest of the current line.';
  const system = [
    'You are an inline code completion engine inside a code editor.',
    `The user sends a file with a ${CURSOR} marker. Reply with ONLY the exact text to insert at ${CURSOR}.`,
    'Never repeat code that is before or after the cursor. No explanations, no markdown, no code fences.',
    scope,
    "Match the file's indentation, naming and style. If nothing should be inserted, reply with nothing.",
  ].join('\n');

  const parts: string[] = [];
  if (req.snippets.length) {
    const files = req.snippets.map((s) => `${s.path}:\n\`\`\`\n${s.text}\n\`\`\``).join('\n\n');
    parts.push(`Relevant code from other files:\n${files}`);
  }
  const lang = req.cursorLanguage ? `${req.language}; the cursor is in an embedded ${req.cursorLanguage} block` : req.language;
  parts.push(`File: ${req.filePath} (${lang})\n\n${req.prefix}${CURSOR}${req.suffix}`);
  return { system, user: parts.join('\n\n') };
}

/** OpenAI-style /chat/completions: OpenAI, Azure, Mistral, Groq, xAI, OpenRouter and every compatible server. */
export class OpenAIChatProvider implements CompletionProvider {
  readonly mode = 'chat' as const;
  readonly id;

  constructor(private readonly spec: ProviderSpec, private readonly cfg: ProviderConfig) {
    this.id = spec.id;
  }

  private get headers(): Record<string, string> {
    const extra: Record<string, string> = {};
    if (this.id === 'openrouter') {
      extra['X-Title'] = 'SwiftTab';
    }
    return authHeaders(this.spec.auth ?? 'bearer', this.cfg.apiKey, { ...extra, ...this.cfg.extraHeaders });
  }

  /** Mistral's base URL has no /v1; everyone else's does. */
  private url(path: string): string {
    return joinUrl(this.cfg.baseUrl, this.spec.kind === 'mistral' ? `v1/${path}` : path);
  }

  async *stream(req: CompletionRequest, onUsage: (u: Usage) => void): AsyncGenerator<string> {
    const { system, user } = buildChatPrompt(req);
    // OpenAI's own API wants max_completion_tokens; most compatible servers still use max_tokens.
    const limit =
      this.id === 'openai' || this.id === 'azure'
        ? { max_completion_tokens: req.maxTokens }
        : { max_tokens: req.maxTokens };
    const body = deepMerge(
      {
        model: req.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: req.temperature,
        stream: true,
        stream_options: { include_usage: true },
        ...limit,
      },
      this.cfg.extraBody
    );
    const res = await postStream(this.url('chat/completions'), this.headers, body, req.signal);
    for await (const data of sseData(res)) {
      const json = parseJson(data);
      if (json?.error) {
        throw new Error(json.error.message ?? JSON.stringify(json.error));
      }
      if (json?.usage) {
        onUsage({ inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 });
      }
      const text = json?.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text) {
        yield text;
      }
    }
  }

  listModels(signal: AbortSignal): Promise<string[]> {
    return listOpenAIModels(this.spec.kind === 'mistral' ? joinUrl(this.cfg.baseUrl, 'v1') : this.cfg.baseUrl, this.headers, signal);
  }
}

export class AnthropicProvider implements CompletionProvider {
  readonly id = 'anthropic' as const;
  readonly mode = 'chat' as const;

  constructor(private readonly cfg: ProviderConfig) {}

  private get headers(): Record<string, string> {
    return authHeaders('x-api-key', this.cfg.apiKey, { 'anthropic-version': '2023-06-01', ...this.cfg.extraHeaders });
  }

  async *stream(req: CompletionRequest, onUsage: (u: Usage) => void): AsyncGenerator<string> {
    const { system, user } = buildChatPrompt(req);
    const body = deepMerge(
      {
        model: req.model,
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
      },
      this.cfg.extraBody
    );
    const res = await postStream(joinUrl(this.cfg.baseUrl, 'v1/messages'), this.headers, body, req.signal);
    let input = 0;
    for await (const data of sseData(res)) {
      const json = parseJson(data);
      if (!json) {
        continue;
      }
      if (json.type === 'message_start') {
        input = json.message?.usage?.input_tokens ?? 0;
      } else if (json.type === 'message_delta' && json.usage) {
        onUsage({ inputTokens: input, outputTokens: json.usage.output_tokens ?? 0 });
      } else if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
        yield String(json.delta.text ?? '');
      } else if (json.type === 'error') {
        throw new Error(json.error?.message ?? 'Anthropic stream error');
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const json = await getJson<any>(joinUrl(this.cfg.baseUrl, 'v1/models?limit=100'), this.headers, signal);
    return (json.data ?? []).map((m: any) => String(m.id));
  }
}

export class GeminiProvider implements CompletionProvider {
  readonly id = 'gemini' as const;
  readonly mode = 'chat' as const;

  constructor(private readonly cfg: ProviderConfig) {}

  private get headers(): Record<string, string> {
    return authHeaders('goog', this.cfg.apiKey, this.cfg.extraHeaders);
  }

  async *stream(req: CompletionRequest, onUsage: (u: Usage) => void): AsyncGenerator<string> {
    const { system, user } = buildChatPrompt(req);
    const body = deepMerge(
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: req.maxTokens,
          temperature: req.temperature,
          ...(req.stop.length ? { stopSequences: req.stop.slice(0, 5) } : {}),
        },
      },
      this.cfg.extraBody
    );
    const model = req.model.replace(/^models\//, '');
    const url = joinUrl(this.cfg.baseUrl, `models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`);
    const res = await postStream(url, this.headers, body, req.signal);
    for await (const data of sseData(res)) {
      const json = parseJson(data);
      const meta = json?.usageMetadata;
      if (meta) {
        onUsage({ inputTokens: meta.promptTokenCount ?? 0, outputTokens: meta.candidatesTokenCount ?? 0 });
      }
      const parts: any[] = json?.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text && !p.thought) {
          yield p.text;
        }
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const json = await getJson<any>(joinUrl(this.cfg.baseUrl, 'models?pageSize=200'), this.headers, signal);
    return (json.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m: any) => String(m.name).replace(/^models\//, ''));
  }
}
