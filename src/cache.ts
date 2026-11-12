// Pure caching logic (no vscode import).

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function cacheKey(uri: string, rawPrefix: string, suffix: string, model: string): string {
  return `${model}|${uri}|${fnv1a(rawPrefix.slice(-3000))}|${rawPrefix.length % 9973}|${fnv1a(suffix.slice(0, 600))}`;
}

/** Small LRU map. */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly limit = 300) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

interface Shown {
  uri: string;
  offset: number;
  rawPrefix: string;
  suffixHead: string;
  text: string;
}

/**
 * "Type-through": when the user types characters that match the suggestion on
 * screen, return the rest instantly instead of making a new request.
 */
export class TypeAhead {
  private last?: Shown;

  remember(uri: string, offset: number, rawPrefix: string, suffix: string, text: string): void {
    this.last = { uri, offset, rawPrefix, suffixHead: suffix.slice(0, 200), text };
  }

  lookup(uri: string, offset: number, rawPrefix: string, suffix: string): string | undefined {
    const l = this.last;
    if (!l || l.uri !== uri) {
      return undefined;
    }
    const n = offset - l.offset;
    if (n <= 0 || n >= l.text.length || rawPrefix.length < n) {
      return undefined;
    }
    if (suffix.slice(0, 200) !== l.suffixHead) {
      return undefined;
    }
    const typed = rawPrefix.slice(-n);
    const before = rawPrefix.slice(0, -n).slice(-200);
    if (before !== l.rawPrefix.slice(-before.length) || !l.text.startsWith(typed)) {
      return undefined;
    }
    return l.text.slice(n);
  }

  clear(): void {
    this.last = undefined;
  }
}
