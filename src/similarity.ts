// Cross-file snippet ranking (no vscode import). Jaccard similarity of
// identifier sets over sliding windows, similar to what Copilot-style tools do.

export interface SourceDoc {
  path: string;
  text: string;
}

export interface Snippet {
  path: string;
  text: string;
  score: number;
}

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]{2,}/g;
const STOP = new Set([
  'the', 'and', 'for', 'const', 'let', 'var', 'return', 'function', 'def', 'class', 'import', 'from',
  'export', 'public', 'private', 'static', 'void', 'this', 'self', 'true', 'false', 'null', 'None',
  'new', 'else', 'elif', 'while', 'async', 'await', 'type', 'interface', 'string', 'number', 'int',
]);

export function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(IDENT)) {
    if (!STOP.has(m[0])) {
      out.add(m[0]);
    }
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) {
    return 0;
  }
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) {
    if (big.has(x)) {
      inter++;
    }
  }
  return inter / (a.size + b.size - inter);
}

export function topSnippets(
  query: string,
  docs: SourceDoc[],
  budgetChars: number,
  windowLines = 30,
  step = 10,
  minScore = 0.05
): Snippet[] {
  const q = identifiers(query);
  if (!q.size || budgetChars <= 0) {
    return [];
  }
  const candidates: Snippet[] = [];
  for (const doc of docs) {
    const lines = doc.text.split('\n').slice(0, 5000);
    let best: Snippet | undefined;
    for (let start = 0; start < Math.max(1, lines.length); start += step) {
      const text = lines.slice(start, start + windowLines).join('\n');
      const score = jaccard(q, identifiers(text));
      if (!best || score > best.score) {
        best = { path: doc.path, text, score };
      }
      if (start + windowLines >= lines.length) {
        break;
      }
    }
    if (best && best.score >= minScore) {
      candidates.push(best);
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const out: Snippet[] = [];
  let used = 0;
  for (const c of candidates) {
    if (used + c.text.length > budgetChars) {
      continue;
    }
    out.push(c);
    used += c.text.length;
  }
  return out;
}
