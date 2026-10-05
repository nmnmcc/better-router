# In-process SDK call

Declare an OpenAI Responses deployment and invoke it through the router runtime
without starting an HTTP server. `Router.make` is a pure preflight step and
`Router.runtime` binds the host's credential resolver and HTTP client.

```sh
devenv shell -- yarn build
OPENAI_API_KEY=provider OPENAI_MODEL=gpt-5-mini \
  devenv shell -- yarn workspace @better-router/example-sdk-call start
```

The public model alias defaults to `sdk-demo`; set `ROUTER_MODEL` to change it. Set `OPENAI_RESPONSES_URL` for a compatible Responses endpoint.

The command prints the response model, reconstructed assistant text, and usage
from the terminal `Generation.Process` response.
