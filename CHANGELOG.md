# Changelog

## 0.1.0

First release.

- **Inline completions from your own API key**: 23 providers, including Codestral, Mistral, DeepSeek, OpenAI, Azure, Anthropic, Gemini, OpenRouter, Groq, Together, Fireworks, DeepInfra, xAI, Cerebras, Hugging Face, Qwen, Moonshot, Z.ai, Ollama, llama.cpp, LM Studio and any OpenAI-compatible server.
- **FIM and chat modes**: native FIM endpoints, plus raw FIM templates (Qwen, StarCoder, CodeLlama, DeepSeek, Codestral, CodeGemma) for servers that reject `suffix`.
- **Suggestions borrowed from Copilot and others**: Copilot's mid-line rule, reuse of in-flight requests, a cache and type-through, a new suggestion after each accept, the suggest-widget preview, early stop, and filters for repetition and echoes.
- **Doc comments**: comment-aware completion and *SwiftTab: Add Doc Comment* (`Ctrl+Alt+D`), in each language's comment style.
- **Workspace context**: an in-memory search index finds code from your project that is similar to the code around the cursor, so suggestions follow your project's patterns.
- **Mixed-language files**: detects the language at the cursor in `<script>`/`<style>` blocks, PHP tags and Markdown code blocks, and stops suggestions at the end of the block.
