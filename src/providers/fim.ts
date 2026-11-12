import { CompletionProvider, CompletionRequest, ProviderConfig, ProviderSpec, Usage } from './types';
import { authHeaders, deepMerge, getJson, joinUrl, parseJson, postStream, sseData } from './http';
import { buildFimPrompt, commentHeader } from '../prompt';

function usageFrom(json: any): Usage | undefined {
  const u = json?.usage;
  if (!u) {
    return undefined;
  }
  return { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
}

/** OpenAI-style /models listing, tolerant of bases ending in /beta. */
export async function listOpenAIModels(base: string, headers: Record<string, string>, signal: AbortSignal) {
  const json = await getJson<any>(joinUrl(base.replace(/\/beta\/?$/, ''), 'models'), headers, signal);
  const list: any[] = Array.isArray(json) ? json : (json.data ?? json.models ?? []);
  return list.map((m: any) => String(m.id ?? m.name ?? m.model));
}

/**
 * Fill-in-the-middle over HTTP.
 * - Native FIM endpoints (Mistral/Codestral `v1/fim/completions`, Inception `fim/completions`): prompt + suffix.
 * - OpenAI-style `/completions`: either prompt + suffix (DeepSeek, Ollama, llama.cpp's OpenAI API),
 *   or a raw FIM prompt built from the model's template (vLLM, Together, Fireworks, LM Studio…).
 */
export class FimProvider implements CompletionProvider {
  readonly mode = 'fim' as const;
  readonly id;

  constructor(private readonly spec: ProviderSpec, private readonly cfg: ProviderConfig) {
    this.id = spec.id;
  }

  private get headers(): Record<string, string> {
    return authHeaders(this.spec.auth ?? 'bearer', this.cfg.apiKey, this.cfg.extraHeaders);
  }

  private payload(req: CompletionRequest): Record<string, unknown> {
    const t = this.cfg.fimTemplate;
    if (!this.spec.fimPath && t !== 'suffix') {
      const raw = buildFimPrompt(t, req);
      return { prompt: raw.prompt, stop: [...raw.stop, ...req.stop] };
    }
    return {
      prompt: commentHeader(req.snippets, req.filePath, req.language) + req.prefix,
      suffix: req.suffix,
      ...(req.stop.length ? { stop: req.stop } : {}),
    };
  }

  async *stream(req: CompletionRequest, onUsage: (u: Usage) => void): AsyncGenerator<string> {
    const url = joinUrl(this.cfg.baseUrl, this.spec.fimPath ?? 'completions');
    const body = deepMerge(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
        ...this.payload(req),
      },
      this.cfg.extraBody
    );

    const res = await postStream(url, this.headers, body, req.signal);
    for await (const data of sseData(res)) {
      const json = parseJson(data);
      if (!json) {
        continue;
      }
      if (json.error) {
        throw new Error(json.error.message ?? JSON.stringify(json.error));
      }
      const usage = usageFrom(json);
      if (usage) {
        onUsage(usage);
      }
      const choice = json.choices?.[0];
      const text: unknown = choice?.text ?? choice?.delta?.content;
      if (typeof text === 'string' && text) {
        yield text;
      }
    }
  }

  async listModels(signal: AbortSignal): Promise<string[]> {
    if (this.spec.kind === 'mistral') {
      const json = await getJson<any>(joinUrl(this.cfg.baseUrl, 'v1/models'), this.headers, signal);
      const all: any[] = json.data ?? [];
      // Only models that support FIM are useful here.
      const fim = all.filter((m) => m.capabilities?.fim).map((m) => String(m.id));
      return fim.length ? fim : all.map((m) => String(m.id));
    }
    return listOpenAIModels(this.cfg.baseUrl, this.headers, signal);
  }
}

/**
 * llama.cpp server's native `/infill` endpoint. Sends cross-file snippets as `input_extra`
 * (so the server applies the model's repo-level FIM format) and reuses its KV cache.
 */
export class LlamaCppProvider implements CompletionProvider {
  readonly id = 'llamacpp' as const;
  readonly mode = 'fim' as const;

  constructor(private readonly cfg: ProviderConfig) {}

  private get headers(): Record<string, string> {
    return authHeaders('bearer', this.cfg.apiKey, this.cfg.extraHeaders);
  }

  async *stream(req: CompletionRequest, onUsage: (u: Usage) => void): AsyncGenerator<string> {
    const base = this.cfg.baseUrl.replace(/\/v1\/?$/, '');
    // llama.cpp treats `prompt` as the text of the cursor line before the cursor.
    const nl = req.prefix.lastIndexOf('\n');
    const body = deepMerge(
      {
        input_prefix: req.prefix.slice(0, nl + 1),
        prompt: req.prefix.slice(nl + 1),
        input_suffix: req.suffix,
        input_extra: req.snippets.map((s) => ({ filename: s.path, text: s.text })),
        n_predict: req.maxTokens,
        temperature: req.temperature,
        top_k: 40,
        top_p: 0.99,
        stream: true,
        cache_prompt: true,
        samplers: ['top_k', 'top_p', 'infill'],
        t_max_predict_ms: 2500,
        ...(req.stop.length ? { stop: req.stop } : {}),
      },
      this.cfg.extraBody
    );
    const res = await postStream(joinUrl(base, 'infill'), this.headers, body, req.signal);
    for await (const data of sseData(res)) {
      const json = parseJson(data);
      if (!json) {
        continue;
      }
      if (typeof json.content === 'string' && json.content) {
        yield json.content;
      }
      if (json.stop && json.timings) {
        onUsage({ inputTokens: json.timings.prompt_n ?? 0, outputTokens: json.timings.predicted_n ?? 0 });
      }
    }
  }

  listModels(signal: AbortSignal): Promise<string[]> {
    const base = this.cfg.baseUrl.replace(/\/v1\/?$/, '');
    return listOpenAIModels(joinUrl(base, 'v1'), this.headers, signal);
  }
}
