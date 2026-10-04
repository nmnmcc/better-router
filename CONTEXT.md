# Better Router

Better Router maps public model aliases to provider-backed generation
processes. Protocol adapters expose those processes through compatible wire
contracts, while in-process callers use the same Route service directly.

## Language

**Generation process**:
A live, cancellable generation with semantic events and one terminal response.
It is represented by `Generation.Process`.

**Capability**:
A stable, stateless feature identity with a version and semantic projections.
Credentials, Layers, model names and endpoint options are state, not
capabilities.

**Plugin**:
A Better Auth-style object containing an id, capability declarations and
optional state configuration. Plugins are supplied explicitly to
`Router.make({ plugins })`.

**State**:
Runtime configuration contributed by a plugin: route/provider Layers, HTTP
contracts and other resources. State is acquired after declarations have been
validated.

**Route**:
The core Context service that maps a public model alias to a handler. A handler
chooses provider services and owns retry, health, and stopping policy.

**Provider service**:
A provider-owned Effect Context service such as `OpenAIResponses`,
`OpenAIChatCompletions`, or `AnthropicMessages`. It accepts a provider request
and returns a `Generation.Process`.

**Protocol Api**:
The public wire contract for one protocol: its `HttpApi`, request/response
Schemas, errors, conversion functions, and HTTP handler Layer.

**Convert**:
A pure projection between a protocol wire value and core Route/Generation
values. It returns `Result` and preserves Schema field paths.

**Router**:
The composition entry point. It validates the plugin declarations, provides
their state Layers to Route, injects Route into protocol Api Layers, and
combines HTTP contracts. Its immutable `registry` is available for inspection.

**Public model alias**:
The model name used by a caller and the key in `Route.plugin({...})`.

**Provider model**:
The upstream model identifier held privately by a provider Layer.

**Protocol HTTP endpoint**:
An externally accessible method and path with a protocol-specific request and
response wire format.

**Upstream transport**:
The communication mode a concrete provider uses to invoke its upstream API.
It is an implementation detail of that provider, not a protocol ingress.

## Design rules

- Protocol packages depend on core and never on provider packages.
- Provider packages depend on core and never on protocol packages.
- Core keeps capability declarations and state configuration separate; the
  immutable plugin registry is the only composition source of truth.
- All untrusted boundaries are decoded with Schema before semantic projection.
- Pure conversion uses `Result`; I/O and lifecycle use `Effect` and `Stream`.
- A stream cannot be replayed after it has emitted semantic output.
- `Generation.Process.cancel` is the owner-visible cancellation boundary.
