# In-process SDK call

This example does not start an HTTP server. It configures one OpenAI Responses
deployment, invokes the router with the semantic generation contract, and
prints the completed response. This is the smallest example for embedding
Better Router inside another Effect application.

Run it with an OpenAI credential and private model name:

```sh
devenv shell -- yarn build
OPENAI_API_KEY=provider OPENAI_MODEL=gpt-5-mini \
  devenv shell -- yarn workspace @better-router/example-sdk-call start
```

The public alias defaults to `sdk-demo`; override it with `ROUTER_MODEL`. The
optional `OPENAI_RESPONSES_URL` variable points the deployment at a compatible
Responses endpoint.

The JSON output shows the private upstream model selected by the route, the
assistant text reconstructed from generation events, and provider usage.
