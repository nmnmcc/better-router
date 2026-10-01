# Architecture

The router uses Effect 4.0.0 end to end. Chat Completions, OpenAI Responses, and Anthropic Messages each contribute an ingress projection and provider pipelines. A plugin declaration is pure; `Router.layer` assembles its services and owns resources in the host Scope.

## Modules and IR

The flat workspace names plugins `plugin-{creator}-{protocol}` and exposes PascalCase modules directly from each package. Core owns `Capability`, `Catalog`, `Pipeline`, `Execution`, `EffectAI`, `Lifecycle`, `Generation`, `GenerationSchema`, `GenerationEvents`, `Projection`, `Runtime`, `Ingress`, `Registry`, `Services`, `Conversion`, `HttpJson`, `Deployment`, `Routing`, `Http`, `Plugin`, and `Router`. Each protocol package owns its wire decoder, protocol projection, HTTP endpoint and provider generation pipeline; protocol packages do not depend on each other. `GenerationEvents.fromNative` is a generation assembler, not a provider-specific execution hook.

`GenerationRequest`, `GenerationEvent`, and `GenerationResponse` are the internal semantic generation contract. `GenerationSchema` is defined only from those domain values; it has no dependency on an HTTP specification. The OpenAI Responses plugin owns the generated wire types and pinned runtime schema. A plugin's `ProtocolDefinition` is the external bidirectional projection: it decodes its wire request into generation semantics and owns response encoding for its clients. Stateless event encoders validate or encode one event; protocols whose event wire format needs sequence-local state (Chat Completions and Messages) deliberately reject that operation and expose the stateful `encodeEvents` stream projector instead. A protocol command can therefore be routed through a direct opaque pipeline without first projecting, or fall back to the registered projection without carrying an ad-hoc conversion closure. `devenv shell -- yarn generate:openresponses --check` verifies the pinned Responses plugin artifacts; see [source notes](openresponses-research.md) for schema/prose differences.

The types allow prefixed extension items, tools, and events. Extension payloads and provider-owned continuation IDs are not portable. A request with `previous_response_id` requires one deployment and only the Responses provider pipeline accepts it; other projections reject it. `DirectPipeline` is the native execution seam: it receives the selected private model and an immutable wire body, and returns a lazy opaque response stream. The pipeline is a declaration, not an imperative hook, so direct execution participates in the same routing, middleware, Scope and cancellation rules as semantic generation.

## Router lifecycle

`Router.make({ plugins })({ routes })` returns an `Effect` requiring `Scope` plus the plugins' declared services; the first stage fixes the plugin tuple so route references receive precise editor completions. `Router.layer({ plugins })({ routes })` lifts the same acquisition into a Layer for a long-lived `ManagedRuntime`. The immutable `Registry.Snapshot` is the single source of truth for capabilities, deployments, policies, middleware, direct pipelines, projections, model routes, and composed HTTP fragments; it is provided as the `Registry` Context service to plugin startup and HTTP Layers. Acquisition checks duplicate plugin, capability, deployment, pipeline, policy, middleware, projection and HTTP group identifiers before running any plugin `start` effects. Start effects acquire resources in declaration order; their finalizers belong to the router's Scope. A plugin cannot add capabilities after construction.

Configuration identifiers use literal-preserving generic fields and the `Identifier` extraction helpers. The first `Router.make`/`Router.layer` stage infers deployment, policy, protocol, capability and middleware ID unions from the readonly plugin tuple; the second stage then checks route references and literal model aliases at the static composition seam without allowing routes to widen those unions. Values deliberately typed as `string` remain a dynamic configuration escape hatch: they are accepted without spelling-level checks, while `Registry` retains responsibility for runtime duplicate and unknown-reference errors at the external-input boundary.

All errors in public router and plugin contracts are Schema-backed data. `Plugin.SetupError` and `Router.RouterError` are tagged unions of `Schema.TaggedError` cases with `cases` constructors (for example, `Router.RouterError.cases.NoRoute.make({ model })`), `guards`, and exhaustive `match`. `Deployment.ProviderError`, `Routing.RoutingError`, conversion errors, HTTP JSON input errors, and plugin deployment/projection errors are also `Schema.TaggedError` classes, so every typed failure is a native tagged Effect error as well as a validated Schema value. Pure protocol conversions and deployment constructors return `Result`; router acquisition, execution, and streams use `Effect`/`Stream`. Arbitrary `cause` fields use `Schema.Defect` for a lossy JSON-compatible encoding that omits nested error causes and stacks; HTTP responses select safe fields instead of forwarding causes.

The functional boundary is explicit: domain transitions use `Option`, immutable arrays and Effect `HashMap`/`HashSet` with pure reducers; stream accumulators start anew for each subscription. `Effect.forEach` sequences item effects. Host Layers and tests may use scoped `Ref`/`Deferred` for unavoidable coordination, while native server, process, buffer, file, clock and Promise operations stay at host boundaries. Review forbids loops, variable/property reassignment, mutable collections, mutation through collection callbacks, ad hoc classes and thrown exceptions in domain code; declarative `Schema.TaggedError` classes are the typed error contract. There is intentionally no automatic syntax gate.

`router.invoke(command, options)` is the single execution seam. A generation command returns semantic events; a protocol command may return an opaque response from a declared `DirectPipeline`, or fall back to a registry projection when no direct path exists. `Execution.complete` consumes one generation stream and requires one terminal snapshot. Every execution owns a `Deferred` cancellation signal that interrupts its response stream. Construction is lazy; `Effect`, `Stream`, `Layer` and `Scope` determine when I/O starts, who owns it, and how cancellation propagates.

`EffectAI.model(alias)` is the in-process upstream Layer for Effect AI. It
provides `LanguageModel.LanguageModel`, `Model.ProviderName` as
`"better-router"`, and `Model.ModelName` as the route alias while requiring
`RouterRuntime`. `LanguageModel.make` owns structured-output decoding and
toolkit execution; the adapter only projects portable `Prompt` values into a
`GenerationRequest` with the fixed alias, stream flag, continuation ID,
portable function tools, tool choice, and JSON Schema response format.

Non-streaming calls complete `Execution` and map the terminal response into
Effect AI response parts. Streaming calls keep immutable state local to each
subscription so metadata, text/reasoning boundaries, incremental tool
arguments, decoded tool calls, and finish parts remain ordered. A failed
terminal response emits an error part followed by `finish(error)` for streams;
router stream failures use the Effect error channel. Both completion and stream
consumption call `Execution.cancel` during finalization, including interruption.
Prompt files/images, approvals, provider metadata, and provider-defined or
dynamic tools are rejected as typed `AiError` values rather than discarded.

Routes list deployment IDs in fallback order; a policy may return an ordered subset of eligible candidates. A required upstream mode filters candidates before ranking, while a preferred mode uses that mode when available and otherwise selects another executor on the same deployment. Ingress HTTP versus SSE does not select upstream transport. A retryable connection or event error may move to the next deployment only before the first model event; after that, partial output must not be replayed. Middleware wraps the complete command handler in declared order, first middleware outermost.

Each plugin's `HttpApi` fragment is retained for typed reflection. The staged `Router.make({ plugins })({ routes })` composes those fragments with `HttpApi.addHttpApi` and merges their handler Layers; every `HttpApiBuilder.group` uses its original fragment. The host supplies Effect's HTTP platform services and owns the serving Scope. No loopback HTTP call is made for direct SDK use. Streaming requests invoke the same projection/direct-pipeline seam; direct responses preserve provider-owned fields while cross-protocol requests use semantic generation events.

## Protocol adapters

The HTTP endpoints are `POST /v1/chat/completions`, `POST /v1/responses`, and `POST /v1/messages`. They authenticate before reading a JSON body capped at 1 MiB. OpenAI endpoints require the gateway Bearer key; Anthropic accepts its `x-api-key` or a Bearer key and requires `anthropic-version: 2023-06-01`. Gateway and upstream credentials are separate `Redacted` values. An unknown public model never reaches an upstream.

Supported cross-protocol data includes text, URL and base64 data URI images, function tools and results, JSON Schema output, applicable sampling/length controls, usage and incremental streams. A Chat or Anthropic upstream always requests streaming; a non-streaming ingress consumes the same event path to a complete snapshot. Anthropic requires `defaultMaxTokens` on deployment and uses an explicit request maximum first. The Responses executor uses the native Responses event stream. Each HTTP, upstream event, and host configuration boundary parses through Schema before projection; structural failures retain field paths and unportable semantics fail explicitly. Audio/video, built-in tools, reasoning state, cache options, nonportable annotations and cross-provider continuation are not silently discarded.

Each HTTP adapter projects native JSON, SSE and error envelopes. `router.invoke` permits a connection-stage 429/5xx response before committing SSE; once semantic events have started, failures produce a native error frame without a success terminator or replay. Chat and Responses send `[DONE]` only after a normal terminal stream. Anthropic sends `message_stop` only after the source ends normally. Client cancellation interrupts the upstream source. `store: true` is unsupported by Chat and Anthropic deployments; Responses may forward it to its direct provider pipeline.

The examples read configuration once with Effect `Config` and start `HttpRouter.serve` with `NodeHttpServer.layer` and `NodeHttpClient.layerUndici`. They listen on loopback by default. Configuring a remote listener, TLS termination, rate limits and observability remains the operator's responsibility. No WebSocket ingress is declared; the router can select one if a plugin declares an executor.

## Verification

`devenv shell -- yarn check` builds the packages, checks type contracts, and exercises the package tests and guided example references. Protocol adapter tests check both JSON and SSE, native request shapes, images, tools, JSON Schema, usage, errors, truncated and malformed streams, body limits and cancellation. `devenv shell -- yarn build` emits ESM artifacts. Neither command requires a provider key or internet access.
