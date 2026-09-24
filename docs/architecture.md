# Architecture

The runnable gateway uses Effect 4.0.0-rc.117 end to end. The core router composes plugin declarations at acquisition: the OpenAI Chat Completions plugin contributes the HTTP endpoint and the OpenAI Responses plugin contributes a deployment. The TypeScript example supplies Node Layers and runs with `tsx`; it contains no request handling or Web Stream adapter.

## Modules and IR

The flat workspace names plugins `plugin-{creator}-{protocol}` and exposes PascalCase modules directly from each package. Core owns `Model`, `Deployment`, `Routing`, `Transform`, `Http`, `Plugin`, and `Router`. `@better-router/plugin-openai-chat-completions` owns pure Chat request conversion in `OpenAIChatCompletions`, HTTP ingress and egress in `OpenAIChatCompletionsHttp`, and an HTTP-only `OpenAIChatCompletionsPlugin`. `@better-router/plugin-openai-responses` owns the OpenAI upstream executor in `OpenAIResponses` and a deployment-only `OpenAIResponsesPlugin`. Neither package depends on the other. `@better-router/plugin-anthropic-messages` exports `AnthropicMessages` and `AnthropicMessagesPlugin` declarations but has no runtime executor yet.

`ModelRequest`, `ModelEvent`, and `ModelResponse` follow the pinned [OpenResponses 2026-04-24 schema](https://www.openresponses.org/openapi/2026-04-24/openapi.json). The request's `model` is the public alias. The router changes it to the deployment's private model only when invoking that executor. Responses retain ordered output items, metadata, and usage; the router does not reduce them to text. `devenv shell -- yarn generate:openresponses` regenerates pinned types after digest verification; see [source notes](openresponses-research.md) for schema/prose differences.

The types allow prefixed extension items, tools, and events. The type declarations alone do not validate extension payloads or make provider-owned continuation IDs portable. Routing a request with `previous_response_id` through multiple deployments fails before invocation. A provider must reject semantics it cannot translate; the OpenAI HTTP executor sends the native Responses-shaped subset it accepts.

## Router lifecycle

`Router.make({ routes, plugins })` returns an `Effect` requiring `Scope` plus the plugins' declared services. Acquisition checks duplicate plugin, deployment, policy, transform and HTTP group identifiers, duplicate method/path pairs, and invalid model routes before running any plugin `start` effects. Start effects acquire resources in declaration order; their finalizers belong to the router's Scope. A plugin cannot add capabilities after construction.

All errors in public router and plugin contracts are Schema-backed. `Plugin.SetupError` and `Router.RouterError` are `Schema.TaggedUnion`s with `cases` constructors (for example, `Router.RouterError.cases.NoRoute.make({ model })`), `guards`, and exhaustive `match`. `Deployment.ProviderError` and `Routing.RoutingError` are structural `Schema.Struct` values, so plugin implementations can return plain objects. Exported conversion, upstream-response, and invalid-URL errors use `Schema.TaggedError` while retaining `Error` behavior and object-field constructors. Arbitrary `cause` fields use `Schema.Defect` for a lossy JSON-compatible encoding that omits nested error causes and stacks; HTTP responses still select safe fields instead of forwarding those causes.

`router.open(request, options)` is the two-stage execution interface: it selects a deployment and obtains its event stream by running the executor's connection `Effect`. This lets HTTP ingress return a typed upstream error (notably 429) before committing an SSE response. `router.stream` unwraps `open`; `router.complete` consumes that same event stream and returns its sole terminal response snapshot. A missing terminal event, or an event after it, fails instead of claiming completion.

Routes list deployment IDs in fallback order; a policy may return an ordered subset of eligible candidates. A required upstream mode filters candidates before ranking, while a preferred mode uses that mode when available and otherwise selects another executor on the same deployment. Ingress HTTP versus SSE does not select upstream transport. A retryable connection or event error may move to the next deployment only before the first model event; after that, partial output must not be replayed. Transforms wrap the two-stage handler in declared order, first transform outermost.

Each plugin's `HttpApi` fragment is retained for typed reflection. `Router.make` composes those fragments with `HttpApi.addHttpApi` and merges their handler Layers; every `HttpApiBuilder.group` uses its original fragment. The host supplies Effect's HTTP platform services and owns the serving Scope. No loopback HTTP call is made for direct SDK use.

## Chat Completions gateway

`OpenAIChatCompletions.toResponseRequest(unknown)` converts supported Chat messages, images, function calls, tool results, options and structured formats to the IR. Unsupported or malformed fields receive an `OpenAIChatCompletionsConversionError` with a path; they are not silently discarded. `OpenAIChatCompletionsPlugin.make({ gatewayKey })` declares the authenticated `POST /v1/chat/completions` endpoint under the `openAIChatCompletions` HTTP group. `OpenAIResponsesPlugin.make({ deployments })` independently declares deployments created with `OpenAIResponses.make`. Gateway and provider credentials are distinct `Redacted` values, and the HTTP ingress authenticates before reading a body capped at 1 MiB. An unknown public model never reaches the upstream.

`OpenAIChatCompletionsHttpError` models the external `{ error: { message, type } }` payload, is declared on the endpoint for every returned error status, and is shared by JSON responses and post-header SSE error frames.

The Responses deployment currently targets OpenAI: it uses Effect `HttpClient` to POST to a configured Responses URL and Effect's SSE decoder to parse the upstream stream incrementally. Non-streaming Chat requests also consume this event path; `store` defaults to `false` only at Chat ingress. The Chat HTTP plugin converts the terminal snapshot to one Chat choice or projects streamed text, refusals, tool calls, finish reason and optional usage to Chat chunks. It sends `[DONE]` only after the upstream stream terminates normally. Upstream errors after response headers become a Chat SSE error frame without `[DONE]`; client cancellation interrupts the source. Unrepresentable output fails explicitly rather than reporting success.

The example reads configuration once with Effect `Config` and starts `HttpRouter.serve` with `NodeHttpServer.layer` and `NodeHttpClient.layerUndici`. It listens on loopback by default. Configuring a remote listener, TLS termination, rate limits, and observability remains the operator's responsibility. This increment includes no Anthropic runtime deployment, inbound `/v1/responses` endpoint, or WebSocket ingress; the router can select a WebSocket executor when a plugin actually declares one.

## Verification

`devenv shell -- yarn check` builds the packages, compiles TypeScript contracts, runs type inference checks, and exercises router lifecycle plus a real Node gateway against a local fake Responses upstream. `devenv shell -- yarn build` emits ESM library artifacts. Neither check requires a live OpenAI key.
