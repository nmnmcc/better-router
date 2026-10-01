# Cross-provider fallback

Expose one Chat Completions endpoint backed by OpenAI Responses first and Anthropic Messages second. Callers use the public `reliable` model alias.

```sh
devenv shell -- yarn build
GATEWAY_API_KEY=client \
OPENAI_API_KEY=openai-provider OPENAI_MODEL=gpt-5-mini \
ANTHROPIC_API_KEY=anthropic-provider ANTHROPIC_MODEL=claude-3-5-haiku-latest \
  devenv shell -- yarn workspace @better-router/example-failover start
```

The gateway listens on `http://127.0.0.1:8787`. It falls back to Anthropic only when the first provider fails before emitting a model event, so partial output is never replayed.

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer client' \
  -H 'Content-Type: application/json' \
  -d '{"model":"reliable","stream":true,"messages":[{"role":"user","content":"Summarize model aliases."}]}'
```
