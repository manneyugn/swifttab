import { CompletionProvider, CompletionRequest, ProviderConfig, ProviderId, Usage } from './types';
import { deepMerge, getJson, joinUrl, parseJson, postStream, sseData } from './http';

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
  if (req.crossFile) {
    parts.push(`Relevant code from other open files:\n${req.crossFile}`);
  }
  parts.push(`File: ${req.filePath} (${req.language})\n\n${req.prefix}${CURSOR}${req.suffix}`);
  return { system, user: parts.join('\n\n') };
}

/** OpenAI-style /chat/completions (OpenAI, OpenRouter, and OpenAI-compatible servers). */
export class OpenAIChatProvider implements CompletionProvider {
  readonly mode = 'chat' as const;

  constructor(readonly id: ProviderId, private readonly cfg: ProviderConfig) {}

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.cfg.apiKey}` };
    if (this.id === 'openrouter') {
      h['X-Title'] = 'BYOK Autocomplete';
    }
    return h;
  }

  async *stream(req: CompletionRequest, onUsage: (u: Usage) => void): AsyncGenerator<string> {
    const { system, user } = buildChatPrompt(req);
    // OpenAI's own API wants max_completion_tokens; most compatible servers still use max_tokens.
    const limit = this.id === 'openai' ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens };
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
    const res = await postStream(joinUrl(this.cfg.baseUrl, 'chat/completions'), this.headers, body, req.signal);
    for await (const data of sseData(res)) {
      const json = parseJson(data);
      if (json?.usage) {
        onUsage({ inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 });
      }
      const text = json?.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text) {
        yield text;
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    const json = await getJson<any>(joinUrl(this.cfg.baseUrl, 'models'), this.headers, signal);
    return (json.data ?? []).map((m: any) => String(m.id));
  }
}

export class AnthropicProvider implements CompletionProvider {
  readonly id = 'anthropic' as const;
  readonly mode = 'chat' as const;

  constructor(private readonly cfg: ProviderConfig) {}

  private get headers(): Record<string, string> {
    return { 'x-api-key': this.cfg.apiKey, 'anthropic-version': '2023-06-01' };
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
    return { 'x-goog-api-key': this.cfg.apiKey };
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
