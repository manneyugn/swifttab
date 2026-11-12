// Live evaluation: runs suggestion scenarios against a real endpoint through the same
// pipeline the editor uses, and reports pass/fail and latency per scenario.
//
//   SWIFTTAB_BASE_URL=https://llm.example.com/v1 SWIFTTAB_MODEL=qwen2.5-coder-7b SWIFTTAB_MODE=fim npm run eval
//   npm run eval -- fn-            # only scenarios whose name contains "fn-"
//
// Env: SWIFTTAB_PROVIDER (default openaiCompatible), SWIFTTAB_BASE_URL, SWIFTTAB_MODEL,
//      SWIFTTAB_MODE (auto|fim|chat), SWIFTTAB_FIM_TEMPLATE (auto|suffix|qwen|…),
//      SWIFTTAB_API_KEY, SWIFTTAB_EXTRA_BODY (JSON), SWIFTTAB_TIMEOUT_MS (default 30000).
import { complete, CursorOptions, fromCursor } from '../engine';
import { createProvider, PROVIDERS, resolveFimTemplate, resolveMode } from '../providers';
import { FimTemplate, ProviderId, ProviderMode } from '../providers/types';

interface Scenario {
  name: string;
  source: string;
  opts?: CursorOptions;
  /** What a good suggestion must look like. */
  expect: (text: string) => boolean;
  hint: string;
}

const oneLine = (t: string) => t.trim() !== '' && !t.includes('\n');

const SCENARIOS: Scenario[] = [
  // ── Line prediction ──
  {
    name: 'line-ts-url',
    source:
      'const baseUrl = "https://api.example.com";\n\nexport async function getUser(id: string) {\n  const url = █\n  const res = await fetch(url);\n  return res.json();\n}\n',
    expect: (t) => oneLine(t) && /^\S/.test(t) && /baseUrl/.test(t) && /id/.test(t),
    hint: 'one line using baseUrl and id, no leading space',
  },
  {
    name: 'line-call-args',
    source:
      'interface Person { name: string; age: number }\n\nexport function adults(people: Person[]) {\n  return people.filter(█);\n}\n',
    expect: (t) => oneLine(t) && /age/.test(t) && /18/.test(t) && !/\)\s*;?\s*$/.test(t.replace(/\([^()]*\)/g, '')),
    hint: 'a predicate on age >= 18, without the closing paren',
  },
  {
    name: 'line-ts-import',
    source: 'import { useState, useEffect } from █\n\nexport function Counter() {\n  const [n, setN] = useState(0);\n',
    opts: { language: 'typescriptreact', filePath: 'src/Counter.tsx' },
    expect: (t) => /^['"]react['"]/.test(t),
    hint: "'react' with no leading space",
  },
  {
    name: 'line-py-return',
    source: 'def full_name(user):\n    first = user["first"]\n    last = user["last"]\n    return █\n',
    opts: { language: 'python', filePath: 'users.py' },
    expect: (t) => oneLine(t) && /first/.test(t) && /last/.test(t),
    hint: 'combines first and last',
  },
  {
    name: 'line-go-err',
    source:
      'func ReadConfig(path string) (*Config, error) {\n\tdata, err := os.ReadFile(path)\n\tif err != nil {\n\t\treturn █\n\t}\n\treturn parse(data)\n}\n',
    opts: { language: 'go', filePath: 'config.go' },
    expect: (t) => oneLine(t) && /^nil/.test(t) && /err/.test(t),
    hint: 'nil, err (possibly wrapped), without repeating return',
  },

  // ── Function completion ──
  {
    name: 'fn-ts-body',
    source: 'export function add(a: number, b: number): number {█\n}\n',
    expect: (t) => /^\n\s+return\s+a\s*\+\s*b/.test(t) && !/^\}/m.test(t),
    hint: 'newline, then return a + b, without a second closing brace',
  },
  {
    name: 'fn-py-body',
    source: 'def is_prime(n: int) -> bool:\n    █\n\n\nprint(is_prime(7))\n',
    opts: { language: 'python', filePath: 'primes.py' },
    expect: (t) => /return/.test(t) && /%/.test(t) && !/print\(is_prime/.test(t) && !/^ {4}\S/.test(t),
    hint: 'a body with a modulo test, not re-indented, not repeating print()',
  },
  {
    name: 'fn-from-comment',
    source: 'import { strict as assert } from "assert";\n\n// Reverses a string.\n█\n',
    expect: (t) => /(function|const)\s+\w*reverse/i.test(t) && /(split|reverse|for)/.test(t),
    hint: 'a reverse function',
  },
  {
    name: 'fn-go-abs',
    source: 'package mathx\n\n// Abs returns the absolute value of x.\nfunc Abs(x int) int {█\n}\n',
    opts: { language: 'go', filePath: 'mathx/abs.go' },
    expect: (t) => /return\s+-x/.test(t) && /return\s+x/.test(t),
    hint: 'returns -x or x',
  },
  {
    name: 'fn-class-method',
    source:
      'interface Item { name: string; price: number; qty: number }\n\nexport class Cart {\n  items: Item[] = [];\n\n  total(): number {█\n  }\n}\n',
    expect: (t) => /^\n/.test(t) && /price/.test(t) && /qty/.test(t) && /return/.test(t),
    hint: 'sums price * qty',
  },
  {
    name: 'fn-cross-file',
    source: 'import { User } from "./user";\n\nexport function greeting(u: User): string {█\n}\n',
    opts: {
      filePath: 'src/greeting.ts',
      snippets: [{ path: 'src/user.ts', text: 'export interface User {\n  id: string;\n  displayName: string;\n}' }],
    },
    expect: (t) => /^\n/.test(t) && /displayName/.test(t),
    hint: 'uses displayName from the other file',
  },
];

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

async function main(): Promise<void> {
  const id = env('SWIFTTAB_PROVIDER', 'openaiCompatible') as ProviderId;
  const spec = PROVIDERS[id];
  if (!spec) {
    throw new Error(`Unknown provider ${id}. One of: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const baseUrl = env('SWIFTTAB_BASE_URL', spec.baseUrl);
  const model = env('SWIFTTAB_MODEL', spec.defaultModel);
  if (!baseUrl || !model) {
    throw new Error('Set SWIFTTAB_BASE_URL and SWIFTTAB_MODEL.');
  }
  const mode = resolveMode(spec, env('SWIFTTAB_MODE', 'auto') as 'auto' | ProviderMode);
  const fimTemplate = resolveFimTemplate(spec, env('SWIFTTAB_FIM_TEMPLATE', 'auto') as 'auto' | FimTemplate, model);
  const provider = createProvider(
    spec,
    {
      apiKey: env('SWIFTTAB_API_KEY'),
      baseUrl,
      extraBody: JSON.parse(env('SWIFTTAB_EXTRA_BODY', '{}')),
      extraHeaders: {},
      fimTemplate,
    },
    mode
  );
  const timeoutMs = Number(env('SWIFTTAB_TIMEOUT_MS', '30000'));
  const filter = process.argv[2] ?? '';

  console.log(`provider=${id} mode=${mode} model=${model} fim=${fimTemplate} base=${baseUrl}\n`);
  let passed = 0;
  let ran = 0;
  const latencies: number[] = [];
  for (const sc of SCENARIOS.filter((s) => s.name.includes(filter))) {
    ran++;
    const input = { ...fromCursor(sc.source, sc.opts), model, maxTokens: 160 };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    let text = '';
    let error = '';
    try {
      text = (await complete(provider, input, ctrl)).text;
    } catch (err: any) {
      error = ctrl.signal.aborted && Date.now() - started >= timeoutMs ? 'timeout' : String(err?.message ?? err);
    } finally {
      clearTimeout(timer);
    }
    const ms = Date.now() - started;
    const ok = !error && sc.expect(text);
    if (ok) {
      passed++;
      latencies.push(ms);
    }
    const kind = input.multiline ? 'multi ' : 'single';
    console.log(`${ok ? '✔' : '✖'} ${sc.name.padEnd(16)} ${kind} ${String(ms).padStart(6)} ms  ${error || JSON.stringify(text)}`);
    if (!ok) {
      console.log(`  expected: ${sc.hint}`);
    }
  }
  latencies.sort((a, b) => a - b);
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0;
  console.log(`\n${passed}/${ran} passed · median latency of passing ${p50} ms`);
  process.exitCode = passed === ran ? 0 : 1;
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exitCode = 2;
});
