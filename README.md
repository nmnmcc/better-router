# Better Router

Better Router is an Effect based model router. It gives every protocol the same
semantic generation contract while keeping provider credentials, HTTP wire
formats, and routing policy at their owning boundaries.

The dependency direction is deliberately small:

```text
protocol Api → Convert → Route → provider Context → Generation.Process
```

`Generation.Process` represents one live generation. It exposes a semantic
event stream, a terminal response view, and cancellation. A provider creates a
process; a protocol consumes its events.

## Packages

| Package                                           | Responsibility                                                                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `@better-router/core`                             | `Generation`, `Route`, provider error contracts, pure `Convert`, protocol `Api` contracts, and the Layer-only `Router` composer |
| `@better-router/provider-openai`                  | `OpenAIResponses` and `OpenAIChatCompletions` Context services and upstream Layers                                              |
| `@better-router/provider-anthropic`               | `AnthropicMessages` Context service and upstream Layer                                                                          |
| `@better-router/protocol-openai-responses`        | Responses `HttpApi`, wire Schemas, conversions, and HTTP handler Layer                                                          |
| `@better-router/protocol-openai-chat-completions` | Chat Completions `HttpApi`, wire Schemas, conversions, and HTTP handler Layer                                                   |
| `@better-router/protocol-anthropic-messages`      | Messages `HttpApi`, wire Schemas, conversions, and HTTP handler Layer                                                           |
| `@better-router/effect-ai`                        | Effect AI `LanguageModel` Layer backed directly by `Route`                                                                      |

## Quick start

Install and build the workspace:

```sh
devenv shell -- yarn install --immutable
devenv shell -- yarn build
```

A route is a map from public model aliases to handlers. A handler selects and
combines provider services, so failover and health policy stay local to the
application's route:

```ts
import { Effect } from "effect"
import { Route, Router } from "@better-router/core"
import { OpenAIResponses } from "@better-router/provider-openai"
import * as ChatCompletions from "@better-router/protocol-openai-chat-completions"

const provider = OpenAIResponses.layer({ model, apiKey, url })
const route = Route.layer({
	chat: (request: Route.Request) =>
		Effect.gen(function* () {
			const openai = yield* OpenAIResponses.OpenAIResponses
			return yield* openai.generate(request)
		}),
})

const program = Effect.gen(function* () {
	return yield* Router.make({
		route,
		providers: [provider],
		apis: [ChatCompletions.contract],
	})
})
```

`Router.make` and `Router.layer` only compose Layers. Protocol HTTP handlers
depend on `Route`; they never select a provider directly. The host supplies its
Effect HTTP server and client Layers, for example:

```ts
const server = Layer.unwrap(
	Effect.gen(function* () {
		const router = yield* Router.make({
			route,
			providers: [provider],
			apis: [ChatCompletions.contract],
		})
		return HttpRouter.serve(router.http.routes).pipe(
			Layer.provide(NodeHttpServer.layer(createServer)),
		)
	}).pipe(Effect.provide(NodeHttpClient.layerUndici)),
)
```

Run the complete quickstart example with provider and gateway credentials:

```sh
GATEWAY_API_KEY=client OPENAI_API_KEY=provider OPENAI_MODEL=gpt-5-mini \
  devenv shell -- yarn workspace @better-router/example-quickstart start
```

It exposes `POST /v1/chat/completions` on `http://127.0.0.1:8787` using the
public `quickstart` alias. See [all examples](examples/README.md) for
cross-provider fallback and in-process calls.

## Effect AI

The Effect AI adapter is a separate package and calls `Route` in process:

```ts
import { Effect } from "effect"
import { LanguageModel } from "effect/ai"
import { EffectAI } from "@better-router/effect-ai"

const model = EffectAI.model("chat")
const program = LanguageModel.generateText({ prompt: "Say hello" }).pipe(
	Effect.provide(model),
	Effect.provide(route),
	Effect.provide(provider),
)
```

It maps portable prompts, tools, structured output, completion, and streaming
to `Generation.Process`, preserving typed route and provider failures.

## Development

```sh
devenv shell -- yarn check
devenv shell -- yarn build
devenv shell -- yarn generate:openresponses --check
```

Read [the architecture](docs/architecture.md), [the testing guide](docs/testing.md),
and [project terminology](CONTEXT.md) for the contracts and boundaries.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
