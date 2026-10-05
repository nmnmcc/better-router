# Replacing shape-repair helpers with normalized data

This is an implementation method, not an instruction to delete every short function. The historical investigation and its synthetic stream-ordering observation are in [the investigation](data-normalization-research.md). This edition follows the plugin architecture introduced on 2026-10-05: core owns the Generation ABI, protocol packages own wire conversion and HTTP, and provider packages own deployment execution.

Normalization should remove representational branches without losing protocol distinctions. Keep operation-local views private until two real consumers justify a shared module.

## Decide what a helper owns

1. **Shape repair:** Repeated string/array checks, optional-field proofs, and untyped record lookups suggest an imprecise intermediate shape. Replace that shape with an immutable tagged value whose facts come from Schema decoding or pure conversion.
2. **Semantic rule:** Grouping items, assigning identity, rejecting nonportable features, and classifying errors are protocol decisions. Keep these rules in the owning converter, provider, or assembler.
3. **Wire encoding:** Native HTTP, JSON, and SSE envelopes belong to their protocol. Similar helper names do not establish a shared wire contract.
4. **Mechanical wrapping:** Consolidate only if it removes caller knowledge. A wrapper around the same parameters and branches is not a deeper module.

If deleting a helper makes its branches reappear in callers, the helper owns useful behavior. If callers consume a proven shape and those branches disappear, deletion improves locality. Function count and line count are not success criteria.

## Place each shape at the right boundary

```text
untrusted native JSON/SSE
  -> protocol or provider wire Schema
  -> explicit supported-native variant
  -> full Generation request or provider-native operations
  -> source-aware operation-local view
  -> target-specific draft
  -> native encoder or canonical event stream
```

A Schema establishes structural facts and original issue paths. A capability projection decides whether valid semantics are portable. A local view simplifies computation. A provider encoder decides native grouping, images, arguments, and required defaults. Do not collapse these into a universal pass that silently drops fields.

Core [GenerationRequest](../packages/core/src/Generation.ts) and [GenerationSchema](../packages/core/src/GenerationSchema.ts) are protocol-neutral. The dated OpenResponses wire Schema lives in [protocol-openai-responses](../packages/protocol-openai-responses/src/OpenAIResponsesSchema.ts); it is one external projection, not the core implementation dependency. Neither contract should be replaced by a text-only message model.

The conversion boundary is a protocol `Convert.decodeRequest`, `encodeResponse`, or `encodeEvent`, or a provider request/event conversion. Keep intermediate drafts inside that owning PascalCase module first. Pure conversion uses `Result`; internal absence uses `Option`; streaming and resource acquisition use `Stream` and `Effect`.

### Preserve information in the private shape

```ts
type Source = {
	readonly path: string
	readonly form: "string" | "parts" | "native"
}

type NormalizedEntry =
	| {
			readonly kind: "message"
			readonly payload: MessagePayload
			readonly source: Source
	  }
	| {
			readonly kind: "function_call"
			readonly payload: FunctionCallPayload
			readonly source: Source
	  }
	| {
			readonly kind: "function_result"
			readonly payload: FunctionResultPayload
			readonly source: Source
	  }

type Presence<A> =
	| { readonly kind: "absent" }
	| { readonly kind: "null" }
	| { readonly kind: "value"; readonly value: A }
```

The payload types above are operation-local placeholders, not proposed core exports. Add `Presence` only when omission, nullability, or an empty value changes a support decision or output. Otherwise use `Option` or keep the decoded source field.

- **Source paths and forms:** Shorthand `input` errors must remain at `input`, not at a synthetic array path. Preserve string versus parts when the target makes a form-specific decision.
- **Presence:** Preserve absent, `null`, `[]`, `false`, and `0` where they differ observably. Do not use truthiness to decide whether a setting exists.
- **Order and identity:** Retain item/content order, tool call IDs, native block indices, and item lifetimes. Anonymous text cannot represent every native stream.
- **Unsupported semantics:** Preserve or explicitly reject extensions, phase, annotations, reasoning, strict tools, continuation, and provider fields. Keep [ConversionError](../packages/core/src/Convert.ts) reason and source path.
- **Provider facts:** Maximum-token defaults, image restrictions, JSON argument decoding, unavailable usage, finish reasons, retryability, and native terminators remain provider-owned.

## Keep configuration normalization separate from runtime state

Plugins declare capability metadata and `config` contributions before acquisition. `Router.make` returns a pure `Result<Router.Router<Plugins>, SetupError>` and creates the immutable Registry. `Router.runtime` or `Router.layer` then resolves external services, migrations, deployment factories, and plugin `init` inside a Scope. This is a different normalization boundary from native request conversion; see [Plugin](../packages/core/src/Plugin.ts), [Registry](../packages/core/src/Registry.ts), and [Router](../packages/core/src/Router.ts).

`Capability` records stable, credential-free support. `DeploymentConfig` records private model, endpoint, pricing, limits, and credential reference. Shared [CredentialResolver](../packages/core/src/ProviderContract.ts) and deployment factories acquire runtime credentials and clients. Health, concurrent calls, cooldown, and usage belong to runtime services and [Persistence](../packages/core/src/Persistence.ts), not to capabilities or request drafts.

Compile declaration-only IDs and references once during preflight. Run health filtering, asynchronous pipelines, policy ranking, and budget decisions for each invocation. A policy result must remain an ordered subset of the eligible candidates; resolve IDs back to canonical deployments rather than trusting replacement runtime objects. Dynamic npm/config plugin loading and runtime declaration insertion are outside this architecture.

## Change one observable boundary at a time

1. **Characterize current behavior.** Record accepted and rejected input, native JSON/SSE output, error reason/path, and unchanged caller input. Include shorthand input, parts, empty content, tool-only messages, mixed calls/results, omitted/null/empty tools, instruction sources, and unsupported variants.
2. **Replace outgoing construction state.** Use target-specific tagged drafts and required readonly collections, then encode the native string/array/null form once. Preserve provider grouping; Chat function calls and Anthropic tool-use blocks are not interchangeable.
3. **Parse native ingress once.** Keep protocol facts such as stream options alongside the decoded request if the HTTP projection needs them. A separate Generation Schema decode proves a different boundary; do not repeat the native body decode merely to recover a field.
4. **Specify stream identity before changing it.** The [OpenAI](../packages/provider-openai/src/GenerationAssembler.ts) and [Anthropic](../packages/provider-anthropic/src/GenerationAssembler.ts) assemblers currently use anonymous native text and one message index. The [historical text-tool-text characterization](data-normalization-research.md#native-stream-identity) remains a reason to test ordering explicitly. Decide whether native text blocks become distinct parts or output items before adding identity-bearing operations. Full Responses events must retain their richer event model.
5. **Share error facts only when policy matches.** Common status/category facts may be useful, while each protocol retains its native error envelope and stream framing. Provider-specific retryability and terminal handling require their own tests.

Each slice should replace its old path rather than keep parallel conversion pipelines. The normalization pilot's outcomes are historical evidence; current behavior is verified at the existing package boundaries.

## Completion gate

- Accepted/rejected input, native output, event order, sequence numbers, terminal resources, statuses, reasons, and nested paths match the stated contract. A deliberate behavior fix has a regression expectation.
- Callers consume proven required fields or tagged variants; the old branches and casts disappear. No new bag of shape-repair wrappers replaces them.
- Pure conversion preserves its input. Streams initialize state per subscription, retain backpressure, and release resources on interruption. Fallback stops after the first semantic event has been exposed.
- Protocol conversion, provider execution, Registry preflight, and scoped lifecycle are tested at their own boundaries. Start from [protocol conversion tests](../packages/protocol-openai-chat-completions/test/Convert.test.ts), [provider tests](../packages/provider-anthropic/test/AnthropicMessages.test.ts), [Generation process tests](../packages/core/test/GenerationProcess.test.ts), and [routing tests](../packages/core/test/Routing.test.ts).
- Run affected checks in `devenv`, then `devenv shell -- yarn check` and `devenv shell -- yarn build`. Run `devenv shell -- yarn generate:openresponses --check` when pinned generated wire types or Schemas change. Follow [testing.md](testing.md) and review changed code for the immutable functional conventions in [AGENTS.md](../AGENTS.md).

Success means each module asks callers to learn fewer representational special cases while preserving native protocol semantics.
