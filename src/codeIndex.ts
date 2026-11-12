// In-memory lexical index of the workspace (no vscode import, unit tested).
// Files are cut into overlapping line windows; a BM25 search over identifiers finds the
// chunks most similar to the code around the cursor, so the model can follow patterns
// the project already uses (how routes, tests, queries, components… are written there).
import { identifiers } from './similarity';
import type { Snippet } from './providers/types';

const WINDOW = 40;
const STRIDE = 30;
const K1 = 1.2;
const B = 0.75;

const EXT_FAMILY: Record<string, string> = {
  ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', mts: 'js', cts: 'js', vue: 'js', svelte: 'js',
  py: 'py', pyi: 'py',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', cu: 'c', m: 'c', mm: 'c',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  sql: 'sql',
};

const LANG_FAMILY: Record<string, string> = {
  typescript: 'js', typescriptreact: 'js', javascript: 'js', javascriptreact: 'js', vue: 'js', svelte: 'js',
  python: 'py', go: 'go', rust: 'rust', java: 'java', kotlin: 'kotlin', scala: 'scala',
  c: 'c', cpp: 'c', 'objective-c': 'c', 'objective-cpp': 'c', 'cuda-cpp': 'c',
  csharp: 'csharp', ruby: 'ruby', php: 'php', swift: 'swift', dart: 'dart', lua: 'lua', shellscript: 'sh', sql: 'sql',
};

export const INDEXED_EXTENSIONS = Object.keys(EXT_FAMILY);

export function familyOfPath(path: string): string | undefined {
  const m = /\.([A-Za-z0-9]+)$/.exec(path);
  return m ? EXT_FAMILY[m[1].toLowerCase()] : undefined;
}

export function familyOfLanguage(languageId: string): string | undefined {
  return LANG_FAMILY[languageId];
}

/** Generated or minified files only add noise. */
export function looksGenerated(path: string, text: string): boolean {
  if (/\.min\.|[-.]bundle\.|\.generated\.|_pb2?\.|\.pb\.go$/.test(path)) {
    return true;
  }
  const lines = text.split('\n', 200);
  const long = lines.filter((l) => l.length > 400).length;
  return long > 3 || /^\s*(\/\/|#|\/\*)\s*(Code generated|@generated|DO NOT EDIT)/m.test(text.slice(0, 2000));
}

interface Chunk {
  path: string;
  family: string;
  /** Character range of the window in the file's text (the text is stored once per file). */
  from: number;
  to: number;
  startLine: number;
  len: number;
  /** Term ids and their counts in this window. */
  terms: Uint32Array;
  counts: Uint16Array;
}

export interface SearchOptions {
  family: string;
  budgetChars: number;
  /** Paths to leave out (the current file, files already in the prompt). */
  excludePaths?: Set<string>;
  maxPerFile?: number;
  limit?: number;
}

/**
 * Memory layout is kept compact (it can hold thousands of files in the extension host):
 * terms are interned to numbers, posting lists are flat [chunkId, tf, chunkId, tf, …] arrays,
 * and each file's text is stored once with chunks pointing into it.
 */
export class CodeIndex {
  private readonly chunks: (Chunk | undefined)[] = [];
  private readonly byPath = new Map<string, { text: string; ids: number[] }>();
  private readonly termIds = new Map<string, number>();
  private postings: number[][] = [];
  private df: number[] = [];
  private alive = 0;
  private totalLen = 0;
  private dead = 0;

  get files(): number {
    return this.byPath.size;
  }

  get size(): number {
    return this.alive;
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  private termId(term: string): number {
    let id = this.termIds.get(term);
    if (id === undefined) {
      id = this.df.length;
      this.termIds.set(term, id);
      this.df.push(0);
      this.postings.push([]);
    }
    return id;
  }

  /** Adds or replaces a file. */
  upsert(path: string, text: string, family = familyOfPath(path)): void {
    this.remove(path);
    if (!family || !text.trim()) {
      return;
    }
    // Character offset of each line start.
    const starts = [0];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
      starts.push(i + 1);
    }
    const ids: number[] = [];
    for (let start = 0; start < starts.length; start += STRIDE) {
      const from = starts[start];
      const end = Math.min(start + WINDOW, starts.length);
      const to = end < starts.length ? starts[end] - 1 : text.length;
      const tf = new Map<number, number>();
      let len = 0;
      for (const m of text.slice(from, to).matchAll(/[A-Za-z_$][A-Za-z0-9_$]{2,}/g)) {
        const t = this.termId(m[0]);
        tf.set(t, (tf.get(t) ?? 0) + 1);
        len++;
      }
      if (len) {
        const id = this.chunks.length;
        const terms = Uint32Array.from(tf.keys());
        const counts = Uint16Array.from(tf.values(), (v) => Math.min(v, 65535));
        this.chunks.push({ path, family, from, to, startLine: start, len, terms, counts });
        for (let k = 0; k < terms.length; k++) {
          this.df[terms[k]]++;
          this.postings[terms[k]].push(id, counts[k]);
        }
        ids.push(id);
        this.alive++;
        this.totalLen += len;
      }
      if (start + WINDOW >= starts.length) {
        break;
      }
    }
    this.byPath.set(path, { text, ids });
  }

  remove(path: string): void {
    const file = this.byPath.get(path);
    if (!file) {
      return;
    }
    for (const id of file.ids) {
      const c = this.chunks[id]!;
      for (const t of c.terms) {
        this.df[t]--;
      }
      this.totalLen -= c.len;
      this.chunks[id] = undefined;
      this.alive--;
      this.dead++;
    }
    this.byPath.delete(path);
    if (this.dead > 2000 && this.dead > this.alive) {
      this.compact();
    }
  }

  /** Chunks most similar to `query` (BM25 over identifiers), best first, within a character budget. */
  search(query: string, o: SearchOptions): Snippet[] {
    if (o.budgetChars <= 0 || !this.alive) {
      return [];
    }
    const terms: number[] = [];
    for (const t of identifiers(query)) {
      const id = this.termIds.get(t);
      if (id !== undefined && this.df[id] > 0) {
        terms.push(id);
      }
    }
    const avg = this.totalLen / this.alive;
    const scores = new Map<number, number>();
    const matched = new Map<number, number>();
    for (const t of terms) {
      const df = this.df[t];
      // Terms in many chunks (framework boilerplate) carry no signal. Tiny indexes keep everything.
      if (this.alive >= 20 && df > this.alive * 0.25) {
        continue;
      }
      const idf = Math.log(1 + (this.alive - df + 0.5) / (df + 0.5));
      const list = this.postings[t];
      for (let k = 0; k < list.length; k += 2) {
        const id = list[k];
        const c = this.chunks[id];
        if (!c || c.family !== o.family || o.excludePaths?.has(c.path)) {
          continue;
        }
        const tf = list[k + 1];
        const s = (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * c.len) / avg));
        scores.set(id, (scores.get(id) ?? 0) + s);
        matched.set(id, (matched.get(id) ?? 0) + 1);
      }
    }
    const ranked = [...scores.entries()]
      .filter(([id]) => (matched.get(id) ?? 0) >= 2)
      .sort((a, b) => b[1] - a[1]);
    if (!ranked.length) {
      return [];
    }
    const top = ranked[0][1];
    const out: Snippet[] = [];
    const perFile = new Map<string, number[]>();
    let used = 0;
    for (const [id, score] of ranked) {
      if (score < top * 0.3 || out.length >= (o.limit ?? 6)) {
        break;
      }
      const c = this.chunks[id]!;
      const taken = perFile.get(c.path) ?? [];
      // At most N chunks per file, and never two overlapping windows.
      if (taken.length >= (o.maxPerFile ?? 2) || taken.some((start) => Math.abs(start - c.startLine) < WINDOW)) {
        continue;
      }
      const text = this.byPath.get(c.path)!.text.slice(c.from, c.to).trim();
      if (used + text.length > o.budgetChars) {
        continue;
      }
      taken.push(c.startLine);
      perFile.set(c.path, taken);
      out.push({ path: c.path, text, score } as Snippet);
      used += text.length;
    }
    return out;
  }

  /** Drops removed chunks and rebuilds the posting lists. */
  private compact(): void {
    const keep = this.chunks.filter((c): c is Chunk => c !== undefined);
    this.chunks.length = 0;
    this.postings = this.postings.map(() => []);
    for (const f of this.byPath.values()) {
      f.ids = [];
    }
    keep.forEach((c, id) => {
      this.chunks.push(c);
      this.byPath.get(c.path)!.ids.push(id);
      for (let k = 0; k < c.terms.length; k++) {
        this.postings[c.terms[k]].push(id, c.counts[k]);
      }
    });
    this.dead = 0;
  }
}
