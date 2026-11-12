import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { decideMultiline, isRepetitive, postProcess, shouldSkip } from '../postprocess';
import { buildFimPrompt, dropLeadingIndent, inferFimTemplate, stripSpecialTokens, trailingIndent } from '../prompt';
import { TypeAhead, LruCache } from '../cache';
import { topSnippets } from '../similarity';

const base = { maxLines: 40, chatMode: false };

test('single line stops at newline', () => {
  const r = postProcess('a + b;\nconsole.log(x);', {
    ...base, linePrefix: 'const x = ', lineSuffix: '', suffix: '', multiline: false,
  });
  assert.equal(r.text, 'a + b;');
  assert.equal(r.truncated, true);
});

test('removes overlap with closing characters after cursor', () => {
  const r = postProcess('a, b)', { ...base, linePrefix: 'foo(', lineSuffix: ')', suffix: ')\n', multiline: false });
  assert.equal(r.text, 'a, b');
});

test('multiline after opener keeps closing brace, stops after it', () => {
  const raw = '\n  return a + b;\n}\n\nfunction other() {\n';
  const r = postProcess(raw, {
    ...base, linePrefix: 'function add(a, b) {', lineSuffix: '', suffix: '', multiline: true,
  });
  assert.equal(r.text, '\n  return a + b;\n}');
  assert.equal(r.truncated, true);
});

test('multiline stops before repeating the next line of the file', () => {
  const raw = '\n  return a + b;\n}\n';
  const r = postProcess(raw, {
    ...base, linePrefix: 'function add(a, b) {', lineSuffix: '', suffix: '\n}\n', multiline: true,
  });
  assert.equal(r.text, '\n  return a + b;');
});

test('multiline on indented empty line stops when block dedents', () => {
  const raw = 'x = 1\n    y = 2\nprint(y)\n';
  const r = postProcess(raw, { ...base, linePrefix: '    ', lineSuffix: '', suffix: '', multiline: true });
  assert.equal(r.text, 'x = 1\n    y = 2');
  assert.equal(r.truncated, true);
});

test('chat mode strips fences and echoed line prefix', () => {
  const raw = '```ts\nconst total = items.reduce((s, i) => s + i, 0);\n```';
  const r = postProcess(raw, {
    ...base, chatMode: true, linePrefix: 'const total = ', lineSuffix: '', suffix: '', multiline: false,
  });
  assert.equal(r.text, 'items.reduce((s, i) => s + i, 0);');
});

test('empty when completion duplicates the suffix', () => {
  const r = postProcess('}', { ...base, linePrefix: '', lineSuffix: '}', suffix: '}', multiline: false });
  assert.equal(r.text, '');
});

test('skip mid-word, multiline decisions', () => {
  assert.equal(shouldSkip('foo', 'bar'), true);
  assert.equal(shouldSkip('x = ', ' + 1'), true);
  assert.equal(shouldSkip('if (a', ') {'), false);
  assert.equal(shouldSkip('foo(', '");'), false);
  assert.equal(shouldSkip('foo(', ')'), false);
  assert.equal(decideMultiline('auto', 'if (x) {', ''), true);
  assert.equal(decideMultiline('auto', 'def f(x):', ''), true);
  assert.equal(decideMultiline('auto', 'const a = ', ''), false);
  assert.equal(decideMultiline('auto', '    ', ''), true);
  assert.equal(decideMultiline('auto', 'foo(', 'x, y)'), false);
});

test('type-ahead returns the rest of the suggestion', () => {
  const ta = new TypeAhead();
  ta.remember('f', 100, 'const x = ', '\n', 'compute(a, b);');
  assert.equal(ta.lookup('f', 104, 'const x = comp', '\n'), 'ute(a, b);');
  assert.equal(ta.lookup('f', 104, 'const x = cmop', '\n'), undefined);
});

test('lru evicts oldest', () => {
  const c = new LruCache<string>(2);
  c.set('a', '1');
  c.set('b', '2');
  c.get('a');
  c.set('c', '3');
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), '1');
});

test('similar snippets ranked by shared identifiers', () => {
  const docs = [
    { path: 'user.ts', text: 'export interface UserProfile { userName: string; emailAddress: string }' },
    { path: 'math.ts', text: 'export function clamp(value, lower, upper) { return value }' },
  ];
  const s = topSnippets('function greet(profile: UserProfile) { return profile.userName', docs, 1000);
  assert.equal(s[0].path, 'user.ts');
});

test('chat mode drops think blocks', () => {
  const r = postProcess('<think>hmm</think>\na + b;', {
    ...base, chatMode: true, linePrefix: 'x = ', lineSuffix: '', suffix: '', multiline: false,
  });
  assert.equal(r.text, 'a + b;');
  const r2 = postProcess('<think>hmm</think>a + b;', {
    ...base, chatMode: true, linePrefix: 'x = ', lineSuffix: '', suffix: '', multiline: false,
  });
  assert.equal(r2.text, 'a + b;');
  const r3 = postProcess('<think>still going', {
    ...base, chatMode: true, linePrefix: 'x = ', lineSuffix: '', suffix: '', multiline: false,
  });
  assert.equal(r3.text, '');
});

test('rejects repetition and copies of the line above', () => {
  assert.equal(isRepetitive('foo(); foo(); foo(); foo(); foo(); foo(); foo();'), true);
  assert.equal(isRepetitive('return a + b;'), false);
  const r = postProcess('x = compute(a)', {
    ...base, linePrefix: '    ', lineSuffix: '', suffix: '', multiline: false, prevLine: '    x = compute(a)',
  });
  assert.equal(r.text, '');
  const loop = postProcess('a()\n    b()\n    b()\n    b()\n    b()', {
    ...base, linePrefix: '    ', lineSuffix: '', suffix: '', multiline: true,
  });
  assert.equal(loop.text, 'a()\n    b()');
});

test('fim templates', () => {
  assert.equal(inferFimTemplate('Qwen/Qwen2.5-Coder-32B-Instruct'), 'qwen');
  assert.equal(inferFimTemplate('qwen3-coder-30b-a3b'), 'qwen');
  assert.equal(inferFimTemplate('bigcode/starcoder2-15b'), 'starcoder');
  assert.equal(inferFimTemplate('deepseek-coder-6.7b-base'), 'deepseek');
  assert.equal(inferFimTemplate('gpt-4.1'), undefined);
  const q = buildFimPrompt('qwen', {
    prefix: 'def f():\n', suffix: '\n', filePath: 'a.py', repoName: 'r', language: 'python',
    snippets: [{ path: 'b.py', text: 'X = 1' }],
  });
  assert.equal(q.prompt, '<|repo_name|>r\n<|file_sep|>b.py\nX = 1\n<|file_sep|>a.py\n<|fim_prefix|>def f():\n<|fim_suffix|>\n<|fim_middle|>');
  const c = buildFimPrompt('codestral', {
    prefix: 'P', suffix: 'S', filePath: 'a.ts', repoName: 'r', language: 'typescript', snippets: [],
  });
  assert.equal(c.prompt, '[SUFFIX]S[PREFIX]// Path: a.ts\nP');
  assert.equal(stripSpecialTokens('return 1\n<|file_sep|>other.py'), 'return 1\n');
});

test('indentation is moved out of the FIM prompt and stripped from output', () => {
  assert.equal(trailingIndent('    '), '    ');
  assert.equal(trailingIndent('  x'), '');
  assert.equal(dropLeadingIndent('    if n < 2:', '    '), 'if n < 2:');
  assert.equal(dropLeadingIndent('  if', '    '), 'if');
  assert.equal(dropLeadingIndent('\n    x', '    '), '\n    x');
});
