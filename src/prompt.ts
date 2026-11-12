// Pure prompt construction (no vscode import) so it can be unit tested.
import type { FimTemplate, Snippet } from './providers/types';

const HASH = new Set([
  'python', 'shellscript', 'ruby', 'yaml', 'perl', 'r', 'dockerfile', 'makefile', 'toml', 'powershell',
  'elixir', 'julia', 'coffeescript', 'nim', 'crystal', 'properties', 'ini',
]);
const DASH = new Set(['sql', 'lua', 'haskell', 'elm', 'ada', 'vhdl']);
const PERCENT = new Set(['latex', 'tex', 'matlab', 'erlang', 'prolog']);
const SEMI = new Set(['clojure', 'lisp', 'scheme', 'racket']);
const HTMLISH = new Set(['html', 'xml', 'vue-html', 'svg', 'xsl']);

export function commentLine(language: string, text: string): string {
  if (HASH.has(language)) {
    return `# ${text}`;
  }
  if (DASH.has(language)) {
    return `-- ${text}`;
  }
  if (PERCENT.has(language)) {
    return `% ${text}`;
  }
  if (SEMI.has(language)) {
    return `; ${text}`;
  }
  if (HTMLISH.has(language)) {
    return `<!-- ${text} -->`;
  }
  return `// ${text}`;
}

/** Context header for FIM models without a repo-level format: snippets and file path as comments. */
export function commentHeader(snippets: Snippet[], filePath: string, language: string): string {
  const out: string[] = [];
  for (const s of snippets) {
    out.push(commentLine(language, `Path: ${s.path}`));
    for (const l of s.text.split('\n')) {
      out.push(commentLine(language, l));
    }
    out.push('');
  }
  out.push(commentLine(language, `Path: ${filePath}`));
  return out.join('\n') + '\n';
}

export interface FimInput {
  prefix: string;
  suffix: string;
  filePath: string;
  repoName: string;
  language: string;
  snippets: Snippet[];
}

export interface RawFimPrompt {
  prompt: string;
  stop: string[];
}

/** Guesses the FIM template from a model ID. */
export function inferFimTemplate(model: string): Exclude<FimTemplate, 'suffix'> | undefined {
  const m = model.toLowerCase();
  if (/qwen/.test(m)) {
    return 'qwen';
  }
  if (/codegemma/.test(m)) {
    return 'codegemma';
  }
  if (/starcoder|stable-?code|granite.*code|refact/.test(m)) {
    return 'starcoder';
  }
  if (/code-?llama/.test(m)) {
    return 'codellama';
  }
  if (/deepseek/.test(m)) {
    return 'deepseek';
  }
  if (/codestral|devstral|mistral/.test(m)) {
    return 'codestral';
  }
  return undefined;
}

/**
 * Builds the raw prompt for servers that only accept `prompt` (vLLM, TGI, Together, Fireworks, LM Studio…).
 * Qwen and StarCoder get their repo-level format, so cross-file snippets look like real files.
 */
export function buildFimPrompt(template: Exclude<FimTemplate, 'suffix'>, i: FimInput): RawFimPrompt {
  const header = () => commentHeader(i.snippets, i.filePath, i.language);
  switch (template) {
    case 'qwen': {
      const files = i.snippets.map((s) => `<|file_sep|>${s.path}\n${s.text}\n`).join('');
      return {
        prompt:
          `<|repo_name|>${i.repoName}\n${files}<|file_sep|>${i.filePath}\n` +
          `<|fim_prefix|>${i.prefix}<|fim_suffix|>${i.suffix}<|fim_middle|>`,
        stop: ['<|endoftext|>', '<|file_sep|>', '<|fim_prefix|>', '<|repo_name|>', '<|im_start|>'],
      };
    }
    case 'starcoder': {
      const files = i.snippets.map((s) => `<file_sep>${s.path}\n${s.text}\n`).join('');
      return {
        prompt:
          `<repo_name>${i.repoName}${files}<file_sep>${i.filePath}\n` +
          `<fim_prefix>${i.prefix}<fim_suffix>${i.suffix}<fim_middle>`,
        stop: ['<|endoftext|>', '<file_sep>', '<fim_prefix>', '<repo_name>'],
      };
    }
    case 'codellama':
      return { prompt: `<PRE> ${header()}${i.prefix} <SUF>${i.suffix} <MID>`, stop: ['<EOT>', '<PRE>', '<SUF>'] };
    case 'deepseek':
      return {
        prompt: `<｜fim▁begin｜>${header()}${i.prefix}<｜fim▁hole｜>${i.suffix}<｜fim▁end｜>`,
        stop: ['<｜end▁of▁sentence｜>', '<｜fim▁begin｜>', '<｜fim▁hole｜>'],
      };
    case 'codestral':
      return { prompt: `[SUFFIX]${i.suffix}[PREFIX]${header()}${i.prefix}`, stop: ['</s>', '[PREFIX]', '[SUFFIX]'] };
    case 'codegemma':
      return {
        prompt: `<|fim_prefix|>${header()}${i.prefix}<|fim_suffix|>${i.suffix}<|fim_middle|>`,
        stop: ['<|file_separator|>', '<|fim_prefix|>', '<end_of_turn>'],
      };
  }
}

/** Removes any special tokens a model leaked into its output. */
export function stripSpecialTokens(text: string): string {
  const cut = text.search(/<\|(endoftext|file_sep|fim_\w+|repo_name|im_start|im_end|file_separator)\|>|<file_sep>|<EOT>|<｜/);
  return cut >= 0 ? text.slice(0, cut) : text;
}

/**
 * FIM models tokenize a prompt ending in bare indentation badly and often indent again.
 * So when the cursor line is only whitespace, send the prefix without it and remove that
 * indentation from the start of the model's output instead.
 */
export function trailingIndent(linePrefix: string): string {
  return /^[ \t]+$/.test(linePrefix) ? linePrefix : '';
}

export function dropLeadingIndent(text: string, indent: string): string {
  if (!indent) {
    return text;
  }
  let i = 0;
  while (i < indent.length && i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i++;
  }
  return text.slice(i);
}
