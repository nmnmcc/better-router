# Better Router

Better Router maps public model aliases to provider-backed generation
processes. Protocol adapters expose those processes through compatible wire
contracts, and in-process callers use the same router runtime.

## Language

**Generation process**: A live, cancellable generation with semantic events and
one terminal response, represented by `Generation.Process`.

**Capability**: Stable, stateless feature metadata: identifier, version,
projections, endpoint parameters, and streaming support. It never contains
credentials, URLs, provider models, pricing, counters, or health.

**Plugin**: An explicit Better Auth-style object with an id, capabilities,
static `config` contributions, and optional `layer`/`init` runtime acquisition.

**Plugin configuration**: Declarations for provider contracts, deployments,
model routes, policies, pipelines, middleware, hooks, projections, HTTP APIs,
and persistence namespaces. Configuration is preflighted as one graph.

**Deployment**: A stable private identifier binding one provider model to a
provider protocol, credential reference, optional endpoint URL, pricing,
limits, weight, and tags.

**Model route**: A public model alias with an ordered set of deployment
candidates, optional selection policy, and fallback policy.

**Routing runtime**: Scoped services that track health, cooldown, active
requests, latency, usage, and cost. Runtime state is separate from declarations
and may be backed by a persistence Layer.

**Provider Contract**: A provider's endpoint capability matrix and runtime
factory. The factory creates a client bound to one deployment, allowing several
deployments of the same provider without service replacement.

**CredentialResolver**: A host-supplied core service resolving a deployment's
credential reference to a redacted secret.

**Protocol API**: A protocol's `HttpApi`, request/response/event Schemas,
conversion functions, HTTP handler, and projection metadata.

**Convert**: A pure projection between a protocol wire value and Generation
values. It returns `Result` and preserves Schema field paths.

**Router**: `Router.make` performs pure preflight and returns a `Result` with an
immutable registry. `Router.runtime` acquires runtime services inside a Scope;
`Router.layer` exposes the same runtime through `RouterRuntime`.

**Public model alias**: The caller-visible model name declared in a model route.

**Provider model**: The upstream model identifier held by a deployment.

**Protocol HTTP endpoint**: An externally accessible method and path with a
protocol-specific request and response format.

**Upstream transport**: The provider's invocation transport, independent of the
ingress protocol.

## Design rules

- Protocol packages depend on core and never on provider packages.
- Provider packages depend on core and never on protocol packages.
- Plugin declarations are validated before resource acquisition; initialization
  cannot add declarations.
- Credentials and runtime state are supplied by services and scoped Layers.
- Untrusted boundaries decode through Schema before semantic projection.
- Pure conversion uses `Result`; I/O and lifecycle use `Effect` and `Stream`.
- Fallback stops when the first semantic event is observed.
- `Generation.Process.cancel` is the owner-visible cancellation boundary.
