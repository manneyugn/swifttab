// Live evaluation: runs suggestion scenarios against a real endpoint through the same
// pipeline the editor uses, and reports pass/fail and latency per scenario.
//
//   SWIFTTAB_BASE_URL=https://llm.example.com/v1 SWIFTTAB_MODEL=qwen2.5-coder-7b SWIFTTAB_MODE=fim npm run eval
//   npm run eval -- fn-            # only scenarios whose name contains "fn-"
//
// Env: SWIFTTAB_PROVIDER (default openaiCompatible), SWIFTTAB_BASE_URL, SWIFTTAB_MODEL,
//      SWIFTTAB_MODE (auto|fim|chat), SWIFTTAB_FIM_TEMPLATE (auto|suffix|qwen|…),
//      SWIFTTAB_API_KEY, SWIFTTAB_EXTRA_BODY (JSON), SWIFTTAB_TIMEOUT_MS (default 30000).
import { CodeIndex, familyOfPath } from '../codeIndex';
import { complete, CursorOptions, fromCursor } from '../engine';
import { createProvider, PROVIDERS, resolveFimTemplate, resolveMode } from '../providers';
import { FimTemplate, ProviderId, ProviderMode } from '../providers/types';

interface Scenario {
  name: string;
  source: string;
  opts?: CursorOptions;
  /** Other files in the "project": indexed, and the best matches go into the prompt like in the editor. */
  workspace?: Record<string, string>;
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

  // ── Patterns from the workspace index ──
  {
    name: 'ws-route-pattern',
    source:
      "import { Router } from 'express';\nimport { db } from '../db';\nimport { ok, fail } from '../http/reply';\nimport { withAudit } from '../audit';\n\nexport const invoicesRouter = Router();\n\ninvoicesRouter.get('/:id', async (req, res) => {█\n});\n",
    opts: { filePath: 'src/routes/invoices.ts' },
    workspace: {
      'src/routes/customers.ts':
        "import { Router } from 'express';\nimport { db } from '../db';\nimport { ok, fail } from '../http/reply';\nimport { withAudit } from '../audit';\n\nexport const customersRouter = Router();\n\ncustomersRouter.get('/:id', async (req, res) => {\n  const row = await db.customers.byId(req.params.id);\n  if (!row) {\n    return fail(res, 404, 'customer_not_found');\n  }\n  return ok(res, withAudit(req, row));\n});\n",
      'src/utils/strings.ts': 'export const slug = (s: string) => s.toLowerCase().replace(/\\W+/g, \'-\');\n',
    },
    expect: (t) => /db\.invoices\.byId/.test(t) && /fail\(res,\s*404/.test(t) && /ok\(res/.test(t),
    hint: "follows customers.ts: db.invoices.byId, fail(res, 404, …), ok(res, …)",
  },

  // ── Embedded languages ──
  {
    name: 'emb-md-python',
    source: '# Utilities\n\nSplit a list into chunks of a given size:\n\n```python\ndef chunks(items, size):\n    █\n',
    opts: { language: 'markdown', filePath: 'README.md' },
    expect: (t) => /(yield|return)/.test(t) && /size/.test(t) && !/```/.test(t) && !/^#/m.test(t),
    hint: 'a Python body, stopping at the end of the code block',
  },
  {
    name: 'emb-vue-ts',
    source:
      '<template>\n  <button @click="increment">{{ count }}</button>\n</template>\n\n<script setup lang="ts">\nimport { ref } from \'vue\';\n\nconst count = ref(0);\nfunction increment() {█\n}\n</script>\n',
    opts: { language: 'vue', filePath: 'src/Counter.vue' },
    expect: (t) => /count\.value\s*(\+\+|\+=\s*1|=\s*count\.value\s*\+\s*1)/.test(t) && !/<\/script>/.test(t),
    hint: 'count.value++ inside the function, no </script>',
  },

  // ── Doc comments ──
  {
    name: 'doc-jsdoc',
    source:
      '/**\n * █\n */\nexport function clamp(value: number, min: number, max: number): number {\n  return Math.min(Math.max(value, min), max);\n}\n',
    expect: (t) =>
      /clamp|range|between|bound|limit/i.test(t) && !/\*\//.test(t) && t.split('\n').slice(1).every((l) => l.trim().startsWith('*') || !l.trim()),
    hint: 'describes clamping; only comment lines, no second */',
  },
  {
    name: 'doc-python',
    source:
      'def chunk(items, size):\n    """█\n    """\n    return [items[i:i + size] for i in range(0, len(items), size)]\n',
    opts: { language: 'python', filePath: 'util.py' },
    expect: (t) => /(chunk|split|size|group|batch)/i.test(t) && !/"""/.test(t) && !/return \[/.test(t),
    hint: 'describes splitting into chunks; no closing quotes, no code',
  },
  {
    name: 'doc-go',
    source: 'package mathx\n\n// Clamp █\nfunc Clamp(v, lo, hi int) int {\n\tif v < lo {\n\t\treturn lo\n\t}\n\tif v > hi {\n\t\treturn hi\n\t}\n\treturn v\n}\n',
    opts: { language: 'go', filePath: 'mathx/clamp.go' },
    expect: (t) => oneLine(t) && /(lo|hi|range|between|limit|bound)/i.test(t),
    hint: 'one line describing the clamp',
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
    if (sc.workspace) {
      const idx = new CodeIndex();
      for (const [p, text] of Object.entries(sc.workspace)) {
        idx.upsert(p, text);
      }
      const family = familyOfPath(input.filePath) ?? 'js';
      input.snippets = idx.search(input.prefix.slice(-1500), { family, budgetChars: 3000 });
    }
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
