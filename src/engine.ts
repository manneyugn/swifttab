// The completion pipeline without any vscode dependency: prompt adjustments, streaming with
// early stop, and post-processing. Used by the editor provider, the tests and the live eval.
import { decideMultiline, PostOptions, postProcess, shouldSkip } from './postprocess';
import { dropLeadingIndent, stripSpecialTokens, trailingIndent } from './prompt';
import { CompletionProvider, Snippet, Usage } from './providers/types';

export interface EngineInput {
  /** Everything before the cursor. */
  prefix: string;
  /** Everything after the cursor. */
  suffix: string;
  language: string;
  filePath: string;
  repoName: string;
  snippets: Snippet[];
  linePrefix: string;
  lineSuffix: string;
  prevLine?: string;
  multiline: boolean;
  model: string;
  maxTokens: number;
  maxLines: number;
  temperature: number;
}

export function postOptions(i: EngineInput, chatMode: boolean): PostOptions {
  return {
    linePrefix: i.linePrefix,
    lineSuffix: i.lineSuffix,
    suffix: i.suffix,
    multiline: i.multiline,
    maxLines: i.maxLines,
    chatMode,
    prevLine: i.prevLine,
  };
}

export interface GenerateHooks {
  /** Called with the cleaned text received so far, after every chunk. */
  onText?: (text: string) => void;
  onUsage?: (u: Usage) => void;
}

/**
 * Streams a completion and returns the cleaned (not yet post-processed) text.
 * Aborts `ctrl` as soon as the line or block is complete. Throws on API errors.
 */
export async function generate(
  provider: CompletionProvider,
  i: EngineInput,
  ctrl: AbortController,
  hooks: GenerateHooks = {}
): Promise<string> {
  const chatMode = provider.mode === 'chat';
  const post = postOptions(i, chatMode);
  // FIM models tokenize trailing indentation badly: send the prefix without it, strip it from the output.
  const indent = chatMode ? '' : trailingIndent(i.linePrefix);
  const stream = provider.stream(
    {
      prefix: indent ? i.prefix.slice(0, -indent.length) : i.prefix,
      suffix: i.suffix,
      language: i.language,
      filePath: i.filePath,
      repoName: i.repoName,
      snippets: i.snippets,
      multiline: i.multiline,
      maxTokens: i.multiline ? i.maxTokens : Math.min(i.maxTokens, 96),
      temperature: i.temperature,
      // FIM models obey stop sequences well; for chat we post-process instead.
      stop: !chatMode && !i.multiline ? ['\n'] : [],
      model: i.model,
      signal: ctrl.signal,
    },
    hooks.onUsage ?? (() => undefined)
  );

  let raw = '';
  let text = '';
  for await (const chunk of stream) {
    const joined = raw + chunk;
    raw = stripSpecialTokens(joined);
    text = dropLeadingIndent(raw, indent);
    hooks.onText?.(text);
    // A leaked special token (e.g. <|file_sep|>) means the model moved on to another file.
    if (raw.length < joined.length) {
      ctrl.abort();
      break;
    }
    // Stop paying for tokens as soon as the block is complete.
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    if (complete && postProcess(complete, post).truncated) {
      ctrl.abort();
      break;
    }
  }
  return text;
}

/** generate + postProcess: the text that would appear as ghost text. */
export async function complete(
  provider: CompletionProvider,
  i: EngineInput,
  ctrl = new AbortController(),
  hooks: GenerateHooks = {}
): Promise<{ text: string; raw: string }> {
  const raw = await generate(provider, i, ctrl, hooks);
  return { text: postProcess(raw, postOptions(i, provider.mode === 'chat')).text, raw };
}

export const CURSOR = '█';

export interface CursorOptions {
  language?: string;
  filePath?: string;
  multiline?: 'auto' | 'always' | 'never';
  model?: string;
  maxTokens?: number;
  snippets?: Snippet[];
}

/**
 * Builds an engine input from source text with a █ marking the cursor, deciding
 * single/multi-line the same way the editor does. `skip` says whether the editor
 * would have requested a completion automatically at this spot.
 */
export function fromCursor(source: string, o: CursorOptions = {}): EngineInput & { skip: boolean } {
  const at = source.indexOf(CURSOR);
  if (at < 0) {
    throw new Error(`source has no ${CURSOR} cursor marker`);
  }
  const prefix = source.slice(0, at);
  const suffix = source.slice(at + CURSOR.length);
  const lineStart = prefix.lastIndexOf('\n') + 1;
  const lineEnd = suffix.indexOf('\n');
  const linePrefix = prefix.slice(lineStart);
  const lineSuffix = lineEnd < 0 ? suffix : suffix.slice(0, lineEnd);
  const lines = prefix.split('\n');
  return {
    prefix,
    suffix,
    language: o.language ?? 'typescript',
    filePath: o.filePath ?? 'src/example.ts',
    repoName: 'example',
    snippets: o.snippets ?? [],
    linePrefix,
    lineSuffix,
    prevLine: lines.length > 1 ? lines[lines.length - 2] : undefined,
    multiline: decideMultiline(o.multiline ?? 'auto', linePrefix, lineSuffix),
    model: o.model ?? 'test-model',
    maxTokens: o.maxTokens ?? 256,
    maxLines: 40,
    temperature: 0,
    skip: shouldSkip(linePrefix, lineSuffix),
  };
}
