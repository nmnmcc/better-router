# Architecture

Better Router is organized around a semantic generation contract and small
Effect Context services. The dependency direction is:

```text
Protocol Api → Convert → Route → Provider Context → Generation.Process
```

The arrows describe ownership. A protocol package owns its public HTTP
contract and wire Schema. Its pure conversion functions project that wire
shape into the core request and project semantic events back to the wire. The
protocol handler asks `Route` for a process and does not know which provider is
used.

## Core contracts

`Generation` contains the protocol-neutral request, event, and response model.
Its `Process` namespace constructs a live process:

- `events` is a lazy semantic event stream;
- `response`/`terminal` fold one subscription to exactly one terminal response;
- `cancel` interrupts all views created from the process and is idempotent.

Providers return `Generation.Process<ProviderError, R>`. A process is therefore
the lifecycle of one generation, not a static response or an opaque native
execution object. A missing or duplicate terminal event becomes
`Generation.ProcessError`.

`Route` is the only routing Context service. `Route.layer` accepts a map whose
keys are public model aliases:

```ts
Route.layer({
	chat: (request) => openai.generate(request),
	reliable: (request) =>
		primary.generate(request).pipe(
			Effect.catchIf(
				(error) => error.retryable,
				() => fallback.generate(request),
			),
		),
})
```

The handler owns provider choice, retry timing, health checks, and the point at
which a failed stream can no longer be replayed. An unknown alias is
`RouteUnknownModel`; malformed requests and handler failures are Schema-backed
Route errors. The public model alias is the map key. Provider model identifiers
remain inside provider Layers.

`Provider.Error` is the small normalized failure vocabulary shared by concrete
provider packages. Core does not register providers, deployments, capabilities,
or provider models. Each provider package exposes its own Context service and a
Layer that decodes configuration, obtains an `HttpClient`, and owns upstream
resources.

`Api.Contract` is the only API combination type in core. A protocol package
exports its own `HttpApi`, errors, wire Schemas, conversions, and handler Layer,
usually as `contract`. `Router.make` combines the contract metadata and injects
the composed `Route`; it does not contain protocol decoding or provider logic.
`HttpApiGroup` remains an implementation detail of each protocol package.

`Convert` is pure. It uses `Result` for fallible projections and preserves
Schema issue paths such as `request.messages[0].content[1].image_url.url`.
Protocol-specific unsupported semantics are rejected by that protocol's
conversion error contract.

## Provider packages

`@better-router/provider-openai` exposes `OpenAIResponses` and
`OpenAIChatCompletions`. `@better-router/provider-anthropic` exposes
`AnthropicMessages`. These packages contain their upstream request Schema,
HTTP status normalization, SSE decoding, and native event assembler. They
depend on core only; they do not import protocol packages.

The assembler translates provider chunks into semantic `Generation.Event`
values before the process is returned. A retryable connection or protocol error
can be handled by the route before the first semantic event. Once output has
started, a route must not replay partial output through a fallback.

## Protocol packages

The three protocol packages are independent of providers:

- `protocol-openai-responses` owns the pinned generated Responses Schema and
  JSON/SSE projection;
- `protocol-openai-chat-completions` owns Chat Completions request/response
  shapes, tool/image conversion, and SSE projection;
- `protocol-anthropic-messages` owns Messages request/response shapes,
  authentication metadata, and SSE projection.

Each HTTP handler authenticates and decodes its request before calling Route.
Non-streaming requests consume `process.response`; streaming requests consume
`process.events`. Client cancellation calls `process.cancel`. A normal stream
gets its protocol terminator (`[DONE]` or `message_stop`) only after a terminal
semantic event and clean source completion.

## Composition and hosts

`Router.make({ route, providers, apis })` builds an in-process composed router.
The effect must run with the services required by the supplied provider Layers
(for example, provide `NodeHttpClient.layerUndici` at this composition scope).
`Router.layer` exposes the same composition as a Layer for a long-lived host.
Both functions only merge provider Layers, provide those Layers to the route,
inject Route into protocol handlers, and combine the `HttpApi` fragments.
`Router` is the composition seam. It builds the Route Layer with the supplied
provider Layers, injects Route into each protocol handler Layer, and combines
the protocol `HttpApi` contracts. It has no registration, execution, or
projection algorithm of its own.

The host supplies `HttpRouter.serve`, `NodeHttpServer`, `NodeHttpClient`, and
the serving Scope. No loopback request is needed for SDK or Effect AI usage.
`@better-router/effect-ai` provides an Effect AI `LanguageModel` Layer that
calls Route directly and maps `Generation.Process` completion, streaming,
tools, and typed failures.

## Boundaries and validation

Every untrusted wire, provider configuration, and upstream event is decoded by
Effect Schema before semantic projection. Domain conversions do not perform
I/O, read clocks, throw, or mutate captured state. Effects and Streams own
I/O, cancellation, and resource lifetimes; Layers own service acquisition.
Public model values are deeply readonly at the type level.

The required checks are:

```sh
devenv shell -- yarn check
devenv shell -- yarn build
devenv shell -- yarn generate:openresponses --check
```
