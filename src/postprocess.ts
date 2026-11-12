// Pure text logic (no vscode import) so it can be unit tested with `node --test`.

export const CURSOR_MARK = '<CURSOR>';

const OPENER = /(\{|\[|\(|:|=>|->|\bdo|\bthen|\bbegin)\s*$/;
const CLOSERS_ONLY = /^[\s)\]}>"'`;,]*$/;
const CLOSER_START = /^\s*([)\]}]|end\b|fi\b|done\b|esac\b|<\/)/;

export function indentWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') {
      w += 1;
    } else if (ch === '\t') {
      w += 4;
    } else {
      break;
    }
  }
  return w;
}

/**
 * Copilot's mid-line rule: only complete when the rest of the line is closing brackets/quotes,
 * optionally followed by one of `: { ; ,`. Anything else (a word, an operator) means the user
 * is editing inside existing code, where suggestions are almost always noise.
 */
const MIDLINE_OK = /^\s*[)>}\]"'`]*\s*[:{;,]?\s*$/;

export type CommentKind = 'block' | 'docstring' | 'line';

/** What kind of comment the cursor line is in, judging by the text before the cursor. */
export function commentContext(linePrefix: string): CommentKind | undefined {
  if (/^\s*\/\*/.test(linePrefix) && !linePrefix.includes('*/')) {
    return 'block';
  }
  if (/^\s*\*(\s|$)/.test(linePrefix) && !linePrefix.includes('*/')) {
    return 'block';
  }
  if (/^\s*[rRbBuU]?("""|''')/.test(linePrefix) && (linePrefix.match(/"""|'''/g) ?? []).length === 1) {
    return 'docstring';
  }
  if (/^\s*(\/\/|#|--)/.test(linePrefix)) {
    return 'line';
  }
  return undefined;
}

/** A comment line with nothing written yet (`/**`, ` * `, `"""`): the place to write a whole comment. */
export function isEmptyCommentLine(linePrefix: string): boolean {
  return /^\s*(\/\*\*?|\*|[rRbBuU]?("""|'''))\s*$/.test(linePrefix);
}

/** Whether to ask for a completion at all at this cursor position. */
export function shouldSkip(linePrefix: string, lineSuffix: string): boolean {
  // `/** █ */` and `"""█"""` (auto-closed comments) are fine places to complete.
  const closesComment = /^\s*(\*\/|"""|''')\s*$/.test(lineSuffix) && commentContext(linePrefix) !== undefined;
  if (!MIDLINE_OK.test(lineSuffix) && !closesComment) {
    return true;
  }
  // Very long lines (minified code, data) are not worth a request.
  if (linePrefix.length + lineSuffix.length > 1000) {
    return true;
  }
  return false;
}

export function decideMultiline(mode: 'auto' | 'always' | 'never', linePrefix: string, lineSuffix: string): boolean {
  if (mode === 'never') {
    return false;
  }
  // An empty doc-comment line with nothing after it: write the whole comment.
  const kind = commentContext(linePrefix);
  if ((kind === 'block' || kind === 'docstring') && isEmptyCommentLine(linePrefix) && lineSuffix.trim() === '') {
    return true;
  }
  const restIsClosers = CLOSERS_ONLY.test(lineSuffix);
  if (mode === 'always') {
    return restIsClosers;
  }
  if (!restIsClosers) {
    return false;
  }
  // Inside a call or index, e.g. `foo(█)`: complete the arguments, not a block (as Cody does).
  if (/[([]\s*$/.test(linePrefix) && /^\s*[)\]]/.test(lineSuffix)) {
    return false;
  }
  return linePrefix.trim() === '' || OPENER.test(linePrefix.trimEnd());
}

export interface PostOptions {
  /** Text on the cursor line before the cursor. */
  linePrefix: string;
  /** Text on the cursor line after the cursor. */
  lineSuffix: string;
  /** Everything after the cursor. */
  suffix: string;
  multiline: boolean;
  maxLines: number;
  chatMode: boolean;
  /** The line above the cursor line, to reject completions that just repeat it. */
  prevLine?: string;
}

export interface PostResult {
  text: string;
  /** True when the completion was cut short, so streaming can stop early. */
  truncated: boolean;
}

function stripFences(text: string): string {
  const fence = text.indexOf('```');
  if (fence < 0) {
    return text;
  }
  const afterOpen = text.indexOf('\n', fence);
  if (afterOpen < 0) {
    return '';
  }
  const close = text.indexOf('```', afterOpen + 1);
  return text.slice(afterOpen + 1, close < 0 ? undefined : close).replace(/\n$/, '');
}

/** Removes a line prefix the chat model echoed back. */
function removeEcho(text: string, linePrefix: string): string {
  if (!linePrefix) {
    return text;
  }
  if (text.startsWith(linePrefix)) {
    return text.slice(linePrefix.length);
  }
  const lp = linePrefix.trimStart();
  if (lp.length >= 4 && text.trimStart().startsWith(lp)) {
    return text.trimStart().slice(lp.length);
  }
  return text;
}

/**
 * FIM models (Qwen especially) like to produce whole lines. Fix up the start of the output so it
 * continues the cursor line exactly:
 * - the model re-wrote the cursor line: `\t\treturn nil, err` after `\t\treturn ` -> `nil, err`
 * - doubled space: ` value` after `x = ` -> `value`
 * - missing newline after an opener: `    return x;` after `{` -> `\n    return x;`
 */
export function normalizeStart(text: string, linePrefix: string, multiline: boolean): string {
  const lp = linePrefix.trimStart();
  // Comment markers are short, but a model repeating ` * ` or `# ` is still an echo.
  if (lp.length >= 3 || /^(\*|\/\/\/?|#|--)\s*$/.test(lp)) {
    const first = text.trimStart();
    if (first.startsWith(lp) && !text.startsWith('\n')) {
      text = first.slice(lp.length);
    }
  }
  if (lp && /[ \t]$/.test(linePrefix)) {
    text = text.replace(/^[ \t]+/, '');
  }
  if (multiline && lp && /^[ \t]+\S/.test(text) && indentWidth(text) > indentWidth(linePrefix)) {
    text = '\n' + text;
  }
  return text;
}

/** Longest k so that the end of `text` equals the first k chars of `rest`. */
function overlapWithRest(text: string, rest: string): number {
  const max = Math.min(text.length, rest.length);
  for (let k = max; k > 0; k--) {
    if (text.endsWith(rest.slice(0, k))) {
      return k;
    }
  }
  return 0;
}

function firstNonEmptyLineAfterCursorLine(suffix: string): string | undefined {
  const lines = suffix.split('\n').slice(1);
  return lines.find((l) => l.trim() !== '');
}

export function postProcess(raw: string, opts: PostOptions): PostResult {
  let text = raw.replace(/\r\n/g, '\n');
  let truncated = false;

  if (opts.chatMode) {
    // Reasoning models: drop finished <think> blocks; an unfinished one means nothing usable yet.
    text = text.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
    const open = text.indexOf('<think>');
    if (open >= 0) {
      text = text.slice(0, open);
    }
    text = stripFences(text).split(CURSOR_MARK).join('');
    text = removeEcho(text, opts.linePrefix);
  }
  text = normalizeStart(text, opts.linePrefix, opts.multiline);

  let lines = text.split('\n');
  const comment = commentContext(opts.linePrefix);

  if (opts.multiline && (comment === 'block' || comment === 'docstring')) {
    ({ lines, truncated } = commentLines(lines, comment, opts));
  } else if (!opts.multiline) {
    if (lines.length > 1) {
      truncated = true;
    }
    lines = [lines[0]];
  } else {
    const base = indentWidth(opts.linePrefix);
    const opened = OPENER.test(opts.linePrefix.trimEnd()) && opts.linePrefix.trim() !== '';
    const nextSuffixLine = firstNonEmptyLineAfterCursorLine(opts.suffix);
    const kept: string[] = [lines[0]];
    let sawBlank = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') {
        sawBlank = true;
        kept.push(line);
        continue;
      }
      const indent = indentWidth(line);
      // The model is about to repeat the code that already follows the cursor.
      if (nextSuffixLine !== undefined && line.trimEnd() === nextSuffixLine.trimEnd()) {
        truncated = true;
        break;
      }
      if (opened) {
        if (indent <= base) {
          if (CLOSER_START.test(line)) {
            kept.push(line);
          }
          truncated = i < lines.length - 1 || !CLOSER_START.test(line);
          break;
        }
      } else {
        if (indent < base) {
          truncated = true;
          break;
        }
        // At top level, finish one logical chunk (up to a blank line).
        if (base === 0 && sawBlank) {
          truncated = true;
          break;
        }
      }
      // Degenerate loop: the same line three times in a row.
      if (kept.length >= 2 && line === kept[kept.length - 1] && line === kept[kept.length - 2]) {
        kept.splice(kept.length - 1, 1);
        truncated = true;
        break;
      }
      if (kept.length >= opts.maxLines) {
        truncated = true;
        break;
      }
      kept.push(line);
    }
    lines = kept;
  }

  text = lines.join('\n').replace(/\s+$/, '');

  // Don't duplicate characters already to the right of the cursor, e.g. a closing ")".
  const rest = opts.lineSuffix.trimEnd();
  if (rest) {
    const k = overlapWithRest(text, rest);
    if (k > 0 && k < text.length) {
      text = text.slice(0, text.length - k);
    }
  }

  if (text.trim() === '' || opts.suffix.startsWith(text) || isRepetitive(text)) {
    return { text: '', truncated };
  }
  // The model just copied the line above (a common failure on empty lines).
  const firstLine = (opts.linePrefix + text.split('\n')[0]).trim();
  if (opts.prevLine !== undefined && firstLine.length > 3 && firstLine === opts.prevLine.trim() && !text.includes('\n')) {
    return { text: '', truncated };
  }
  return { text, truncated };
}

/**
 * Lines of a doc comment being written: stop at its end, and never run on into code.
 * The closing marker is kept unless the file already has it on the next line.
 */
function commentLines(lines: string[], kind: CommentKind, opts: PostOptions): { lines: string[]; truncated: boolean } {
  const nextSuffixLine = firstNonEmptyLineAfterCursorLine(opts.suffix)?.trim() ?? '';
  const closer = kind === 'block' ? /\*\// : /"""|'''/;
  const closerAhead = kind === 'block' ? nextSuffixLine.startsWith('*/') : /^("""|''')$/.test(nextSuffixLine);
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (closer.test(line)) {
      if (!closerAhead) {
        kept.push(line);
      } else {
        // The file already closes the comment: keep only the text before the model's closer.
        const before = line.replace(kind === 'block' ? /\s*\*\/.*$/ : /\s*("""|''').*$/, '');
        if (before.trim() !== '' && before.trim() !== '*') {
          kept.push(before);
        }
      }
      return { lines: kept, truncated: i < lines.length - 1 };
    }
    // A JSDoc-style comment line starts with `*`; anything else is code.
    if (kind === 'block' && i > 0 && t !== '' && !t.startsWith('*')) {
      return { lines: kept, truncated: true };
    }
    if (nextSuffixLine && i > 0 && t === nextSuffixLine) {
      return { lines: kept, truncated: true };
    }
    if (kept.length >= opts.maxLines) {
      return { lines: kept, truncated: true };
    }
    kept.push(line);
  }
  return { lines: kept, truncated: false };
}

/** Tabby's repetition check: a short pattern repeated many times at the end. */
export function isRepetitive(text: string): boolean {
  const tail = text.slice(-400);
  return /(.{3,}?)\1{5,}$/s.test(tail) || /(.{10,}?)\1{3,}$/s.test(tail);
}
