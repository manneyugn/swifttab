// Which language the cursor is actually in, for files that mix languages (no vscode import, unit tested):
// <script>/<style> in HTML, Vue, Svelte, Astro and PHP; <?php … ?> in PHP; fenced code blocks in Markdown.

export interface CursorLanguage {
  /** VS Code language ID at the cursor (the file's own language when nothing is embedded). */
  language: string;
  /** True when the cursor is inside an embedded region. */
  embedded: boolean;
  /** Text that ends the region (`</script>`, a closing fence…): a completion must not run past it. */
  regionEnd?: string;
}

const TAG_HOSTS = new Set([
  'html', 'vue', 'svelte', 'astro', 'php', 'handlebars', 'razor', 'aspnetcorerazor', 'jinja-html', 'django-html',
  'erb', 'liquid', 'twig', 'blade', 'nunjucks', 'ejs', 'vue-html',
]);
const MARKDOWN_HOSTS = new Set(['markdown', 'mdx', 'quarto', 'rmd', 'rmarkdown']);

/** Code-fence tags and lang="" attributes → VS Code language IDs. Unknown tags are used as given. */
const ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript', jsx: 'javascriptreact',
  ts: 'typescript', mts: 'typescript', tsx: 'typescriptreact',
  py: 'python', python3: 'python', py3: 'python', ipython: 'python',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript', console: 'shellscript', shellsession: 'shellscript',
  golang: 'go', rs: 'rust', rb: 'ruby', kt: 'kotlin', kts: 'kotlin',
  'c++': 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', h: 'c', objc: 'objective-c', 'objective-c': 'objective-c',
  cs: 'csharp', 'c#': 'csharp', fs: 'fsharp', 'f#': 'fsharp',
  yml: 'yaml', jsonc: 'jsonc', json5: 'json', ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  hs: 'haskell', ex: 'elixir', exs: 'elixir', erl: 'erlang', clj: 'clojure', ml: 'ocaml',
  docker: 'dockerfile', make: 'makefile', mk: 'makefile', tf: 'terraform', hcl: 'terraform',
  md: 'markdown', htm: 'html', xhtml: 'html', svg: 'xml', postgres: 'sql', postgresql: 'sql', mysql: 'sql', psql: 'sql',
  sass: 'scss', styl: 'stylus', pcss: 'postcss', vb: 'vb', bat: 'bat', cmd: 'bat', proto: 'proto3', gql: 'graphql',
};

export function normalizeLanguageTag(tag: string): string {
  const t = tag.trim().toLowerCase().replace(/^\{?\.?/, '').replace(/[},].*$/, '');
  return ALIASES[t] ?? t;
}

/**
 * The language at the end of `before` (the file text up to the cursor). Only the text before the
 * cursor is needed: a region is open when its opener is the last opener/closer seen.
 */
export function cursorLanguage(fileLanguage: string, before: string): CursorLanguage {
  // Regions are short; a large tail is enough and keeps this cheap on big files.
  before = before.slice(-200_000);
  const plain: CursorLanguage = { language: fileLanguage, embedded: false };
  if (MARKDOWN_HOSTS.has(fileLanguage)) {
    return fencedBlock(before) ?? plain;
  }
  if (!TAG_HOSTS.has(fileLanguage)) {
    return plain;
  }
  if (fileLanguage === 'php') {
    const open = Math.max(before.lastIndexOf('<?php'), before.lastIndexOf('<?='));
    if (open >= 0 && open > before.lastIndexOf('?>')) {
      return { language: 'php', embedded: false, regionEnd: '?>' };
    }
  }
  return tagBlock(fileLanguage, before) ?? (fileLanguage === 'php' ? { language: 'html', embedded: true, regionEnd: '<?php' } : plain);
}

function tagBlock(fileLanguage: string, before: string): CursorLanguage | undefined {
  const lower = before.toLowerCase();
  for (const tag of ['script', 'style'] as const) {
    const open = lower.lastIndexOf(`<${tag}`);
    if (open < 0 || open < lower.lastIndexOf(`</${tag}`)) {
      continue;
    }
    const gt = before.indexOf('>', open);
    if (gt < 0) {
      // Still typing the tag's attributes.
      return undefined;
    }
    const attrs = before.slice(open + tag.length + 1, gt);
    // `<scripts>` or `<styled-thing>` are other tags.
    if (attrs && !/^[\s/]/.test(attrs)) {
      continue;
    }
    const lang = attr(attrs, 'lang');
    const end = `</${tag}>`;
    if (tag === 'style') {
      return { language: lang ? normalizeLanguageTag(lang) : 'css', embedded: true, regionEnd: end };
    }
    const type = attr(attrs, 'type')?.toLowerCase();
    let language = lang ? normalizeLanguageTag(lang) : 'javascript';
    if (type && !lang) {
      if (/json/.test(type)) {
        language = 'json';
      } else if (/typescript/.test(type)) {
        language = 'typescript';
      } else if (/html|template/.test(type)) {
        language = 'html';
      } else if (!/javascript|ecmascript|module|babel|jsx/.test(type)) {
        language = 'plaintext';
      }
      if (/babel|jsx/.test(type)) {
        language = 'javascriptreact';
      }
    }
    // Svelte/Vue/Astro script blocks are the component's code: keep their language family.
    return { language, embedded: language !== fileLanguage, regionEnd: end };
  }
  return undefined;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/** An unclosed ``` or ~~~ fence before the cursor (CommonMark: the closer is at least as long, same char). */
function fencedBlock(before: string): CursorLanguage | undefined {
  let open: { marker: string; info: string } | undefined;
  // The cursor line itself is not a fence line yet (it is being typed).
  const lines = before.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)?.*$/.exec(lines[i]);
    // A backtick fence's info string cannot contain backticks (that is inline code).
    if (!m || (m[1][0] === '`' && lines[i].trim().slice(m[1].length).includes('`'))) {
      continue;
    }
    if (!open) {
      open = { marker: m[1], info: m[2] ?? '' };
    } else if (m[1][0] === open.marker[0] && m[1].length >= open.marker.length && !m[2] && lines[i].trim() === m[1]) {
      open = undefined;
    }
  }
  if (!open) {
    return undefined;
  }
  const language = open.info ? normalizeLanguageTag(open.info) : 'plaintext';
  return { language, embedded: true, regionEnd: open.marker };
}
