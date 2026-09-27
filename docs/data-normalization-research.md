# Data normalization instead of helper proliferation

Investigated 2026-09-26. Scope: repository-owned models, protocol conversions, streaming state, HTTP projections, and their tests. Evidence comes from source, checked-in tests, and focused in-memory characterization; no real provider requests or performance measurements were made. This is a design investigation, not an implementation or an assertion that every opportunity is a bug.

The implementation procedure derived from this inventory is in [data-normalization-methodology.md](data-normalization-methodology.md).

Implementation status as of 2026-09-27: typed outgoing drafts are now used by both Chat Completions and Anthropic Messages; Chat ingress decodes once into a canonical request plus transport facts; and Responses ingress collects item, part, and image facts in one immutable traversal while retaining the previous error precedence. The public OpenResponses model, provider envelopes, and native stream identity semantics remain unchanged.

## Conclusion

The hypothesis fits this repository when many branches exist because a consumer repeatedly handles several representations of the same value. A schema-decoded, immutable operation-local data shape can make the consumer simpler than adding more helpers for each optional field, string-or-array case, and record lookup. The first implementation application is typed request-building state inside the Chat and Anthropic outgoing adapters, followed by parse-once ingress facts in Chat and Responses. A shared normalized request view remains conditional: the current slices remove shape repair without changing the public model or forcing provider-specific rules into a common module.

It does not justify replacing the public OpenResponses model with a smaller common denominator, forcing all protocols through one generic reducer, or deleting small functions that own real protocol rules. The router already uses canonical data and centralized transitions successfully; the remaining work is selective deepening of existing modules.

## Existing normalization worth preserving

1. **One semantic protocol across the router.** `ModelRequest`, `ModelResponse`, and `ModelEvent` derive from the pinned OpenResponses document; runtime Schemas use the same document and add namespaced extension alternatives. Protocol packages do not depend on each other. This prevents pairwise protocol conversion implementations. Sources: [Model.ts](../packages/core/src/Model.ts#L34), [ModelSchema.ts](../packages/core/src/ModelSchema.ts#L35), [architecture](architecture.md#L7).
2. **Native deltas already have a shared shape.** Chat and Anthropic decode their SSE streams, emit `NativeChunk`, and call `ModelEvents.fromNative`. That module owns canonical event numbering, ordered output accumulation, terminal snapshots, and subscription-local initial state. This is an existing example of processing normalized data through one implementation, not a reason to invent another event abstraction immediately. Sources: [NativeChunk](../packages/core/src/ModelEvents.ts#L5), [fromNative](../packages/core/src/ModelEvents.ts#L138), [Chat executor](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L390), [Anthropic executor](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L395).
3. **Normalized output state can already simplify a projection.** Chat HTTP's `Output` stores `content`, `refusal`, and `tool_calls` consistently while `projectOutput` folds the canonical response. Optional native wire fields are emitted afterward. Sources: [Output and projectOutput](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsHttp.ts#L46), [wire projection](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsHttp.ts#L103).
4. **Declarations are compiled at router acquisition.** Plugin declarations become immutable deployment/policy/route registries before serving requests; setup invariants are checked there. This is already a successful change from declaration-shaped data to execution-shaped data. Sources: [Registry](../packages/core/src/Router.ts#L51), [registration](../packages/core/src/Router.ts#L75), [acquisition](../packages/core/src/Router.ts#L171).
5. **Generation uses one normalized source document.** The generator normalizes the pinned OpenAPI document before feeding it to TypeScript generation and writing the runtime Schema artifact. Its small pure `stripDiscriminators` function helps establish that common shape; normalization and small functions are complementary here. Sources: [document normalization](../scripts/generate-openresponses.mjs#L59), [generation](../scripts/generate-openresponses.mjs#L74), [runtime artifact](../scripts/generate-openresponses.mjs#L86), [stripDiscriminators](../scripts/generate-openresponses.mjs#L19).

OpenResponses is canonical _semantics_, not necessarily one computational representation. For example, the public request still intentionally supports `input` as string, items, null, or absence, and nullable/optional tools. Sources: [ModelRequest](../packages/core/src/Model.ts#L38), [canonical-model source notes](openresponses-research.md#L13).

## Ranked opportunities

| Rank | Opportunity                                                       | Expected return                                                            | Scope and risk                                                                      |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | Typed, normalized outgoing message drafts                         | Remove repeated wire-shape tests and casts at their source                 | Local to Chat/Anthropic outgoing conversion; comparatively small blast radius       |
| 2    | Operation-local request view with ordered item/part arrays        | Remove repeated string/array and absence handling across outgoing adapters | Shared conversion behavior; preserve full wire semantics and provenance             |
| 3    | Parse-once ingress result and discriminated supported variants    | Replace optional-field proof helpers with schema-derived guarantees        | Native parsing/error classification can change; explicit compatibility tests needed |
| 4    | Identity-preserving native stream operations                      | Avoid losing block/item lifecycle in an overly small canonical delta shape | Core and multiple adapters; characterization before any redesign                    |
| 5    | Normalized HTTP error facts, and acquisition-time resolved routes | Concentrate repeated mechanical policy, not provider semantics             | Lower priority; no demonstrated performance problem                                 |

These rankings are design proposals and suggested incremental implementation order, not correctness severity. The reproduced multi-block identity/order limitation deserves characterization coverage first even though redesigning a shared stream shape has a wider blast radius. The observations supporting each proposal are established below.

### 1. Normalize outgoing construction state before emitting native JSON

**Confirmed observations.** Chat builds `readonly Record<string, unknown>[]`, then inspects the last record's role and tests `Array.isArray(last.tool_calls)` to append a function call. Anthropic's local `Message` retains `content: string | Record[]`; `append` converts an existing string back into text blocks whenever a tool block joins that message. The state is still shaped like flexible wire JSON even though the reducer has already chosen its meaning. Sources: [Chat accumulator](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L99), [Chat call append](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L136), [Anthropic Message and append](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L53).

**Proposed shape.** Use target-specific schema-derived or deeply readonly tagged drafts:

- Chat assistant draft: a known assistant role, ordered content parts, and a required readonly function-call array. Other roles have their own variants; tool-result drafts carry their call ID.
- Anthropic message draft: a known user/assistant role and a required readonly block array. System instructions remain distinct from message blocks.
- Retain original content form when output compatibility requires it, then emit the exact native string/array/null representation in one final projection. Existing upstream tests assert simple user content as a string, so changing all native content to arrays is not a behavior-free refactor. Sources: [Chat expected request](../packages/plugin-openai-chat-completions/test/OpenAIChatCompletionsUpstream.test.ts#L63), [Anthropic expected request](../packages/plugin-anthropic-messages/test/AnthropicMessagesUpstream.test.ts#L58).

**What would disappear.** The Chat accumulator would no longer need to recover `tool_calls` from an unknown record. Anthropic tool append would no longer need to recover blocks from string-or-array content. An immutable reducer would append to known arrays; one final encoder would decide wire representation.

**What would remain.** The adapter's grouping rules stay local: Chat attaches calls to an adjacent assistant message; Anthropic represents tool use in assistant blocks and tool results in user blocks. These are not the same operation just because both append arrays. Sources: [Chat grouping](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L140), [Anthropic tool use](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L111), [Anthropic tool result](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L136).

### 2. Derive a request view for outgoing conversion, not a new public wire model

**Confirmed observations.** Both outgoing adapters independently expand string `input` into a user message and map absent/null `input` to an empty item array. Both then branch on string versus part-array message content and function output, and convert text parts inside nested `Result` reducers. Sources: [Chat input and content](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L98), [Chat function output](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L142), [Anthropic input and content](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L71), [Anthropic function output](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L116).

**Proposed shape.** Derive an immutable computational view once per outgoing conversion from an already-decoded `ModelRequest`:

- `items`: a required ordered item array, with synthetic user-message expansion for string input.
- Message and function-result content: required ordered typed part arrays, with string expansion into role-correct text parts.
- `origin`: an original source path and representation tag for each expanded value, so an error for shorthand input remains an error at `input`, not a fictitious `input[0].content[0]` wire field.
- Optional settings: `Option` where absence is semantically sufficient; a tagged presence value (`absent`, `null`, `value`) or reference to the original decoded request where null/omission/empty distinctions affect support checks, encoding, or round trips.
- Unsupported standard and extension variants: preserved as variants or rejected explicitly by the chosen adapter's capability projection. Never remove them by filtering.

The view should not add provider defaults. For example, Anthropic's required maximum is deployment-specific, whereas Chat omits its maximum when none was supplied. Sources: [Anthropic maximum](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L69), [Chat optional maximum](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L203).

Content representation is observable in existing support checks: Anthropic accepts a system message only when its content is a string. Expanding every string into arrays and passing that new shape to the unchanged converter would reject previously supported requests. Preserve the source-form tag and make the support decision on that form, or deliberately revise and test the contract. Likewise, retain whether tools were omitted, null, or an explicitly empty array before deciding whether to emit a native `tools` field. Sources: [Anthropic system rule](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L81), [Chat tools field presence](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L185), [Anthropic tools field presence](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L166).

**Important distinction.** Structural normalization and target portability are separate decisions. Expand representational alternatives without converting function argument strings into a universal JSON object, dropping annotations, conflating developer/system instructions, or accepting unsupported details. The native Responses executor must retain the full request and event model; it already forwards decoded request fields rather than lowering them to Chat-like data. Sources: [Responses executor](../packages/plugin-openai-responses/src/OpenAIResponses.ts#L120), [Responses forwarding](../packages/plugin-openai-responses/src/OpenAIResponses.ts#L127).

**Implementation decision.** Start with rank 1. Extract a shared request view only if it removes substantial branching in both outgoing adapters. Keep it in an existing conversion/model ownership area or an appropriate flat PascalCase module; do not add an `internal/` layer or change the `Router` interface merely to share array expansion. Repository conventions: [AGENTS.md](../AGENTS.md#L7).

### 3. Parse once into meaningful ingress variants plus transport options

**Confirmed observations.** Chat's parts, messages, and function payloads use `type: Schema.String` plus optional fields. Anthropic's content and image sources do the same. Projection then repeatedly calls `only`, `required`, `requireThat`, and uses assertions after these checks. This makes decoded data structurally typed but not yet a sufficiently precise supported-domain variant. Sources: [Chat raw parts/calls/messages](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletions.ts#L11), [Chat checks](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletions.ts#L125), [Chat function checks](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletions.ts#L174), [Anthropic raw content](../packages/plugin-anthropic-messages/src/AnthropicMessagesHttp.ts#L36), [Anthropic checks](../packages/plugin-anthropic-messages/src/AnthropicMessagesHttp.ts#L94).

The Chat HTTP handler also decodes the same raw body twice: first through `decodeRequest` to read `stream_options.include_usage`, then through `toResponseRequest`, which calls `decodeRequest` again. Sources: [Chat handler](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsHttp.ts#L243), [toResponseRequest](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletions.ts#L195).

**Proposed shape.** A parse result can expose `{ request: ModelRequest, ingress: { stream, includeUsage } }` to the HTTP handler while retaining the existing pure converter's public behavior. Internally, known supported native variants should have literal discriminants and required fields, e.g. text with a required string, URL image with a required URL, base64 image with required MIME/data, and function call with required ID/name/arguments. Projection receives complete variants rather than reconstructing those guarantees with helper calls.

**Guardrail.** Do not achieve this by silently stripping extra properties or by treating all unknown variants as malformed. Current behavior distinguishes structurally invalid data from valid but unsupported semantics and preserves nested paths, including unsupported `cache_control` and audio/custom tools. Keep an explicit unsupported-variant representation or a structured schema-backed semantic rejection stage. Sources: [Anthropic structural versus semantic errors](../packages/plugin-anthropic-messages/test/AnthropicMessages.test.ts#L45), [Chat unsupported cases](../packages/plugin-openai-chat-completions/test/OpenAIChatCompletions.test.ts#L149), [Chat malformed cases](../packages/plugin-openai-chat-completions/test/OpenAIChatCompletions.test.ts#L177), [ConversionError](../packages/core/src/Conversion.ts#L4).

This stage must preserve Chat's rule that `stream_options` requires streaming, the ingress-only `include_usage` behavior, and `include_obfuscation` mapping. They are not all interchangeable router options. Sources: [stream-options check/use](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsHttp.ts#L247), [IR stream-options projection](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletions.ts#L273).

### 4. Ensure the normalized native stream shape carries enough identity

**Confirmed observations.** `NativeChunk.text` carries only a string. Core accumulation tracks one `messageIndex` and always appends subsequent text to that message. Anthropic tracks native block indices in its own state, but emits unidentified text and removes a closed block without emitting a shared close operation. Sources: [NativeChunk](../packages/core/src/ModelEvents.ts#L5), [single messageIndex](../packages/core/src/ModelEvents.ts#L53), [text accumulation](../packages/core/src/ModelEvents.ts#L87), [Anthropic text start/delta](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L284), [Anthropic block close](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L313).

**Confirmed characterization.** A read-only execution of the built `fromNative` with `start -> text("A") -> tool_start("lookup") -> tool_delta("{}") -> text("B") -> finish("tool_calls")` emitted both text deltas with `output_index: 0` and a final output of `[message("AB"), function_call("lookup")]`. A second read-only probe used an in-memory fake `HttpClient` returning native Anthropic SSE through `deployment.execute.http`, `fromNative`, and `toMessage`:

```text
Native blocks:       [text("A"), tool_use("lookup", {}), text("B")]
Projected content:   [text("AB"), tool_use("lookup", {})]
```

This reproduces an adapter-chain ordering/separation limitation, not a live-provider failure. The common shape cannot communicate whether the second text belongs to a distinct native block/item or retain its position after the tool block. The relevant implementations are [Anthropic text/block translation](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L284), [canonical text accumulation](../packages/core/src/ModelEvents.ts#L87), and [Anthropic terminal output projection](../packages/plugin-anthropic-messages/src/AnthropicMessagesHttp.ts#L264).

**Proposed direction once the preservation policy is specified.** Enrich the native operation shape with stable item/part identifiers, explicit starts/stops, and type-specific deltas, then keep one immutable canonical assembler indexed by identity. Decide explicitly whether multiple native text blocks become separate content parts or separate output messages; preserve order relative to function calls. This is a semantic model change, not a helper extraction.

Native Responses should continue to use full canonical events directly, not be compressed through `NativeChunk`. Otherwise reasoning, refusals, annotations, multiple content parts, extensions, and terminal resources would be lost. Sources: [Responses event decode](../packages/plugin-openai-responses/src/OpenAIResponses.ts#L57), [canonical stream-model notes](openresponses-research.md#L20).

**Coverage gap.** The checked Chat upstream fixture uses one text stream; the Anthropic fixture uses one text block; the matrix upstream responses use either one text item/block or one function call. Core's resubscription test uses one text chunk. These establish existing basics but do not settle multi-block/interleaved normalization policy. Sources: [Chat upstream fixture](../packages/plugin-openai-chat-completions/test/OpenAIChatCompletionsUpstream.test.ts#L19), [Anthropic upstream fixture](../packages/plugin-anthropic-messages/test/AnthropicMessagesUpstream.test.ts#L18), [matrix fixture](../examples/matrix/shared/test/Matrix.integration.ts#L18), [resubscription test](../packages/core/test/ModelSchema.test.ts#L89).

### 5. Lower-priority normalization of error facts and resolved routes

**HTTP error facts.** All three ingress adapters independently match `RouterError` and map similar provider failure kinds to status codes. A structured result such as `{ status, category, safeMessage }` could centralize shared selection while each adapter keeps its native envelope and names. Sources: [Chat error handling](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsHttp.ts#L225), [Anthropic error handling](../packages/plugin-anthropic-messages/src/AnthropicMessagesHttp.ts#L429), [Responses error handling](../packages/plugin-openai-responses/src/OpenAIResponsesHttp.ts#L102).

This is worthwhile only if it replaces shared policy, not merely adds a generic status helper. Provider retryability is not universally identical: Anthropic handles 529 explicitly, Chat marks 5xx retryable, and Responses currently does not mark all 5xx retryable. Do not homogenize those facts during an unrelated normalization change. Sources: [Anthropic statusError](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L364), [Chat statusError](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L371), [Responses statusError](../packages/plugin-openai-responses/src/OpenAIResponses.ts#L49).

**Resolved routes.** Acquisition already verifies route IDs, but invocation resolves deployment IDs and an optional policy again. A private execution-shaped route containing ordered deployment references and an `Option` policy could move configuration-only resolution to acquisition. Keep required/preferred transport filtering and dynamic policy ranking per invocation. Resolve each policy-returned ID back to the canonical configured deployment rather than trusting the policy-returned object; current `attempt` already does this. No latency benefit was measured, so this is a locality/invariant proposal, not a performance claim. Sources: [route validation](../packages/core/src/Router.ts#L156), [invocation resolution](../packages/core/src/Router.ts#L192), [dynamic ranking](../packages/core/src/Router.ts#L198), [canonical attempt resolution](../packages/core/src/Router.ts#L217).

## Semantic losses and over-generalizations to reject

- **Do not replace `ModelRequest` with a minimal messages/text model.** Ordered items, tool IDs/results, multimodal parts, continuation, extension payloads, and full response/event snapshots are part of the canonical contract. Sources: [Model.ts](../packages/core/src/Model.ts#L14), [source notes](openresponses-research.md#L13).
- **Do not normalize away unsupported data.** A common view must retain or explicitly reject phase, nonempty annotations, reasoning, strict tools, built-in tools, and namespaced extensions; field omission is not capability support. Existing tests cover some of these rejections. Sources: [Chat phase/annotations test](../packages/plugin-openai-chat-completions/test/OpenAIChatCompletions.test.ts#L196), [Anthropic strict/phase/annotations test](../packages/plugin-anthropic-messages/test/AnthropicMessages.test.ts#L73), [Responses extension rejection](../packages/plugin-openai-responses/test/OpenAIResponses.test.ts#L23).
- **Do not merge distinct instruction rules.** Chat accepts system/developer messages; Anthropic rejects developer and multiple system instruction sources. A shared normalization may expose these variants, but must not convert them to one accepted instruction field. Sources: [Chat role handling](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L104), [Anthropic instruction handling](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L77).
- **Do not force one image or argument representation on all targets.** Chat uses URL/data-URI images and string function arguments; Anthropic uses URL/base64 source records and JSON-object tool input. Anthropic also rejects non-auto image detail and explicitly specified function-tool strictness. These are provider rules, not accidental duplication. Sources: [Chat image and calls](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L124), [Anthropic images](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L45), [Anthropic argument decode](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L111), [Anthropic strictness](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L142).
- **Do not default unavailable usage to a fabricated universal value.** Chat output can omit usage, while Anthropic JSON projection explicitly requires it. Preserve null/absence in canonical resources and reject an impossible target projection. Sources: [Chat optional usage](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsHttp.ts#L109), [Anthropic required usage](../packages/plugin-anthropic-messages/src/AnthropicMessagesHttp.ts#L263), [usage source notes](openresponses-research.md#L15).
- **Do not unify terminal transport semantics prematurely.** Chat waits for `[DONE]` after a finish reason; Anthropic waits for `message_stop`, with no open blocks; native Responses consumes full terminal events. Their HTTP success terminators and native error envelopes differ. Sources: [Chat termination](../packages/plugin-openai-chat-completions/src/OpenAIChatCompletionsUpstream.ts#L303), [Anthropic termination](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L325), [Responses termination](../packages/plugin-openai-responses/src/OpenAIResponses.ts#L67).
- **Do not confuse small functions with shallow modules.** Functions such as `fromSchema`, image conversion, `snapshot`, and a pure transition own specific invariants or protocol representations. Keep them when their deletion would scatter that knowledge across callers. Sources: [schema issue paths](../packages/core/src/Conversion.ts#L13), [snapshot](../packages/core/src/ModelEvents.ts#L9), [Anthropic image conversion](../packages/plugin-anthropic-messages/src/AnthropicMessages.ts#L45).

## Proportional rollout and verification

1. Characterize existing wire behavior before changing shape: shorthand input, string/array/empty content, absent/null/false/zero settings, tool-only assistant messages, instruction sources, and unsupported variants. Compare input before and after pure conversion. Extend existing [Chat conversion tests](../packages/plugin-openai-chat-completions/test/OpenAIChatCompletions.test.ts#L30) and [Anthropic conversion tests](../packages/plugin-anthropic-messages/test/AnthropicMessages.test.ts#L23).
2. Introduce target-specific drafts inside one outgoing adapter, preserving native JSON through a final projection; then repeat in the other adapter. Evaluate whether branches actually disappeared before extracting a shared request view. Avoid an extra adapter/helper layer around unchanged wire-shaped state.
3. If extracting a shared view or changing ingress Schemas, cover decoding and encoding, exact nested field paths, unsupported versus invalid classification, source-path provenance, deeply readonly type contracts, and preservation of unknown semantic variants until explicit rejection. Existing [pinned Schema round trips](../packages/core/test/ModelSchema.test.ts#L13), [extension round trips](../packages/core/test/ModelSchema.test.ts#L33), and [nested parse path](../packages/core/test/ModelSchema.test.ts#L56) are the starting contract.
4. Before changing native streaming, add characterization cases for multiple text blocks/parts, text-tool-text ordering, parallel tool indices, invalid lifecycle transitions, incomplete/content-filter endings, late usage, and missing usage. Consume the same source twice and test interrupted suspended streams. Existing [resubscription coverage](../packages/core/test/ModelSchema.test.ts#L89), [router interruption coverage](../packages/core/test/Router.test.ts#L243), and [matrix malformed/truncated/cancellation coverage](../examples/matrix/shared/test/Matrix.integration.ts#L381) must remain intact.
5. Run affected runtime/type tests, then `devenv shell -- yarn check` and `devenv shell -- yarn build`. Run `devenv shell -- yarn generate:openresponses --check` when pinned schemas/types are involved. Update architecture documentation if a router/plugin contract or the semantic stream shape changes. All implementation must use immutable reducers, `Result` for fallible pure conversion, `Option` for internal absence, and `Effect`/`Stream` at I/O/resource/concurrency interfaces. Sources: [testing policy](testing.md#L7), [verification commands](testing.md#L24), [repository conventions](../AGENTS.md#L10).

Success should be judged by reduced caller knowledge, fewer representational branches/casts, preserved observable behavior, and tests at the same usable interface. A new normalized type that coexists with every old branch without replacing it does not establish an improvement.

## Reproduce the assembler observation

After building the current source with `devenv shell -- yarn build`, run this from the repository root. It uses a finite in-memory stream, not a provider:

```sh
devenv shell -- yarn node --input-type=module -e '
import { Effect, Stream } from "effect"
import { fromNative } from "./packages/core/dist/ModelEvents.mjs"
const source = Stream.fromIterable([
  { type: "start", id: "resp_probe", createdAt: 1234, model: "private" },
  { type: "text", value: "A" },
  { type: "tool_start", id: "call_probe", name: "lookup" },
  { type: "tool_delta", id: "call_probe", value: "{}" },
  { type: "text", value: "B" },
  { type: "finish", reason: "tool_calls" }
])
const events = await Effect.runPromise(Stream.runCollect(fromNative({ model: "private" }, source)))
console.log(JSON.stringify(events.at(-1).response.output, null, 2))
'
```

The terminal output contains one assistant message with text `AB`, followed by the `lookup` function call. There is no distinct text item after that call. The synthetic native Anthropic round-trip probe described in section 4 independently exercised the same behavior through native event decoding and outbound projection.

## Investigation limits

The initial investigation added these two documents and left production code unchanged. A follow-up pilot now changes only `toChatRequest` in `OpenAIChatCompletionsUpstream.ts`, its focused regression test, and this documentation. No generated files, public contracts, or external systems were changed.

The baseline investigation ran the focused command below, which builds all packages and passed 6 test files / 26 tests:

```sh
devenv shell -- yarn test:runtime packages/core/test/ModelSchema.test.ts packages/core/test/Router.test.ts packages/plugin-openai-chat-completions/test/OpenAIChatCompletions.test.ts packages/plugin-openai-chat-completions/test/OpenAIChatCompletionsUpstream.test.ts packages/plugin-anthropic-messages/test/AnthropicMessages.test.ts packages/plugin-anthropic-messages/test/AnthropicMessagesUpstream.test.ts
```

The two stream probes used `devenv shell -- yarn node --input-type=module -e ...` with synthetic chunks and an in-memory fake HTTP response; no test source was added. The multi-block ordering limitation is reproduced for this synthetic adapter chain, not for an actual provider response. No allocation, throughput, or latency benefit is claimed.

The pilot then ran the focused command below, which builds all packages and passed 2 test files / 9 tests:

```sh
devenv shell -- yarn test:runtime packages/plugin-openai-chat-completions/test/OpenAIChatCompletions.test.ts packages/plugin-openai-chat-completions/test/OpenAIChatCompletionsUpstream.test.ts
```

It also passed `devenv shell -- yarn build`, the fixed `devenv` Prettier check, and the full `devenv shell -- yarn check` gate (4 type-test files / 11 tests and 21 runtime test files / 48 tests). No allocation, throughput, or latency benefit is claimed.
