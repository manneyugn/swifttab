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

/** Whether to ask for a completion at all at this cursor position. */
export function shouldSkip(linePrefix: string, lineSuffix: string): boolean {
  // Cursor in the middle of a word: suggestions there are almost always noise.
  if (/^[\w$]/.test(lineSuffix)) {
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
  const restIsClosers = CLOSERS_ONLY.test(lineSuffix);
  if (mode === 'always') {
    return restIsClosers;
  }
  if (!restIsClosers) {
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
    text = stripFences(text).split(CURSOR_MARK).join('');
    text = removeEcho(text, opts.linePrefix);
  }

  let lines = text.split('\n');

  if (!opts.multiline) {
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

  if (text.trim() === '' || opts.suffix.startsWith(text)) {
    return { text: '', truncated };
  }
  return { text, truncated };
}
