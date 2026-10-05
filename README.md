# Better Router

Better Router is an Effect based generation gateway. Public model aliases select
provider deployments while protocol adapters preserve their own wire formats.

Plugins follow the Better Auth object pattern. Stable capabilities, deployment
configuration, and runtime services are separate: `Router.make` checks the full
declaration graph and returns a `Result`; `Router.runtime` acquires services and
scoped resources.

```text
Plugin declarations → Registry → model route → Deployment
  → Provider Contract → Generation.Process → protocol projection
```

`Generation.Process` exposes semantic events, a terminal response, and
cancellation. Routing pipelines, policies, lifecycle hooks, and HTTP adapters use
the same process for SDK calls and gateway requests.

Declare a public alias independently from its upstream model and credential:

```ts
import { Router } from "@better-router/core"
import * as Responses from "@better-router/plugin-openai-responses"

const configured = Router.make({
	plugins: [
		Responses.plugin({
			deployments: [
				{
					id: "openai-primary",
					provider: "openai",
					model: "private-provider-model",
					protocol: "responses",
					credentialRef: "openai-primary-key",
				},
			],
			modelRoutes: [{ model: "chat", deployments: ["openai-primary"] }],
		}),
	] as const,
})
```

`configured` is a pure `Result`: preflight fails before any Layer starts. After
checking it, the host acquires `Router.runtime(router)` in a Scope or provides
`Router.layer(router)`, supplying `HttpClient` and `CredentialResolver` Layers.
SDK callers use `runtime.generate`; HTTP hosts serve `runtime.http.routes`.

## Packages

| Package                                           | Responsibility                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@better-router/core`                             | Capabilities, plugin declarations, immutable registry, deployments, routing, lifecycle, persistence ports, and Generation ABI |
| `@better-router/provider-openai`                  | OpenAI Responses and Chat Completions deployment runtimes                                                                     |
| `@better-router/provider-anthropic`               | Anthropic Messages deployment runtimes                                                                                        |
| `@better-router/protocol-openai-responses`        | Responses HTTP API, wire Schemas, conversions, and handler                                                                    |
| `@better-router/protocol-openai-chat-completions` | Chat Completions HTTP API, wire Schemas, conversions, and handler                                                             |
| `@better-router/protocol-anthropic-messages`      | Messages HTTP API, wire Schemas, conversions, and handler                                                                     |
| `@better-router/plugin-openai-responses`          | Responses ingress and deployment plugin factory                                                                               |
| `@better-router/plugin-openai-chat-completions`   | Chat Completions ingress and deployment plugin factory                                                                        |
| `@better-router/plugin-anthropic-messages`        | Anthropic Messages ingress and deployment plugin factory                                                                      |
| `@better-router/persistence-sql`                  | Optional Effect SQL persistence and migrations                                                                                |
| `@better-router/effect-ai`                        | Effect AI `LanguageModel` backed by router generation                                                                         |

## Quick start

Install and build the workspace:

```sh
devenv shell -- yarn install --immutable
devenv shell -- yarn build
```

Run the quickstart with provider and gateway credentials:

```sh
GATEWAY_API_KEY=client OPENAI_API_KEY=provider OPENAI_MODEL=gpt-5-mini \
  devenv shell -- yarn workspace @better-router/example-quickstart start
```

It exposes `POST /v1/chat/completions` and `POST /v1/responses` on
`http://127.0.0.1:8787` using the public `quickstart` alias. The alias maps to a
static OpenAI Responses deployment. The host supplies its `HttpClient` and
`CredentialResolver` Layers; the deployment only contains a credential
reference.

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer client' \
  -H 'Content-Type: application/json' \
  -d '{"model":"quickstart","messages":[{"role":"user","content":"Explain model routing in one sentence."}]}'
```

See [all examples](examples/README.md) for cross-provider fallback and in-process
calls. Fallback may select another deployment before the first semantic event;
partial output is never replayed.

## Development

```sh
devenv shell -- yarn check
devenv shell -- yarn build
devenv shell -- yarn generate:openresponses --check
```

Read [the architecture](docs/architecture.md), [the testing guide](docs/testing.md),
and [project terminology](CONTEXT.md) for contracts and boundaries. The current
execution domain is Generation; media, embeddings, realtime, and management
APIs can be added through domain-specific plugins.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
