import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { cursorLanguage, normalizeLanguageTag } from '../embedded';
import { complete, fromCursor } from '../engine';
import { regionEndAt } from '../postprocess';
import { buildChatPrompt } from '../providers/chat';
import { CompletionProvider, CompletionRequest } from '../providers/types';

const at = (lang: string, before: string) => cursorLanguage(lang, before);

test('embedded: HTML script and style blocks', () => {
  assert.deepEqual(at('html', '<body>\n<script>\n  const x = '), { language: 'javascript', embedded: true, regionEnd: '</script>' });
  assert.equal(at('html', '<script type="module">\n').language, 'javascript');
  assert.equal(at('html', '<script type="application/ld+json">\n{').language, 'json');
  assert.equal(at('html', '<script type="text/x-template">\n<div>').language, 'html');
  assert.equal(at('html', '<STYLE>\nbody {').language, 'css');
  assert.deepEqual(at('html', '<script>a()</script>\n<p>'), { language: 'html', embedded: false });
  assert.equal(at('html', '<script src="x.js"></script>\n<div>').embedded, false, 'closed script tag');
  assert.equal(at('html', '<script type="text/jav').embedded, false, 'still typing the tag');
  assert.equal(at('html', '<scripts>\n').embedded, false, 'another tag name');
});

test('embedded: Vue, Svelte and Astro components', () => {
  assert.deepEqual(at('vue', '<template><div/></template>\n<script setup lang="ts">\nconst n = '), {
    language: 'typescript',
    embedded: true,
    regionEnd: '</script>',
  });
  assert.equal(at('vue', '<style scoped lang="scss">\n.a {').language, 'scss');
  assert.equal(at('vue', '<template>\n  <div>').language, 'vue', 'template keeps the file language');
  assert.equal(at('svelte', "<script lang='ts'>\n").language, 'typescript');
  assert.equal(at('svelte', '<script>\n').language, 'javascript');
});

test('embedded: PHP code and HTML parts', () => {
  assert.deepEqual(at('php', '<html><?php\n$x = '), { language: 'php', embedded: false, regionEnd: '?>' });
  assert.equal(at('php', '<?php echo 1; ?>\n<div>').language, 'html');
  assert.equal(at('php', '<?php ?>\n<script>\nlet a').language, 'javascript');
  assert.equal(at('php', '<?= $title ').language, 'php');
});

test('embedded: Markdown fenced code blocks', () => {
  assert.deepEqual(at('markdown', '# Title\n\n```python\ndef f():\n    '), { language: 'python', embedded: true, regionEnd: '```' });
  assert.equal(at('markdown', '```ts\nconst a = 1;\n```\n\nSome ').embedded, false, 'closed fence');
  assert.equal(at('markdown', '~~~~bash\nls\n```\nnot closed by backticks\n').language, 'shellscript');
  assert.equal(at('markdown', '````md\n```js\ninner\n```\n').language, 'markdown', 'a longer fence nests a shorter one');
  assert.equal(at('markdown', '```\nplain\n').language, 'plaintext');
  assert.equal(at('markdown', '```{.python}\nx').language, 'python', 'pandoc-style info');
  assert.equal(at('markdown', '```inline``` code\nthen ').embedded, false, 'inline code is not a fence');
  assert.equal(at('mdx', '```jsx\n<App ').language, 'javascriptreact');
});

test('embedded: other languages are untouched', () => {
  assert.deepEqual(at('typescript', 'const s = "<script>";\n'), { language: 'typescript', embedded: false });
  assert.deepEqual(at('python', '"""\n```python\n'), { language: 'python', embedded: false });
});

test('embedded: tag aliases', () => {
  assert.equal(normalizeLanguageTag('TS'), 'typescript');
  assert.equal(normalizeLanguageTag('c++'), 'cpp');
  assert.equal(normalizeLanguageTag('sh'), 'shellscript');
  assert.equal(normalizeLanguageTag('python {linenos=true}'.split(' ')[0]), 'python');
  assert.equal(normalizeLanguageTag('elixir'), 'elixir');
});

test('embedded: where an output leaves the region', () => {
  assert.equal(regionEndAt('x = 1\n```\nmore', '```'), 5);
  assert.equal(regionEndAt('x = 1\n  ````\n', '```'), 5);
  assert.equal(regionEndAt('s = "```"', '```'), -1, 'backticks inside a line are not a fence');
  assert.equal(regionEndAt('go();\n</script>\n<p>', '</script>'), 5);
  assert.equal(regionEndAt('go();</SCRIPT>', '</script>'), 5);
  assert.equal(regionEndAt('go();', undefined), -1);
});

class Fake implements CompletionProvider {
  readonly id = 'openaiCompatible' as const;
  readonly mode = 'fim' as const;
  request?: CompletionRequest;
  constructor(private readonly answer: string) {}
  async *stream(req: CompletionRequest): AsyncGenerator<string> {
    this.request = req;
    yield this.answer;
  }
  async listModels(): Promise<string[]> {
    return [];
  }
}

test('embedded: a Markdown code block completion stops at the closing fence', async () => {
  const input = fromCursor('# Utils\n\n```python\n█', { language: 'markdown', filePath: 'README.md' });
  assert.equal(input.cursorLanguage, 'python');
  const model = new Fake('def add(a, b):\n    return a + b\n```\n\nThen call it from your code.');
  const { text } = await complete(model, input);
  assert.equal(text, 'def add(a, b):\n    return a + b');
  assert.equal(model.request!.cursorLanguage, 'python');
});

test('embedded: a top-level script completion stops at </script>', async () => {
  const input = fromCursor('<body>\n<script>\n█', { language: 'html', filePath: 'index.html' });
  const { text } = await complete(new Fake('const app = mount("#app");\n</script>\n<footer></footer>'), input);
  assert.equal(text, 'const app = mount("#app");');
});

test('embedded: chat prompts name the language at the cursor', () => {
  const input = fromCursor('<script lang="ts">\nlet n█', { language: 'svelte', filePath: 'A.svelte' });
  const { user } = buildChatPrompt({ ...input, stop: [], signal: new AbortController().signal } as CompletionRequest);
  assert.match(user, /\(svelte; the cursor is in an embedded typescript block\)/);
});
