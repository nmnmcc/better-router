# Cross-provider fallback

Expose Chat Completions and Anthropic Messages endpoints backed by an OpenAI
Responses deployment with an Anthropic Messages fallback. Callers use the public
`reliable` model alias. The route declares its primary and fallback deployment
IDs; the host resolves their credential references through one Layer.

```sh
devenv shell -- yarn build
GATEWAY_API_KEY=client \
OPENAI_API_KEY=openai-provider OPENAI_MODEL=gpt-5-mini \
ANTHROPIC_API_KEY=anthropic-provider ANTHROPIC_MODEL=claude-3-5-haiku-latest \
  devenv shell -- yarn workspace @better-router/example-failover start
```

The gateway listens on `http://127.0.0.1:8787`. Its retry policy permits two
attempts and falls back only after a retryable failure before the first semantic
event. Once output starts, it reports the failure without replaying partial
output. Set `OPENAI_RESPONSES_URL` or `ANTHROPIC_MESSAGES_URL` for compatible
endpoints, and `ANTHROPIC_MAX_TOKENS` to override the deployment's default.

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer client' \
  -H 'Content-Type: application/json' \
  -d '{"model":"reliable","stream":true,"messages":[{"role":"user","content":"Summarize model aliases."}]}'
```
