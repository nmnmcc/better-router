# Examples

This directory groups example workspaces. Each example lives in its own subdirectory with a `package.json`; the root `examples/*` workspace pattern includes it automatically.

`chat-completions-gateway` is a runnable TypeScript package that composes the OpenAI Chat Completions HTTP plugin and the OpenAI Responses deployment plugin. Build its library dependencies with `devenv shell -- yarn build`, then run its `src/main.ts` directly with `devenv shell -- yarn workspace @better-router/example-chat-completions-gateway start` after setting `OPENAI_API_KEY`, `GATEWAY_API_KEY`, and `OPENAI_MODEL`. The example owns only configuration and the Effect Node server Layer.
