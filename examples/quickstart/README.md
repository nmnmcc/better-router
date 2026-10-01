# Quickstart

Expose a Chat Completions endpoint backed by an OpenAI Responses deployment.

```sh
devenv shell -- yarn build
GATEWAY_API_KEY=client OPENAI_API_KEY=provider OPENAI_MODEL=gpt-5-mini \
  devenv shell -- yarn workspace @better-router/example-quickstart start
```

The gateway listens on `http://127.0.0.1:8787` and publishes the `quickstart` model alias. Override `GATEWAY_MODEL`, `GATEWAY_HOST`, `GATEWAY_PORT`, or `OPENAI_RESPONSES_URL` when needed.

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer client' \
  -H 'Content-Type: application/json' \
  -d '{"model":"quickstart","messages":[{"role":"user","content":"Explain model routing in one sentence."}]}'
```
