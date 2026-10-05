# Architecture

Better Router is an Effect based generation gateway. It presents one
protocol-neutral generation contract to protocol adapters, while deployments,
provider credentials, routing policy, HTTP projections, and persistence remain
owned by plugins. The dependency direction is:

```text
Plugin declarations → Registry snapshot → routing pipeline → Deployment
    → Provider Contract → Generation.Process → protocol projection
```

The arrows describe ownership. A protocol package owns its wire Schema and
conversion rules. A provider package owns upstream request/response codecs and
transport details. Core composes those declarations and controls selection,
cancellation, fallback, and resource lifetime.

## Static declarations and runtime state

The plugin object is the assembly boundary. Its declarations are immutable and
are checked before any Layer or network resource is acquired:

```ts
const plugin = {
	id: "acme-openai",
	capabilities: [generationCapability, openAiCapability],
	config: {
		deployments: [deployment],
		modelRoutes: [modelRoute],
		policies: [policy],
		projections: [projection],
		http: [httpApi],
	},
	layer: providerLayer,
	init: (context) => initializeRuntime(context),
} as const
```

`Capability` is stable metadata: an identifier, version, kind, and supported
semantic projections or endpoint parameters. It never contains credentials,
provider model names, URLs, prices, counters, health, or cooldown state.
`PluginConfig` is static deployment and composition data. A deployment declares
its private provider model, provider identifier, protocol, credential reference,
limits, tags, and pricing. A model route separately maps a public alias to ordered
deployment candidates and fallback configuration.

Runtime data is supplied by Effect services and scoped Layers. The router keeps
active requests, latency, failure counts, cooldowns, token/request budgets,
and optional caches in an atomic runtime service. A persistence Layer can
restore and update that state; the declaration snapshot itself is never
mutated. Secrets are resolved through a credential service and are represented
by references in declarations.

## Provider Contracts and capability checks

A `ProviderContract` describes a provider's endpoint matrix, supported
parameters, request and response codecs, URL and authentication transforms,
error mapping, and stream terminal semantics. One contract can expose multiple
endpoints, such as Chat Completions and Responses, while keeping each endpoint's
capabilities explicit.

At construction time the registry validates every
`capability × deployment × endpoint` combination. Unsupported combinations,
missing references, and duplicate identifiers are `SetupError` values. They
cannot remain latent until the first request. Unknown configuration is decoded
with Effect Schema; nested issue paths are retained for the host's error
renderer.

## Registry and lifecycle

`Router.make` performs pure preflight and returns
`Result<Router.Router<Plugins>, SetupError>`. It builds one immutable
`Registry.Snapshot` containing plugin, capability, provider, deployment, model
route, policy, pipeline, projection, and HTTP indexes. The snapshot is supplied
to plugin initialization, so an initializer can inspect the complete graph but
cannot append declarations after construction.

`Router.runtime` acquires the runtime within the caller's Scope and
`Router.layer` exposes it as `RouterRuntime`. Both require the services declared
by the selected plugins. Startup proceeds in this order:

```text
static preflight
→ external service Layers
→ persistence migrations
→ runtime state services
→ plugin init in declaration order
→ protocol HTTP layers
```

An initializer may acquire resources and return runtime values. If an
initializer fails or is interrupted, the Scope releases all resources acquired
by earlier initializers. Layer requirements and typed errors are propagated
through the router's type; missing `HttpClient`, clock, credential, or SQL
services are visible at composition time.

## Generation routing pipeline

Every request is normalized into a `RoutingContext`:

```text
raw request
  → structured request + metadata
  → candidate deployments
  → ordered middleware and routing policies
  → selected deployment
  → provider process
  → usage/cost/health signals and hooks
```

Policies run as an ordered asynchronous pipeline. Each policy may narrow the
candidate set and add immutable signals used by subsequent policies and
strategies. An empty set fails with `NoCandidateDeployments`. Built-in
selection strategies include simple order, weighted choice, least busy,
latency, and cost. Health and budget filters use runtime state without
changing the static deployment.

Fallback and retry are constrained by semantic output. A connection or
protocol failure may move to the next eligible deployment before the first
generation event. Once a response or stream event has been emitted, the
router cannot replay partial output through another deployment. Cancellation,
terminal events, usage, cost, and errors all finalize the attempt and request
hooks exactly once.

`Generation.Process` remains the provider-neutral execution value. Its lazy
event stream, terminal response view, and idempotent cancellation preserve the
same lifecycle for SDK calls and HTTP adapters.

## Hooks, middleware, and HTTP

Request hooks surround the whole command (`beforeRequest`, `afterResponse`,
`onError`, and `onCancel`). Attempt hooks surround each selected deployment
(`beforeAttempt`, `afterSuccess`, `afterFailure`, `onStreamEvent`, and
`onFinalize`). Hooks run in declaration order, use typed failures, and observe
events without modifying the registry.

Plugins contribute typed HTTP APIs. Each API declares method, path, input and
output Schema, handler, and middleware. Registry construction rejects duplicate
HTTP groups and method/path pairs. Generation adapters support JSON and SSE,
authenticate before invoking an upstream, map provider errors to the protocol
error envelope, and release the upstream process when the client disconnects.
Bearer and hop-by-hop headers are filtered at the boundary. A stream emits a
protocol terminator only after a normal terminal semantic event; post-header
failures do not emit a success terminator or replay through a fallback.

The current protocol packages provide OpenAI Responses, OpenAI Chat
Completions, and Anthropic Messages projections. They depend on core's route
and generation contracts, never on a concrete provider package. The provider
packages provide OpenAI and Anthropic contracts and never import protocol
packages.

## Persistence boundary

Core defines persistence ports and a memory backend rather than a database
driver. Its namespaced typed state store uses Schema codecs and provides
`get`/`set`/`update`/compare-and-set/delete operations, transaction boundaries,
and migration declarations. The memory Layer is suitable for tests and local
hosts. The persistence companion binds those ports to Effect SQL; the host
supplies SQLite or another SQL driver, and migrations run before plugin
initialization.

The default persisted records are deployment health and cooldown, latency and
failure counters, usage/cost budgets, and optional response cache entries.
Rows are decoded through Schema before entering runtime state; credentials are
never written as cleartext. Persistence is optional: without a SQL Layer the
same runtime service uses in-memory state.

The routing snapshot has one live Router runtime owner per persistence backend.
Close that owner's Scope before starting a replacement runtime against the same
backend. Startup resets active requests and token/cost reservations, discards
unfinished attempts, and hydrates committed health, cooldown, latency, usage,
cost and budget totals for the configured deployments. It retains the current
rate window counters until their wall-clock window expires. This restart
recovery does not coordinate simultaneous Router owners; multi-process routing
requires a separate ownership and fencing protocol.

## Functional and validation boundaries

All untrusted wire values, plugin descriptors, configuration, database rows,
and upstream events are decoded once with Effect Schema. Pure conversion and
selection functions return `Result` or immutable values; Effects and Streams
own I/O, resource acquisition, interruption, and concurrency. Public models
are deeply readonly at the type level. Registry indexes use immutable
collections and are built before any external effect runs.

The required local checks are:

```sh
devenv shell -- yarn check
devenv shell -- yarn build
devenv shell -- yarn generate:openresponses --check
```

The Generation domain is the first execution domain. Embeddings, audio,
images, batches, realtime, and other provider-specific domains can register
their own capability and contract in the same plugin shape without widening
the Generation ABI.
