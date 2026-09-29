# Cross-provider fallback

This example exposes one Chat Completions endpoint backed by two different
providers. The public model alias `reliable` tries OpenAI Responses first and
Anthropic Messages second, while callers remain unaware of the private model
names and upstream protocols.

Build the workspace, then provide credentials for both deployments:

```sh
devenv shell -- yarn build
GATEWAY_API_KEY=client \
OPENAI_API_KEY=openai-provider OPENAI_MODEL=gpt-5-mini \
ANTHROPIC_API_KEY=anthropic-provider ANTHROPIC_MODEL=claude-3-5-haiku-latest \
  devenv shell -- yarn workspace @better-router/example-failover start
```

The gateway listens on `http://127.0.0.1:8787` and publishes the model alias
`reliable`. Override `GATEWAY_MODEL`, `GATEWAY_HOST`, `GATEWAY_PORT`,
`OPENAI_RESPONSES_URL`, `ANTHROPIC_MESSAGES_URL`, or
`ANTHROPIC_MAX_TOKENS` when using compatible endpoints.

Call it like any other Chat Completions service:

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer client' \
  -H 'Content-Type: application/json' \
  -d '{"model":"reliable","stream":true,"messages":[{"role":"user","content":"Summarize why model aliases are useful."}]}'
```

The route order is the fallback policy. Better Router moves to Anthropic only
for a retryable upstream failure before the first model event, so already
started output is never replayed against another provider.
