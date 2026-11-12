import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { decideMultiline, postProcess, shouldSkip } from '../postprocess';
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
