import * as vscode from 'vscode';
import { KeyStore, readSettings, Settings } from './config';
import { EditorContext, gatherContext, RecentDocs } from './context';
import { decideMultiline, PostOptions, postProcess, shouldSkip } from './postprocess';
import { cacheKey, LruCache, TypeAhead } from './cache';
import { createProvider } from './providers';
import { CompletionProvider } from './providers/types';
import { EngineInput, generate } from './engine';
import { Status } from './statusBar';

function sleep(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      return resolve(!token.isCancellationRequested);
    }
    const t = setTimeout(() => {
      sub.dispose();
      resolve(!token.isCancellationRequested);
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(t);
      sub.dispose();
      resolve(false);
    });
  });
}

/** Resolves with the promise's value, or undefined as soon as the token is cancelled. */
function untilCancelled<T>(p: Promise<T>, token: vscode.CancellationToken): Promise<T | undefined> {
  return new Promise((resolve) => {
    const sub = token.onCancellationRequested(() => {
      sub.dispose();
      resolve(undefined);
    });
    p.then(
      (v) => {
        sub.dispose();
        resolve(v);
      },
      () => {
        sub.dispose();
        resolve(undefined);
      }
    );
  });
}

const TAIL = 500;

/**
 * A request on the wire. It is NOT cancelled when VS Code cancels the call that started it
 * (that happens on every keystroke): if the user keeps typing characters the model is already
 * producing, the next call picks up the same stream instead of starting over.
 */
interface Pending {
  uri: string;
  model: string;
  offset: number;
  prefixTail: string;
  suffixHead: string;
  /** Output so far, cleaned of special tokens and the moved indentation. */
  text: string;
  done: Promise<string>;
  ctrl: AbortController;
}

export class InlineProvider implements vscode.InlineCompletionItemProvider {
  private settings: Settings = readSettings();
  private provider?: CompletionProvider;
  private apiKey = '';
  private pending?: Pending;
  private skipDebounce = false;
  private readonly cache = new LruCache<string>(300);
  private readonly typeAhead = new TypeAhead();

  constructor(
    private readonly keys: KeyStore,
    private readonly status: Status,
    private readonly recent: RecentDocs,
    private readonly log: vscode.LogOutputChannel
  ) {}

  /** Re-reads settings and the API key; call after any change. */
  async reload(): Promise<void> {
    this.settings = readSettings();
    const s = this.settings;
    this.apiKey = (await this.keys.get(s.provider)) ?? '';
    const usable = !!this.apiKey || !!s.spec.optionalKey;
    this.provider = usable
      ? createProvider(
          s.spec,
          {
            apiKey: this.apiKey,
            baseUrl: s.baseUrl,
            extraBody: s.extraBody,
            extraHeaders: s.extraHeaders,
            fimTemplate: s.fimTemplate,
          },
          s.mode
        )
      : undefined;
    this.pending?.ctrl.abort();
    this.pending = undefined;
    this.cache.clear();
    this.typeAhead.clear();
    this.status.configure(s, usable);
    this.log.info(
      `provider=${s.provider} mode=${s.mode} model=${s.model || '(none)'} fim=${s.fimTemplate} base=${s.baseUrl}`
    );
  }

  current(): CompletionProvider | undefined {
    return this.provider;
  }

  /** Called after a suggestion is accepted: the next one is requested without debounce. */
  onAccepted(): void {
    this.skipDebounce = true;
  }

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const s = this.settings;
    const manual = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    const afterAccept = this.skipDebounce;
    this.skipDebounce = false;
    if ((!s.enabled && !manual) || !this.provider || !s.model) {
      return undefined;
    }
    if (s.disabledLanguages.includes(doc.languageId)) {
      return undefined;
    }

    const line = doc.lineAt(pos.line).text;
    let linePrefix = line.slice(0, pos.character);
    const lineSuffix = line.slice(pos.character);
    if (!manual && shouldSkip(linePrefix, lineSuffix)) {
      return undefined;
    }

    // Suggest widget open: VS Code only shows ghost text that extends the selected item,
    // so complete as if that item had already been inserted.
    const sel = context.selectedCompletionInfo;
    let selPrefix = '';
    let extra = '';
    let range = new vscode.Range(pos, pos);
    if (sel) {
      const typed = doc.getText(sel.range);
      if (!sel.text.startsWith(typed) || !sel.range.end.isEqual(pos)) {
        return undefined;
      }
      selPrefix = sel.text;
      extra = sel.text.slice(typed.length);
      range = sel.range;
      linePrefix += extra;
    }

    const cheap = withExtra(gatherContext(doc, pos, s.maxPrefixChars, s.maxSuffixChars, 0, undefined), extra);
    const uri = doc.uri.toString();
    const item = (text: string) => {
      if (!sel) {
        this.typeAhead.remember(uri, cheap.offset, cheap.rawPrefix, cheap.suffix, text);
      }
      this.status.shown++;
      return [
        new vscode.InlineCompletionItem(selPrefix + text, range, {
          title: 'accepted',
          command: 'swiftTab.accepted',
        }),
      ];
    };

    const multiline =
      !sel &&
      (decideMultiline(s.multiline, linePrefix, lineSuffix) ||
        // Right after accepting a line, offer the next lines (like Copilot).
        (afterAccept && s.multiline !== 'never' && lineSuffix.trim() === ''));
    const postOpts: PostOptions = {
      linePrefix,
      lineSuffix,
      suffix: cheap.suffix,
      multiline,
      maxLines: s.maxLines,
      chatMode: this.provider.mode === 'chat',
      prevLine: pos.line > 0 ? doc.lineAt(pos.line - 1).text : undefined,
    };

    // 1. Instant answers: typing through the suggestion on screen, or a spot we've seen.
    if (!sel) {
      const ahead = this.typeAhead.lookup(uri, cheap.offset, cheap.rawPrefix, cheap.suffix);
      if (ahead) {
        this.status.cacheHits++;
        return item(ahead);
      }
    }
    const key = cacheKey(uri, cheap.rawPrefix, cheap.suffix, `${s.model}|${multiline}`);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.status.cacheHits++;
      return cached ? item(cached) : undefined;
    }

    // 2. Reuse the request already on the wire if what was typed since matches its output.
    const reused = this.reusable(uri, cheap);
    if (reused) {
      const final = await untilCancelled(reused.p.done, token);
      if (final === undefined || token.isCancellationRequested || !final.startsWith(reused.typed)) {
        return undefined;
      }
      this.status.reused++;
      const { text } = postProcess(final.slice(reused.typed.length), postOpts);
      this.cache.set(key, text);
      return text ? item(text) : undefined;
    }

    // 3. Debounce: VS Code cancels the token on the next keystroke.
    if (!manual && !afterAccept && !(await sleep(s.debounceMs, token))) {
      return undefined;
    }

    // 4. New request. Whatever was in flight can no longer be used.
    this.pending?.ctrl.abort();
    const ctx = s.crossFileContext
      ? withExtra(gatherContext(doc, pos, s.maxPrefixChars, s.maxSuffixChars, s.crossFileChars, this.recent), extra)
      : cheap;
    const p = this.start(uri, ctx, postOpts);
    const final = await untilCancelled(p.done, token);
    if (final === undefined || token.isCancellationRequested) {
      return undefined;
    }
    const { text } = postProcess(final, postOpts);
    this.cache.set(key, text);
    return text ? item(text) : undefined;
  }

  /** The in-flight request, if the text typed since it started is consistent with its output. */
  private reusable(uri: string, ctx: EditorContext): { p: Pending; typed: string } | undefined {
    const p = this.pending;
    if (!p || p.uri !== uri || p.model !== this.settings.model || ctx.suffix.slice(0, 200) !== p.suffixHead) {
      return undefined;
    }
    const n = ctx.offset - p.offset;
    if (n < 0 || n > 200 || ctx.rawPrefix.length < n) {
      return undefined;
    }
    const typed = n ? ctx.rawPrefix.slice(-n) : '';
    const before = ctx.rawPrefix.slice(0, ctx.rawPrefix.length - n).slice(-TAIL);
    if (!before || !p.prefixTail.endsWith(before)) {
      return undefined;
    }
    // Still streaming: what was typed must agree with what has arrived so far.
    if (!(p.text.startsWith(typed) || typed.startsWith(p.text))) {
      return undefined;
    }
    return { p, typed };
  }

  private start(uri: string, ctx: EditorContext, postOpts: PostOptions): Pending {
    const s = this.settings;
    const provider = this.provider!;
    const ctrl = new AbortController();
    const p: Pending = {
      uri,
      model: s.model,
      offset: ctx.offset,
      prefixTail: ctx.rawPrefix.slice(-TAIL),
      suffixHead: ctx.suffix.slice(0, 200),
      text: '',
      ctrl,
      done: Promise.resolve(''),
    };
    this.pending = p;
    const input: EngineInput = {
      prefix: ctx.rawPrefix,
      suffix: ctx.suffix,
      language: ctx.language,
      filePath: ctx.relPath,
      repoName: ctx.repoName,
      snippets: ctx.snippets,
      linePrefix: postOpts.linePrefix,
      lineSuffix: postOpts.lineSuffix,
      prevLine: postOpts.prevLine,
      multiline: postOpts.multiline,
      model: s.model,
      maxTokens: s.maxTokens,
      maxLines: s.maxLines,
      temperature: s.temperature,
    };

    p.done = (async () => {
      const timer = setTimeout(() => ctrl.abort(), s.timeoutMs);
      const started = Date.now();
      this.status.begin();
      let ok = false;
      try {
        await generate(provider, input, ctrl, {
          onText: (t) => (p.text = t),
          onUsage: (u) => {
            this.status.inputTokens += u.inputTokens;
            this.status.outputTokens += u.outputTokens;
          },
        });
        ok = true;
      } catch (err: any) {
        if (ctrl.signal.aborted && Date.now() - started >= s.timeoutMs) {
          this.log.warn(`Request timed out after ${s.timeoutMs} ms`);
          this.status.fail('timeout');
        } else if (!ctrl.signal.aborted) {
          const msg = String(err?.message ?? err);
          this.log.error(`${provider.id}/${s.model}: ${msg}`);
          this.status.fail(msg.slice(0, 120));
        }
      } finally {
        clearTimeout(timer);
        this.status.end(ok ? Date.now() - started : undefined);
        if (this.pending === p && !ok) {
          this.pending = undefined;
        }
      }
      this.log.trace(`${Date.now() - started} ms, ${p.text.length} chars`);
      return p.text;
    })();
    return p;
  }
}

/** Applies the not-yet-inserted part of a selected suggest-widget item to the context. */
function withExtra(ctx: EditorContext, extra: string): EditorContext {
  if (!extra) {
    return ctx;
  }
  return {
    ...ctx,
    rawPrefix: ctx.rawPrefix + extra,
    linePrefix: ctx.linePrefix + extra,
    offset: ctx.offset + extra.length,
  };
}
