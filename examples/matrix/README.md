# Protocol matrix

Each `source-to-target` directory is an independent Yarn workspace with a `start` entrypoint and an HTTP integration test. `source` selects the only exposed endpoint; `target` selects the only deployment. All nine combinations route through OpenResponses IR, including same-protocol combinations. `shared` contains configuration and a local fake-upstream fixture, not another gateway.

| Ingress   | Chat upstream       | Responses upstream       | Anthropic upstream       |
| --------- | ------------------- | ------------------------ | ------------------------ |
| Chat      | `chat-to-chat`      | `chat-to-responses`      | `chat-to-anthropic`      |
| Responses | `responses-to-chat` | `responses-to-responses` | `responses-to-anthropic` |
| Anthropic | `anthropic-to-chat` | `anthropic-to-responses` | `anthropic-to-anthropic` |

Build first, then start a selected workspace with a gateway key and credentials for **only its target**. For example:

```sh
devenv shell -- yarn build
GATEWAY_API_KEY=client OPENAI_API_KEY=provider OPENAI_MODEL=gpt-model \
  devenv shell -- yarn workspace @better-router/example-matrix-chat-to-responses start
```

For an Anthropic target, use `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` instead. By default, the gateway listens at `127.0.0.1:8787` and exposes the public alias `matrix`. `GATEWAY_HOST`, `GATEWAY_PORT`, and `GATEWAY_MODEL` override these values. The target URL defaults to the provider endpoint; override `OPENAI_CHAT_URL`, `OPENAI_RESPONSES_URL`, or `ANTHROPIC_MESSAGES_URL` for a compatible upstream. `ANTHROPIC_MAX_TOKENS` defaults to 1024; a caller's explicit output limit takes precedence. Example credentials are placeholders, not usable provider keys.

Chat and Responses clients send `Authorization: Bearer <GATEWAY_API_KEY>` to `/v1/chat/completions` or `/v1/responses`. Anthropic clients send `x-api-key: <GATEWAY_API_KEY>` and `anthropic-version: 2023-06-01` to `/v1/messages` (Bearer authentication is also accepted). Send `model: "matrix"` unless `GATEWAY_MODEL` is overridden. All requests are JSON and limited to 1 MiB.

```sh
devenv shell -- yarn check
```

`check` runs every workspace's JSON and SSE test against a local fake target, including images, multi-turn tool results, JSON Schema, usage, upstream errors, malformed/truncated streams, overlarge requests and cancellation. No provider key or external network is used by the tests. The original `examples/chat-completions-gateway` workspace remains unchanged as a separate example.
