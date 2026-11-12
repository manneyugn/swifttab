import * as vscode from 'vscode';
import { KeyStore, readSettings, Settings } from './config';
import { chatCrossFile, fimHeader, gatherContext, RecentDocs } from './context';
import { decideMultiline, postProcess, shouldSkip } from './postprocess';
import { cacheKey, LruCache, TypeAhead } from './cache';
import { createProvider } from './providers';
import { CompletionProvider } from './providers/types';
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

export class InlineProvider implements vscode.InlineCompletionItemProvider {
  private settings: Settings = readSettings();
  private provider?: CompletionProvider;
  private apiKey?: string;
  private inflight?: AbortController;
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
    this.apiKey = await this.keys.get(this.settings.provider);
    this.provider = this.apiKey
      ? createProvider(
          this.settings.provider,
          { apiKey: this.apiKey, baseUrl: this.settings.baseUrl, extraBody: this.settings.extraBody },
          this.settings.compatMode
        )
      : undefined;
    this.cache.clear();
    this.typeAhead.clear();
    this.status.configure(this.settings, !!this.apiKey);
  }

  current(): CompletionProvider | undefined {
    return this.provider;
  }

  async provideInlineCompletionItems(
    doc: vscode.TextDocument,
    pos: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const s = this.settings;
    const manual = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    if ((!s.enabled && !manual) || !this.provider || !s.model) {
      return undefined;
    }
    if (s.disabledLanguages.includes(doc.languageId)) {
      return undefined;
    }

    const line = doc.lineAt(pos.line).text;
    const linePrefix = line.slice(0, pos.character);
    const lineSuffix = line.slice(pos.character);
    if (!manual && shouldSkip(linePrefix, lineSuffix)) {
      return undefined;
    }

    const cheap = gatherContext(doc, pos, s.maxPrefixChars, s.maxSuffixChars, 0, undefined);
    const uri = doc.uri.toString();
    const range = new vscode.Range(pos, pos);
    const item = (text: string) => {
      this.typeAhead.remember(uri, cheap.offset, cheap.rawPrefix, cheap.suffix, text);
      this.status.shown++;
      return [new vscode.InlineCompletionItem(text, range, { title: 'accepted', command: 'byokComplete.accepted' })];
    };

    // 1. Instant answers: user is typing through the suggestion, or we've seen this exact spot.
    const ahead = this.typeAhead.lookup(uri, cheap.offset, cheap.rawPrefix, cheap.suffix);
    if (ahead) {
      this.status.cacheHits++;
      return item(ahead);
    }
    const key = cacheKey(uri, cheap.rawPrefix, cheap.suffix, s.model);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.status.cacheHits++;
      return cached ? item(cached) : undefined;
    }

    // 2. Debounce: VS Code cancels the token on the next keystroke.
    if (!manual && !(await sleep(s.debounceMs, token))) {
      return undefined;
    }

    // 3. Request.
    this.inflight?.abort();
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const cancelSub = token.onCancellationRequested(() => ctrl.abort());
    const timer = setTimeout(() => ctrl.abort(), s.timeoutMs);

    const ctx = s.crossFileContext
      ? gatherContext(doc, pos, s.maxPrefixChars, s.maxSuffixChars, s.crossFileChars, this.recent)
      : cheap;
    const multiline = decideMultiline(s.multiline, linePrefix, lineSuffix);
    const provider = this.provider;
    const chatMode = provider.mode === 'chat';
    const postOpts = { linePrefix, lineSuffix, suffix: ctx.suffix, multiline, maxLines: s.maxLines, chatMode };

    const started = Date.now();
    this.status.begin();
    let raw = '';
    let finished = false;
    try {
      const stream = provider.stream(
        {
          prefix: chatMode ? ctx.rawPrefix : fimHeader(ctx) + ctx.rawPrefix,
          suffix: ctx.suffix,
          language: ctx.language,
          filePath: ctx.relPath,
          crossFile: chatMode ? chatCrossFile(ctx) : '',
          multiline,
          maxTokens: multiline ? s.maxTokens : Math.min(s.maxTokens, 96),
          temperature: s.temperature,
          // FIM models obey stop sequences well; for chat we post-process instead.
          stop: !chatMode && !multiline ? ['\n'] : [],
          model: s.model,
          signal: ctrl.signal,
        },
        (u) => {
          this.status.inputTokens += u.inputTokens;
          this.status.outputTokens += u.outputTokens;
        }
      );

      for await (const chunk of stream) {
        raw += chunk;
        // Stop paying for tokens as soon as the block is complete.
        const complete = raw.slice(0, raw.lastIndexOf('\n') + 1);
        if (complete && postProcess(complete, postOpts).truncated) {
          ctrl.abort();
          break;
        }
      }
      finished = true;
    } catch (err: any) {
      if (ctrl.signal.aborted && !token.isCancellationRequested && Date.now() - started >= s.timeoutMs) {
        this.log.warn(`Request timed out after ${s.timeoutMs} ms`);
        this.status.fail('timeout');
      } else if (!ctrl.signal.aborted) {
        const msg = String(err?.message ?? err);
        this.log.error(`${provider.id}/${s.model}: ${msg}`);
        this.status.fail(msg.slice(0, 120));
      }
      if (!raw) {
        return undefined;
      }
    } finally {
      clearTimeout(timer);
      cancelSub.dispose();
      if (this.inflight === ctrl) {
        this.inflight = undefined;
      }
      this.status.end(finished ? Date.now() - started : undefined);
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    const { text } = postProcess(raw, postOpts);
    this.log.trace(`${Date.now() - started} ms, ${raw.length} chars raw -> ${text.length} chars`);
    this.cache.set(key, text);
    return text ? item(text) : undefined;
  }
}
