# Architecture

Better Router is organized around a semantic generation contract and
Better Auth-style object plugins. The dependency direction is:

```text
Plugin declaration → Registry → Route → Provider Context → Generation.Process
```

The arrows describe ownership. A protocol package owns its public HTTP
contract and wire Schema. Its pure conversion functions project that wire
shape into the core request and project semantic events back to the wire. The
protocol handler asks `Route` for a process and does not know which provider is
used.

## Core contracts

`Capability` and `State` are deliberately different contracts. A capability is
the stable, stateless identity of a feature (`id`, version, kind and semantic
projections). State is process configuration: route Layers, provider Layers,
HTTP contracts and credentials. A key or provider model can therefore change
without changing the capability identity.

`Plugin` is an explicit object, following the Better Auth plugin shape:

```ts
const plugin = {
	id: "openai-responses",
	capabilities: [Responses.capability, OpenAI.capability],
	state: {
		apis: [Responses.makeContract({ gatewayKey })],
		providers: [OpenAI.layer(providerConfig)],
	},
}
```

`Router.make({ plugins })` receives the tuple directly. `Registry` reduces the
declarations immutably, rejects duplicate plugin/capability IDs and HTTP
routes, and only then starts plugin hooks or builds resource Layers. A plugin
startup hook may acquire resources, but it cannot add a new declaration after
construction.

`Generation` contains the protocol-neutral request, event, and response model.
Its `Process` namespace constructs a live process:

- `events` is a lazy semantic event stream;
- `response`/`terminal` fold one subscription to exactly one terminal response;
- `cancel` interrupts all views created from the process and is idempotent.

Providers return `Generation.Process<ProviderError, R>`. A process is therefore
the lifecycle of one generation, not a static response or an opaque native
execution object. A missing or duplicate terminal event becomes
`Generation.ProcessError`.

`Route` is the only routing Context service. `Route.plugin` accepts a map whose
keys are public model aliases and stores the resulting route Layer in plugin
state:

```ts
Route.plugin({
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
provider packages. Each provider package exposes its own Context service and a
Layer that decodes configuration, obtains an `HttpClient`, and owns upstream
resources. The provider Layer is state supplied by a plugin; the provider
capability remains independent of that state.

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

`Router.make({ plugins })` builds an in-process composed router. A route may be
declared as `Route.plugin(handlers)` or supplied directly for compatibility.
The effect must run with the services required by the supplied state Layers
(for example, provide `NodeHttpClient.layerUndici` at this composition scope).
`Router.layer` exposes the same composition as a Layer for a long-lived host.
The composer provides plugin provider Layers to the route, injects Route into
plugin HTTP handlers, and combines their `HttpApi` contracts. The resulting
router exposes its immutable `registry` for inspection and host integration.

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
