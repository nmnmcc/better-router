# In-process SDK call

Invoke one OpenAI Responses deployment directly, without starting an HTTP server.

```sh
devenv shell -- yarn build
OPENAI_API_KEY=provider OPENAI_MODEL=gpt-5-mini \
  devenv shell -- yarn workspace @better-router/example-sdk-call start
```

The public model alias defaults to `sdk-demo`; set `ROUTER_MODEL` to change it. Set `OPENAI_RESPONSES_URL` for a compatible Responses endpoint.

The command prints the selected deployment, reconstructed assistant text, and provider usage.
