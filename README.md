# BYOK Autocomplete

Inline code completion for VS Code that runs on **your own cloud API key**. No chat, no agents, no account, no local model — just fast ghost-text suggestions as you type.

## Quick start

1. Install the `.vsix`: Extensions view → `⋯` → **Install from VSIX…**
2. Click the status-bar item (bottom right) → **Select provider** → paste your API key.
3. Start typing. Press `Tab` to accept, `Ctrl+→` / `Cmd+→` to accept word by word, `Alt+\` to trigger manually.

## Providers

| Provider | Mode | Notes |
|---|---|---|
| **Mistral Codestral** (`codestral.mistral.ai`) | FIM | Recommended. Built for code completion. Default model `codestral-latest`. |
| Mistral (`api.mistral.ai`) | FIM | Same model on the general Mistral API key. |
| DeepSeek | FIM (beta endpoint) | Default model `deepseek-v4-flash`. |
| OpenAI-compatible (Groq, Together, Fireworks, …) | FIM or chat | Set `byokComplete.baseUrl` and `byokComplete.openaiCompatible.mode`. |
| OpenAI, Anthropic, Gemini, OpenRouter | Chat | Works, but slower than FIM. Pick the smallest, fastest model. |

**FIM (fill-in-the-middle)** models get the code before *and* after the cursor and are trained for exactly this, so they are faster, cheaper and more accurate. Chat models are prompted to act as a completion engine and their output is cleaned up.

Use **Select model** to list the models your key can access. For reasoning-capable chat models, turn reasoning off with `byokComplete.extraBody` (for Gemini: `{"generationConfig": {"thinkingConfig": {"thinkingBudget": 0}}}`), otherwise latency will be too high for autocomplete.

## What makes it "heavy"

- **Streaming with early stop** — the request is cut off as soon as the line or block is complete, so you don't wait for (or pay for) extra tokens.
- **Smart single/multi-line** — whole blocks on empty lines and after `{`, `:`, `=>`, `do`…; single lines elsewhere. Stops when indentation leaves the block or when it would repeat the code below the cursor.
- **Cross-file context** — snippets from your other open files, ranked by shared identifiers with the code around the cursor, are added to the prompt.
- **Debounce + cancellation** — waits `debounceMs` after you stop typing; every keystroke aborts the in-flight request.
- **Type-through and cache** — typing characters that match the suggestion shows the rest instantly with no new request; revisiting a spot reuses the cached answer.
- **Clean output** — strips duplicated closing brackets, echoed code, markdown fences.
- **Status bar** — spinner while loading, warning on errors, tooltip with requests, acceptance count, token usage and median latency.

## Privacy & keys

- Keys are stored with VS Code `SecretStorage` (your OS keychain), never in `settings.json`, and never logged.
- Code is sent only to the provider you choose. No telemetry, no other servers.
- Completion is off by default for `plaintext`, `markdown` and commit messages (`byokComplete.disabledLanguages`).

## Settings

| Setting | Default | |
|---|---|---|
| `byokComplete.enabled` | `true` | |
| `byokComplete.provider` | `codestral` | |
| `byokComplete.model` | *(provider default)* | |
| `byokComplete.baseUrl` | *(provider default)* | Required for `openaiCompatible` |
| `byokComplete.debounceMs` | `200` | |
| `byokComplete.multiline` | `auto` | `auto` / `always` / `never` |
| `byokComplete.maxTokens` | `256` | Single-line requests are capped at 96 |
| `byokComplete.maxLines` | `40` | |
| `byokComplete.maxPrefixChars` / `maxSuffixChars` | `8000` / `2000` | Context window around the cursor |
| `byokComplete.crossFileContext` / `crossFileChars` | `true` / `3000` | |
| `byokComplete.timeoutMs` | `8000` | |
| `byokComplete.extraBody` | `{}` | Deep-merged into every request body |

## Development

```bash
npm install
npm test          # compile + unit tests for the completion logic
npm run package   # builds byok-autocomplete-0.1.0.vsix
```

Press `F5` in VS Code to run it in an Extension Development Host.

```
src/
  extension.ts           commands, status menu, activation
  completionProvider.ts  debounce → cache → stream → early stop → post-process
  context.ts             prefix/suffix windows, cross-file snippets, comment syntax
  postprocess.ts         multi-line logic, block-end detection, cleanup (pure, tested)
  cache.ts               LRU cache and type-through (pure, tested)
  similarity.ts          Jaccard snippet ranking (pure, tested)
  providers/             FIM (Mistral, OpenAI-style) and chat (OpenAI, Anthropic, Gemini) clients
```

Before publishing to the Marketplace, change `publisher` in `package.json` to your publisher ID.
