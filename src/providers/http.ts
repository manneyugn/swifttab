export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function joinUrl(base: string, path: string): string {
  return `${trimSlash(base)}/${path.replace(/^\/+/, '')}`;
}

async function failure(res: Response): Promise<ApiError> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 400);
  } catch {
    /* ignore */
  }
  return new ApiError(res.status, `HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
}

export async function postStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal
): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    throw await failure(res);
  }
  return res;
}

export async function getJson<T>(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal });
  if (!res.ok) {
    throw await failure(res);
  }
  return (await res.json()) as T;
}

/** Yields the payload of each `data:` line of a server-sent-events response. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          return;
        }
        if (data) {
          yield data;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

export function parseJson(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merges `extra` into `base` (objects merge, everything else is replaced). */
export function deepMerge<T extends Record<string, unknown>>(base: T, extra: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out as T;
}
