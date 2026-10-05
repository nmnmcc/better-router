# Data normalization instead of helper proliferation

Investigated 2026-09-26; package and plugin contract notes updated 2026-10-05. Scope includes repository-owned Generation models, protocol conversions, provider streams, HTTP projections, plugin declarations, and tests. Evidence comes from source, checked-in tests, and focused in-memory characterization. No real provider requests or performance measurements were made.

The implementation method is in [data-normalization-methodology.md](data-normalization-methodology.md). Historical observations below are distinct from current source and proposed changes.

## Conclusion

Schema-decoded, immutable operation-local shapes can simplify consumers that repeatedly handle string/array alternatives, optional fields, and untyped wire records. The method applies to protocol conversion and provider stream state. It does not justify replacing the Generation ABI with a text-only common denominator, forcing all protocols through one reducer, or deleting small functions that own native semantic rules.

Current ownership makes the relevant boundaries explicit:

| Boundary               | Owned representation                                                 | Source                                                                                                                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core semantic contract | Protocol-neutral request, response, and events                       | [Generation](../packages/core/src/Generation.ts), [GenerationSchema](../packages/core/src/GenerationSchema.ts)                                                                                                                      |
| Protocol projection    | Wire Schema and pure request/response/event conversion               | [Chat Convert](../packages/protocol-openai-chat-completions/src/Convert.ts), [Anthropic Convert](../packages/protocol-anthropic-messages/src/Convert.ts), [Responses Convert](../packages/protocol-openai-responses/src/Convert.ts) |
| Provider execution     | Deployment URL, credentials, native request/event conversion         | [OpenAI Chat](../packages/provider-openai/src/OpenAIChatCompletions.ts), [Anthropic Messages](../packages/provider-anthropic/src/AnthropicMessages.ts)                                                                              |
| Generation process     | Independent subscription views, terminal fold, cancellation          | [GenerationProcess](../packages/core/src/GenerationProcess.ts)                                                                                                                                                                      |
| Plugin composition     | Static capability/config declarations and scoped runtime acquisition | [Plugin](../packages/core/src/Plugin.ts), [Registry](../packages/core/src/Registry.ts), [Router](../packages/core/src/Router.ts)                                                                                                    |

OpenResponses is an external projection with a pinned wire Schema, not the core implementation dependency. Protocol packages do not require pairwise conversions between one another. A canonical semantic ABI can still have several private computational representations.

## Outgoing request construction

The original investigation found wire-shaped records being accumulated before sending requests: Chat recovered a previous record's role and tool calls; Anthropic recovered block arrays from string-or-array message content. Target-specific tagged drafts can establish those facts once, leaving a final encoder to choose native string/array/null form.

The preservation rule is more important than the helper names. Chat assistant/tool messages and Anthropic tool-use/tool-result blocks have different grouping semantics. Function arguments remain strings in the canonical request, but Anthropic must decode them as a JSON object. Image URL/data-URI content and Anthropic URL/base64 source records also differ. Deployment defaults such as a required token limit remain provider-specific.

Current conversion and execution code is in [OpenAIChatCompletions](../packages/provider-openai/src/OpenAIChatCompletions.ts) and [AnthropicMessages](../packages/provider-anthropic/src/AnthropicMessages.ts). Their [provider tests](../packages/provider-openai/test/OpenAIChatCompletions.test.ts) cross the HTTP boundary with a fake client. The older pilot's exact draft types and helper names are historical implementation details; they are not current public exports.

If two outgoing adapters still repeat substantial representation handling, derive a private source-aware request view from an already-decoded Generation request. Required ordered item/part arrays may remove repeated shape checks, but retain original paths and forms. An error for shorthand input must remain at `input`, not at a manufactured array index. Distinguish omission, null, empty arrays, false, and zero wherever they change target output or a support check. Do not add provider defaults to a shared view.

## Native ingress and issue paths

Protocol `Convert.decodeRequest` establishes the native wire boundary; the HTTP handler should consume that result instead of decoding the body again to recover a transport option. A separate Generation Schema decode proves a different boundary and is not duplicate parsing of the wire contract.

Known supported variants should expose their required fields after decoding. Unknown-but-valid semantics must remain visible until a capability projection preserves or explicitly rejects them. Do not make every unknown property a structural failure merely to eliminate a semantic check. Preserve [ConversionError](../packages/core/src/Convert.ts) reason and nested source path, including image sources, tools, continuation, and protocol-specific stream options.

Current regression entrypoints are [Chat Convert tests](../packages/protocol-openai-chat-completions/test/Convert.test.ts), [Anthropic Convert tests](../packages/protocol-anthropic-messages/test/Convert.test.ts), [Responses HTTP tests](../packages/protocol-openai-responses/test/Http.test.ts), and [Capability Schema tests](../packages/core/test/Capability.test.ts).

## Native stream identity

The 2026-09-26 synthetic probe passed `start -> text("A") -> tool_start("lookup") -> tool_delta("{}") -> text("B") -> finish("tool_calls")` through the earlier shared assembler. Anonymous native text and a single message index produced one message containing `AB`, followed by a function call. A fake Anthropic SSE round trip reproduced the same separation/order limitation:

```text
Native blocks:      [text("A"), tool_use("lookup", {}), text("B")]
Projected content:  [text("AB"), tool_use("lookup", {})]
```

This was an in-memory adapter-chain observation, not a live-provider failure. Current native vocabularies and subscription-local transitions are in [OpenAI GenerationAssembler](../packages/provider-openai/src/GenerationAssembler.ts) and [Anthropic GenerationAssembler](../packages/provider-anthropic/src/GenerationAssembler.ts). They still use anonymous native text and one message index; the plugin API rewrite alone does not resolve that modeling limitation.

Before changing it, specify whether separate native text blocks become content parts or output items and preserve their order around function calls. Then add stable item/part identity and explicit lifecycle operations. Cover multiple blocks, interleaved tools, duplicate starts/stops, unfinished streams, incomplete/content-filter endings, late or missing usage, a second subscription, and cancellation. Full Responses events must keep their richer model rather than pass through this smaller native vocabulary; see [OpenResponses source notes](openresponses-research.md).

[GenerationProcess](../packages/core/src/GenerationProcess.ts) remains the shared process boundary. It folds exactly one terminal response and cancels subscription views. Retry/fallback can occur only before any semantic event is exposed; a partially observed stream must never be replayed to a different provider.

## Declaration and routing normalization

Configuration normalization belongs to a separate boundary. `Router.make` returns a pure `Result<Router.Router<Plugins>, SetupError>` containing a validated immutable Registry. `Router.runtime` or `Router.layer` then acquires externally supplied services, migrations, provider runtimes, and plugin `init` in a Scope. ID/reference checks happen before resource acquisition; `init` cannot append declarations. Dynamic npm/config loading and runtime registry updates are outside this release.

`Capability` records stable support without credentials or process state. `DeploymentConfig` records provider/model/protocol, credential reference, URL, pricing, limits, and tags. The shared [CredentialResolver](../packages/core/src/ProviderContract.ts) and provider runtime factories acquire deployment-specific clients. Health, active requests, latency, failure/cooldown, and usage belong to [RoutingRuntime](../packages/core/src/RoutingRuntime.ts) and optional [Persistence](../packages/core/src/Persistence.ts).

Resolve declaration-only IDs once during preflight. At invocation, `RoutingContext` retains raw/structured request, eligible deployments, metadata, signals, and runtime metrics. Static filters and asynchronous policy/pipeline results must remain ordered subsets of eligible candidates; an empty set is a typed failure. Resolve returned IDs back to canonical deployments rather than accepting replacement runtime objects. Dynamic health and budget decisions stay per request.

This combines LiteLLM's deployment/routing distinction with Yielded Auth's static contributions, typed Layer requirements, and scoped acquisition. A remote ranking service such as Jev still needs its own explicitly injected client, Schema, timeout, and failure policy; it is not built into the router.

## Semantic losses to reject

- Preserve ordered items, tool IDs/results, multimodal parts, reasoning, continuation, extensions, and full response/event snapshots instead of reducing them to text messages.
- Preserve or explicitly reject phase, annotations, strict/built-in tools, and namespaced extensions. Field omission does not prove capability support.
- Keep Chat and Anthropic instruction, image, argument, and tool-choice rules distinct; the selected provider must reject semantics it cannot represent.
- Preserve unavailable usage as absence/null. Do not fabricate a universal token count to satisfy a projection.
- Keep each provider's finish reason, terminal marker, status/retryability, and native error envelope explicit.
- Keep Layers, credentials, health, caches, and budget counters out of Capability and request drafts.

## Proportional verification

1. Characterize pure conversions with shorthand/string/parts/empty input, tool-only and adjacent call/result items, instruction sources, absent/null/false/zero settings, unknown variants, nested paths, and unchanged input.
2. Use a fake `HttpClient` for deployment URL, headers/body, native SSE, usage, terminal event, typed status failures, and cancellation. Verify multiple deployments of one provider coexist independently.
3. Test candidate filters, built-in strategies, policy subset/empty results, health cooldown, pre-event fallback, and refusal to replay after output.
4. Test pure Registry preflight, Layer service requirements, migrations/init ordering, failed startup cleanup, Scope finalizers, and interruption.
5. Test protocol HTTP authentication before upstream invocation, JSON/SSE, native error mapping, success-only terminal markers, post-header failure, and cancellation.
6. Follow [testing.md](testing.md): run affected tests in `devenv`, then `devenv shell -- yarn check` and `devenv shell -- yarn build`. Check pinned generation with `devenv shell -- yarn generate:openresponses --check` when generated wire types or Schemas change.

Success is reduced caller knowledge and preserved observable behavior, not fewer lines or a new type alongside all the old branches. The historical normalization pilot's test counts and deleted file paths do not describe the current plugin acceptance suite. No allocation, throughput, or latency improvement is claimed.
