import { CompletionProvider, CompletionRequest, ProviderConfig, ProviderId, Usage } from './types';
import { deepMerge, getJson, joinUrl, parseJson, postStream, sseData } from './http';

function usageFrom(json: any): Usage | undefined {
  const u = json?.usage;
  if (!u) {
    return undefined;
  }
  return { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 };
}

/**
 * Fill-in-the-middle provider.
 * - 'mistral' flavour: POST {base}/v1/fim/completions, chunks in choices[0].delta.content
 * - 'openai' flavour:  POST {base}/completions with `suffix`, chunks in choices[0].text
 *   (DeepSeek beta endpoint and many OpenAI-compatible servers).
 */
export class FimProvider implements CompletionProvider {
  readonly mode = 'fim' as const;

  constructor(
    readonly id: ProviderId,
    private readonly flavour: 'mistral' | 'openai',
    private readonly cfg: ProviderConfig
  ) {}

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.apiKey}` };
  }

  async *stream(req: CompletionRequest, onUsage: (u: Usage) => void): AsyncGenerator<string> {
    const url =
      this.flavour === 'mistral'
        ? joinUrl(this.cfg.baseUrl, 'v1/fim/completions')
        : joinUrl(this.cfg.baseUrl, 'completions');

    const body = deepMerge(
      {
        model: req.model,
        prompt: req.prefix,
        suffix: req.suffix,
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
        ...(req.stop.length ? { stop: req.stop } : {}),
      },
      this.cfg.extraBody
    );

    const res = await postStream(url, this.headers, body, req.signal);
    for await (const data of sseData(res)) {
      const json = parseJson(data);
      if (!json) {
        continue;
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
    const url = this.flavour === 'mistral' ? joinUrl(this.cfg.baseUrl, 'v1/models') : modelsUrl(this.cfg.baseUrl);
    const json = await getJson<any>(url, this.headers, signal);
    const ids: string[] = (json.data ?? []).map((m: any) => String(m.id));
    if (this.flavour === 'mistral') {
      // Only models that support FIM are useful here.
      const fim = (json.data ?? []).filter((m: any) => m.capabilities?.fim).map((m: any) => String(m.id));
      return fim.length ? fim : ids;
    }
    return ids;
  }
}

/** DeepSeek's FIM base is .../beta, but models are listed at the API root. */
function modelsUrl(base: string): string {
  return joinUrl(base.replace(/\/beta\/?$/, ''), 'models');
}
