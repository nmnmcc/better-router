# Quickstart gateway

This example is the shortest path from a Chat Completions client to an OpenAI
Responses deployment. Better Router exposes the familiar Chat endpoint while
the configured deployment speaks the Responses protocol upstream.

Build the workspace, then start the gateway with your own credentials:

```sh
devenv shell -- yarn build
GATEWAY_API_KEY=client OPENAI_API_KEY=provider OPENAI_MODEL=gpt-5-mini \
  devenv shell -- yarn workspace @better-router/example-quickstart start
```

The gateway listens on `http://127.0.0.1:8787` and publishes the model alias
`quickstart`. Override `GATEWAY_MODEL`, `GATEWAY_HOST`, `GATEWAY_PORT`, or
`OPENAI_RESPONSES_URL` when needed.

Send a normal JSON request:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer client' \
  -H 'Content-Type: application/json' \
  -d '{"model":"quickstart","messages":[{"role":"user","content":"Explain model routing in one sentence."}]}'
```

The same route can stream Chat chunks:

```sh
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer client' \
  -H 'Content-Type: application/json' \
  -d '{"model":"quickstart","stream":true,"messages":[{"role":"user","content":"Give me three short ideas for a welcome message."}]}'
```
