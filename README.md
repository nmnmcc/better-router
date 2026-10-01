# Better Router

> Build your own AI router.

Better Router is an Effect-based TypeScript toolkit for routing AI requests across providers. Configure model aliases, deployments, and fallback routes once, then use the same router through an HTTP API or an in-process call.

## What you get

- One semantic generation contract across providers
- Declarative plugins for OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages
- Ordered fallback before output starts
- Streaming, authentication, middleware, and cancellation
- Type-safe router composition with `Router.make` or `Router.layer`

## Packages

| Package                                         | Provides                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| `@better-router/core`                           | Routing, deployments, generation, middleware, HTTP composition, and plugin contracts |
| `@better-router/plugin-openai-chat-completions` | OpenAI Chat Completions ingress and upstream execution                               |
| `@better-router/plugin-openai-responses`        | OpenAI Responses ingress and upstream execution                                      |
| `@better-router/plugin-anthropic-messages`      | Anthropic Messages ingress and upstream execution                                    |

## Quick start

Install dependencies and build the workspace:

```sh
devenv shell -- yarn install --immutable
devenv shell -- yarn build
```

Start the [quickstart example](examples/quickstart/README.md) with your provider and client keys:

```sh
GATEWAY_API_KEY=client OPENAI_API_KEY=provider OPENAI_MODEL=gpt-5-mini \
  devenv shell -- yarn workspace @better-router/example-quickstart start
```

It exposes `POST /v1/chat/completions` at `http://127.0.0.1:8787`:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer client' \
  -H 'Content-Type: application/json' \
  -d '{"model":"quickstart","messages":[{"role":"user","content":"Hello"}]}'
```

See [all examples](examples/README.md) for cross-provider fallback and in-process SDK calls.

## Effect AI

`@better-router/core` can provide a Better Router alias as an Effect AI
`LanguageModel`. The model Layer requires the existing `RouterRuntime`, so it
can be composed with the same router used by HTTP adapters:

```ts
import { Effect, Schema } from "effect"
import { LanguageModel } from "effect/ai"
import { EffectAI } from "@better-router/core"

const program = LanguageModel.generateObject({
	prompt: "Return a greeting",
	objectName: "greeting",
	schema: Schema.Struct({ message: Schema.String }),
}).pipe(Effect.provide(EffectAI.model("public-model")), Effect.provide(routerLayer))

// routerLayer provides RouterRuntime, for example from Router.layer(...).
```

The adapter supports text and structured generation, user-defined function
tools, continuations, and streaming. Unsupported provider-specific prompt parts
return typed `AiError` values.

## Development

```sh
devenv shell -- yarn check
devenv shell -- yarn build
```

Read the [architecture](docs/architecture.md) for router and plugin contracts, [testing guide](docs/testing.md) for checks and test boundaries, and [project terminology](CONTEXT.md) for domain terms.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
