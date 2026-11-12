# SwiftTab

Inline code completion for VS Code that runs on **your own API key**, in the cloud or on your own server. No chat, no agents, no account. It just gives fast ghost-text suggestions as you type.

## Quick start

1. Install the `.vsix`: Extensions view → `⋯` → **Install from VSIX…**
2. Click the status-bar item (bottom right) → **Select provider** → paste your API key.
3. Start typing. Press `Tab` to accept, `Ctrl+→` / `Cmd+→` to accept word by word, `Alt+\` to trigger manually.

## Providers

| Provider | Mode | Notes |
|---|---|---|
| **Mistral Codestral** (`codestral.mistral.ai`) | FIM | Recommended. Built for code completion. Default model `codestral-latest`. |
| Mistral (`api.mistral.ai`) | FIM / chat | Same model on the general Mistral API key. |
| DeepSeek | FIM (beta endpoint) / chat | Default model `deepseek-v4-flash`. |
| Inception Mercury Coder | FIM / chat | Diffusion model, very low latency. |
| OpenAI, Azure OpenAI, Anthropic, Gemini | Chat | Pick the smallest, fastest model. Azure needs `baseUrl` (`https://RESOURCE.openai.azure.com/openai/v1`) and the deployment name as the model. |
| OpenRouter, Groq, xAI, Cerebras, Hugging Face, Moonshot, Z.ai | Chat | |
| Together, Fireworks, DeepInfra, Alibaba Qwen | Chat, or FIM with open coder models | Set `swiftTab.mode` to `fim` and pick e.g. a Qwen2.5-Coder model. |
| Ollama, LM Studio | FIM / chat | Local, no key needed. |
| llama.cpp server | FIM via `/infill` | Local, no key. Sends cross-file context as `input_extra` and reuses the server's KV cache. |
| OpenAI-compatible (vLLM, LiteLLM, SGLang, TGI, any gateway) | FIM or chat | Set `swiftTab.baseUrl`. The key is optional. |

**FIM (fill-in-the-middle)** models get the code before *and* after the cursor and are trained for exactly this, so they are faster, cheaper and more accurate. Chat models are prompted to act as a completion engine and their output is cleaned up.

### FIM on servers that reject `suffix`

vLLM, Together, Fireworks and LM Studio don't accept a `suffix` field on `/completions`. For those, the extension builds the raw FIM prompt itself from the model's template. `swiftTab.fimTemplate: auto` picks it from the model name (`qwen`, `starcoder`, `codellama`, `deepseek`, `codestral`, `codegemma`). Qwen and StarCoder get their repo-level format, so snippets from other files appear as real files with their paths.

Example for a self-hosted Qwen behind LiteLLM/vLLM:

```jsonc
"swiftTab.provider": "openaiCompatible",
"swiftTab.baseUrl": "https://llm.example.com/v1",
"swiftTab.mode": "fim",
"swiftTab.model": "qwen3-coder-30b"
```

### Reasoning models

Turn reasoning off with `swiftTab.extraBody`, or latency will be far too high for autocomplete:

- Qwen3 on vLLM/SGLang: `{"chat_template_kwargs": {"enable_thinking": false}}`
- Gemini: `{"generationConfig": {"thinkingConfig": {"thinkingBudget": 0}}}`
- OpenAI reasoning models: `{"reasoning_effort": "minimal"}`

Any `<think>…</think>` block that still comes back is stripped.

## How suggestions work

These mechanics are borrowed from Copilot, Continue, Cody, Tabby and llama.vscode:

- **When to trigger.** Copilot's mid-line rule: only when the rest of the line is closing brackets or quotes (optionally followed by `: { ; ,`). Inside existing code there is no request. Manual trigger (`Alt+\`) always works.
- **Debounce and reuse of requests in flight.** The extension waits `debounceMs` after you stop typing. If you keep typing exactly what the model is already streaming, it picks up the same stream instead of cancelling it and starting over.
- **Type-through and cache.** Typing characters that match the suggestion on screen shows the rest instantly. Revisiting a spot reuses the cached answer.
- **Suggest after accept.** Accepting a suggestion immediately requests the next one, multi-line if the line is finished (`suggestAfterAccept`).
- **Suggest widget.** When the IntelliSense list is open, the ghost text continues the selected item.
- **Single or multi-line.** Whole blocks on empty lines and after `{`, `:`, `=>`, `do`…; single lines elsewhere. A block stops when indentation leaves it, when it would repeat the code below the cursor, or after `maxLines`.
- **Streaming with early stop.** The request is cut off as soon as the line or block is complete, so you don't wait for (or pay for) extra tokens.
- **Prompt.** The file path and the most relevant windows from recently opened or edited files, ranked by shared identifiers. Indentation on a blank line is taken out of the FIM prompt (models tokenize it badly) and put back afterwards.
- **Clean output.** Strips leaked special tokens, code fences and duplicated closing brackets. Drops repetition loops, copies of the line above and text that already follows the cursor.
- **Status bar.** Spinner while loading, warning on errors, and a tooltip with requests, acceptances, cache hits, reused streams, token usage and median latency.

## Privacy & keys

- Keys are stored with VS Code `SecretStorage` (your OS keychain), never in `settings.json`, and never logged.
- Code is sent only to the provider you choose. No telemetry, no other servers.
- Completion is off by default for `plaintext`, `markdown` and commit messages (`swiftTab.disabledLanguages`).

## Settings

Everything is in the regular Settings UI: search `swiftTab`, or use **Open settings** in the status-bar menu.

| Setting | Default | |
|---|---|---|
| `swiftTab.enabled` | `true` | |
| `swiftTab.provider` | `codestral` | |
| `swiftTab.model` | *(provider default)* | **Select model** lists what your key can access |
| `swiftTab.baseUrl` | *(provider default)* | Required for `openaiCompatible` and `azure` |
| `swiftTab.mode` | `auto` | `auto` / `fim` / `chat` |
| `swiftTab.fimTemplate` | `auto` | Raw FIM format for servers that reject `suffix` |
| `swiftTab.debounceMs` | `200` | |
| `swiftTab.multiline` | `auto` | `auto` / `always` / `never` |
| `swiftTab.suggestAfterAccept` | `true` | |
| `swiftTab.maxTokens` | `256` | Single-line requests are capped at 96 |
| `swiftTab.maxLines` | `40` | |
| `swiftTab.maxPrefixChars` / `maxSuffixChars` | `8000` / `2000` | Context window around the cursor |
| `swiftTab.crossFileContext` / `crossFileChars` | `true` / `3000` | |
| `swiftTab.timeoutMs` | `8000` | |
| `swiftTab.extraBody` | `{}` | Deep-merged into every request body |
| `swiftTab.extraHeaders` | `{}` | Extra HTTP headers (gateways, proxies) |

## Development

```bash
npm install
npm test          # compile + unit and scenario tests (fake model, no network)
SWIFTTAB_BASE_URL=https://llm.example.com/v1 SWIFTTAB_MODEL=qwen2.5-coder-7b SWIFTTAB_MODE=fim npm run eval
                  # live eval: line and function scenarios against a real endpoint
npm run package   # builds swifttab-0.1.0.vsix
```

Press `F5` in VS Code to run it in an Extension Development Host.

```
src/
  extension.ts           commands, status menu, activation
  completionProvider.ts  VS Code glue: debounce → cache → reuse in-flight request → engine
  engine.ts              the pipeline without vscode: prompt fixes, streaming, early stop (tested)
  context.ts             prefix/suffix windows, cross-file snippets, comment syntax
  postprocess.ts         multi-line logic, block-end detection, cleanup (pure, tested)
  cache.ts               LRU cache and type-through (pure, tested)
  similarity.ts          Jaccard snippet ranking (pure, tested)
  prompt.ts              FIM templates, context header, indentation handling (pure, tested)
  eval/run.ts            live eval scenarios (npm run eval)
  providers/             FIM (Mistral, OpenAI-style, llama.cpp /infill) and chat (OpenAI-style, Anthropic, Gemini) clients
```

Before publishing to the Marketplace, change `publisher` in `package.json` to your publisher ID.
