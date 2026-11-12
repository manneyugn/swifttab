import * as vscode from 'vscode';
import { Settings } from './config';

export class Status implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private loading = 0;
  private error?: string;
  private settings?: Settings;
  private hasKey = true;

  requests = 0;
  shown = 0;
  accepted = 0;
  cacheHits = 0;
  inputTokens = 0;
  outputTokens = 0;
  private latencies: number[] = [];

  constructor() {
    this.item.command = 'byokComplete.statusMenu';
    this.item.show();
  }

  configure(settings: Settings, hasKey: boolean): void {
    this.settings = settings;
    this.hasKey = hasKey;
    this.error = undefined;
    this.render();
  }

  begin(): void {
    this.loading++;
    this.requests++;
    this.render();
  }

  end(latencyMs?: number): void {
    this.loading = Math.max(0, this.loading - 1);
    if (latencyMs !== undefined) {
      this.error = undefined;
      this.latencies.push(latencyMs);
      if (this.latencies.length > 50) {
        this.latencies.shift();
      }
    }
    this.render();
  }

  fail(message: string): void {
    this.error = message;
    this.render();
  }

  render(): void {
    const s = this.settings;
    if (!s) {
      return;
    }
    let icon = '$(sparkle)';
    if (!s.enabled) {
      icon = '$(circle-slash)';
    } else if (!this.hasKey) {
      icon = '$(key)';
    } else if (this.error) {
      icon = '$(warning)';
    } else if (this.loading > 0) {
      icon = '$(loading~spin)';
    }
    this.item.text = `${icon} ${s.model || s.provider}`;
    this.item.backgroundColor =
      this.error || (s.enabled && !this.hasKey) ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

    const sorted = [...this.latencies].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**BYOK Autocomplete** — ${s.enabled ? 'on' : 'off'}\n\n`);
    md.appendMarkdown(`Provider: \`${s.provider}\` · Model: \`${s.model || '(not set)'}\`\n\n`);
    if (!this.hasKey) {
      md.appendMarkdown('$(key) No API key set — click to set one.\n\n');
    }
    if (this.error) {
      md.appendMarkdown(`$(warning) Last error: ${this.error}\n\n`);
    }
    md.appendMarkdown(
      `Requests ${this.requests} · shown ${this.shown} · accepted ${this.accepted} · cache hits ${this.cacheHits}\n\n`
    );
    md.appendMarkdown(
      `Tokens in ${this.inputTokens.toLocaleString()} · out ${this.outputTokens.toLocaleString()}` +
        (p50 !== undefined ? ` · median latency ${p50} ms` : '')
    );
    this.item.tooltip = md;
  }

  dispose(): void {
    this.item.dispose();
  }
}
