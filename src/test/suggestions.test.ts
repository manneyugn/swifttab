// Scenario tests for the whole suggestion pipeline (engine + post-processing) with a scripted
// fake model, so they are deterministic and need no network. █ marks the cursor.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { complete, fromCursor } from '../engine';
import { CompletionProvider, CompletionRequest, ProviderMode } from '../providers/types';

/** A model that streams a fixed answer in small chunks and records what it was asked. */
class FakeModel implements CompletionProvider {
  readonly id = 'openaiCompatible' as const;
  request?: CompletionRequest;
  chunksSent = 0;

  constructor(private readonly answer: string, readonly mode: ProviderMode = 'fim', private readonly chunk = 4) {}

  async *stream(req: CompletionRequest): AsyncGenerator<string> {
    this.request = req;
    for (let i = 0; i < this.answer.length; i += this.chunk) {
      if (req.signal.aborted) {
        return;
      }
      this.chunksSent++;
      yield this.answer.slice(i, i + this.chunk);
    }
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}

const totalChunks = (s: string, n = 4) => Math.ceil(s.length / n);

async function suggest(source: string, answer: string, opts: Parameters<typeof fromCursor>[1] = {}, mode: ProviderMode = 'fim') {
  const input = fromCursor(source, opts);
  const model = new FakeModel(answer, mode);
  const { text } = await complete(model, input);
  return { text, input, model };
}

// ── Line prediction ─────────────────────────────────────────────────────────────

test('line: completes the rest of a statement and stops at the newline', async () => {
  const answer = '`${baseUrl}/users/${id}`;\nconst res = await fetch(url);\nreturn res.json();';
  const { text, input, model } = await suggest('async function getUser(id: string) {\n  const url = █\n}\n', answer);
  assert.equal(input.multiline, false);
  assert.equal(text, '`${baseUrl}/users/${id}`;');
  assert.deepEqual(model.request!.stop, ['\n'], 'single-line FIM asks the server to stop at newline');
  assert.ok(model.chunksSent < totalChunks(answer), 'stream is cut off once the line is done');
});

test('line: completes call arguments without duplicating the closing paren', async () => {
  const { text, input } = await suggest('const user = users.find(█)\n', 'u => u.id === id)');
  assert.equal(input.multiline, false, 'inside a call is single-line');
  assert.equal(text, 'u => u.id === id');
});

test('line: completes a condition before existing closers', async () => {
  const { text } = await suggest('if (isValid(█)) {\n', 'user)) {');
  assert.equal(text, 'user');
});

test('line: continues a half-written identifier', async () => {
  const { text } = await suggest('const items = await repo.findA█\n', 'll({ where: { active: true } });');
  assert.equal(text, 'll({ where: { active: true } });');
});

test('line: no automatic request in the middle of existing code', () => {
  assert.equal(fromCursor('return a █+ b;').skip, true);
  assert.equal(fromCursor('const x = compu█te(a)').skip, true);
  assert.equal(fromCursor('const x = █').skip, false);
  assert.equal(fromCursor('foo(█);').skip, false);
});

test('line: drops a suggestion that just repeats the line above', async () => {
  const { text } = await suggest('const a = load(cfg);\nconst a = load(cfg);\n█\n', 'const a = load(cfg);', {
    multiline: 'never',
  });
  assert.equal(text, '');
});

test('line: drops a suggestion equal to the code right after the cursor', async () => {
  const { text } = await suggest('let total = █0;\n', '0;', { multiline: 'never' });
  assert.equal(text, '');
});

// ── Function completion ─────────────────────────────────────────────────────────

test('function: fills a TypeScript body and stops before the existing closing brace', async () => {
  const answer = '\n  return a + b;\n}\n\nexport function sub(a: number, b: number) {\n';
  const { text, input, model } = await suggest('export function add(a: number, b: number): number {█\n}\n', answer);
  assert.equal(input.multiline, true);
  assert.equal(text, '\n  return a + b;');
  assert.ok(model.chunksSent < totalChunks(answer), 'stream is cut off at the end of the block');
});

test('function: writes a whole Python body on an indented empty line', async () => {
  const source = 'def is_prime(n):\n    █\n\nprint(is_prime(7))\n';
  // Real FIM models re-indent the first line because the prompt no longer ends in spaces.
  const answer =
    '    if n < 2:\n        return False\n    for i in range(2, int(n ** 0.5) + 1):\n' +
    '        if n % i == 0:\n            return False\n    return True\n\nprint(is_prime(7))\n';
  const { text, model } = await suggest(source, answer, { language: 'python', filePath: 'primes.py' });
  assert.ok(model.request!.prefix.endsWith('def is_prime(n):\n'), 'trailing indentation is moved out of the prompt');
  assert.equal(
    text,
    'if n < 2:\n        return False\n    for i in range(2, int(n ** 0.5) + 1):\n' +
      '        if n % i == 0:\n            return False\n    return True'
  );
});

test('function: writes a function from a comment at top level, stopping at the blank line', async () => {
  const answer =
    'function max(xs: number[]): number {\n  return Math.max(...xs);\n}\n\nconsole.log(max([1, 2]));\n';
  const { text, input } = await suggest('// Returns the largest number in the list.\n█\n', answer);
  assert.equal(input.multiline, true);
  assert.equal(text, 'function max(xs: number[]): number {\n  return Math.max(...xs);\n}');
});

test('function: completes a method inside a class and keeps its closing brace', async () => {
  const source = 'class Cart {\n  items: Item[] = [];\n\n  total(): number {█\n}\n';
  const answer = '\n    return this.items.reduce((s, i) => s + i.price, 0);\n  }\n\n  clear() {\n';
  const { text } = await suggest(source, answer);
  assert.equal(text, '\n    return this.items.reduce((s, i) => s + i.price, 0);\n  }');
});

test('function: completes a Go function with if/else blocks inside', async () => {
  const source = 'func Abs(x int) int {█\n}\n';
  const answer = '\n\tif x < 0 {\n\t\treturn -x\n\t}\n\treturn x\n}\n\nfunc Max(';
  const { text } = await suggest(source, answer, { language: 'go', filePath: 'mathx.go' });
  assert.equal(text, '\n\tif x < 0 {\n\t\treturn -x\n\t}\n\treturn x');
});

test('function: respects maxLines', async () => {
  const body = Array.from({ length: 60 }, (_, i) => `  step${i}();`).join('\n');
  const input = fromCursor('function run() {█\n}\n');
  input.maxLines = 10;
  const { text } = await complete(new FakeModel(`\n${body}\n}`), input);
  assert.equal(text.split('\n').length, 10);
});

// ── Whole-line habits of real FIM models (e.g. Qwen served by vLLM) ───────────────

test('model re-writes the cursor line: only the missing part is kept', async () => {
  const source = 'func R() (*Config, error) {\n\tif err != nil {\n\t\treturn █\n\t}\n}\n';
  const { text } = await suggest(source, '\t\treturn nil, err\n', { language: 'go' });
  assert.equal(text, 'nil, err');
});

test('model adds a second space after "= ": it is removed', async () => {
  const { text } = await suggest('  const url = █\n', '  `${baseUrl}/users/${id}`;\n  return');
  assert.equal(text, '`${baseUrl}/users/${id}`;');
});

test('model starts a body without the newline after "{": it is added', async () => {
  const { text } = await suggest('export function add(a: number, b: number): number {█\n}\n', '    return a + b;\n');
  assert.equal(text, '\n    return a + b;');
});

test('a completion that legitimately starts like the line is not cut', async () => {
  const { text } = await suggest('const name = █\n', 'nameOf(user);');
  assert.equal(text, 'nameOf(user);');
});

// ── Model misbehaviour ──────────────────────────────────────────────────────────

test('chat model: code fences and echoed indentation are removed', async () => {
  const source = 'function add(a: number, b: number) {\n  █\n}\n';
  const { text } = await suggest(source, '```ts\n  return a + b;\n```', {}, 'chat');
  assert.equal(text, 'return a + b;');
});

test('chat model: reasoning is stripped', async () => {
  const { text } = await suggest('const total = █\n', '<think>sum the prices</think>prices.reduce((a, b) => a + b, 0);', {}, 'chat');
  assert.equal(text, 'prices.reduce((a, b) => a + b, 0);');
});

test('leaked FIM tokens end the suggestion', async () => {
  const { text } = await suggest('function id(x) {█\n}\n', '\n  return x;<|file_sep|>src/other.ts\nexport {}');
  assert.equal(text, '\n  return x;');
});

test('repetition loops are rejected', async () => {
  const { text } = await suggest('const ids = [█]\n', '1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1');
  assert.equal(text, '');
});

test('cross-file snippets reach the model', async () => {
  const snippets = [{ path: 'src/user.ts', text: 'export interface User { id: string; email: string }' }];
  const { model } = await suggest('function mail(u: User) {\n  return u.█\n}\n', 'email;', { snippets });
  assert.deepEqual(model.request!.snippets, snippets);
  assert.equal(model.request!.filePath, 'src/example.ts');
});

// ── Doc comments ────────────────────────────────────────────────────────────────

const addFn = 'export function add(a: number, b: number): number {\n  return a + b;\n}\n';

test('doc: fills a JSDoc skeleton and stops before the existing */', async () => {
  const answer =
    'Adds two numbers.\n * @param a - First number.\n * @param b - Second number.\n * @returns The sum.\n */\nexport function add(';
  const { text, input, model } = await suggest(`/**\n * █\n */\n${addFn}`, answer);
  assert.equal(input.multiline, true, 'an empty comment line writes the whole comment');
  assert.equal(text, 'Adds two numbers.\n * @param a - First number.\n * @param b - Second number.\n * @returns The sum.');
  assert.ok(model.chunksSent < totalChunks(answer), 'stream stops at the end of the comment');
});

test('doc: a repeated " * " at the start is removed', async () => {
  const { text } = await suggest(`/**\n * █\n */\n${addFn}`, ' * Adds two numbers.\n * @returns The sum.\n */');
  assert.equal(text, 'Adds two numbers.\n * @returns The sum.');
});

test('doc: after typing /** the closing */ is written too', async () => {
  const { text } = await suggest(`/**█\n${addFn}`, '\n * Adds two numbers.\n */\nexport function add(');
  assert.equal(text, '\n * Adds two numbers.\n */');
});

test('doc: a comment that runs into code is cut at the code', async () => {
  const { text } = await suggest(`/**\n * █\n */\n${addFn}`, 'Adds two numbers.\nexport function add(a, b) {');
  assert.equal(text, 'Adds two numbers.');
});

test('doc: one-line /** █ */ completes inside without a second */', async () => {
  const { text, input } = await suggest(`/** █ */\n${addFn}`, 'Adds two numbers. */');
  assert.equal(input.skip, false, 'auto-closed comments still trigger');
  assert.equal(input.multiline, false);
  assert.equal(text, 'Adds two numbers.');
});

test('doc: Python docstring stops before the existing closing quotes', async () => {
  const source = 'def add(a, b):\n    """█\n    """\n    return a + b\n';
  const answer =
    'Return the sum of a and b.\n\n    Args:\n        a: First number.\n        b: Second number.\n    """\n    return a + b\n';
  const { text, input } = await suggest(source, answer, { language: 'python', filePath: 'calc.py' });
  assert.equal(input.multiline, true);
  assert.equal(text, 'Return the sum of a and b.\n\n    Args:\n        a: First number.\n        b: Second number.');
});

test('doc: one-line Python docstring keeps only the text', async () => {
  const source = 'def add(a, b):\n    """█\n    """\n    return a + b\n';
  const { text } = await suggest(source, 'Return the sum of a and b."""', { language: 'python' });
  assert.equal(text, 'Return the sum of a and b.');
});

test('doc: Go line comment completes the sentence after the name', async () => {
  const source = '// Add █\nfunc Add(a, b int) int {\n\treturn a + b\n}\n';
  const { text, input } = await suggest(source, 'returns the sum of a and b.\nfunc Add(a, b int) int {', { language: 'go' });
  assert.equal(input.multiline, false);
  assert.equal(text, 'returns the sum of a and b.');
});
