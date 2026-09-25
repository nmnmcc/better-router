import { Clock, Effect, HashMap, Option, Result, Stream } from "effect"
import type { ProviderError } from "./Deployment.js"
import type { ModelEvent, ModelRequest, ModelResponse, OutputItem } from "./Model.js"

export type NativeChunk =
  | { readonly type: "start"; readonly id: string; readonly createdAt: number; readonly model: string }
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "tool_start"; readonly id: string; readonly name: string }
  | { readonly type: "tool_delta"; readonly id: string; readonly value: string }
  | { readonly type: "finish"; readonly reason: "stop" | "tool_calls" | "length" | "content_filter"; readonly usage?: ModelResponse["usage"] }

const invalid = (message: string): ProviderError => ({ kind: "unknown", message, retryable: false })

export function snapshot(request: ModelRequest, id: string, createdAt: number, model: string, output: readonly OutputItem[],
  status: "in_progress" | "completed" | "incomplete", usage: ModelResponse["usage"], completedAt: number | null): ModelResponse {
  return {
    id, object: "response", created_at: createdAt, completed_at: completedAt,
    status, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
    model, previous_response_id: request.previous_response_id ?? null, instructions: request.instructions ?? null,
    output, error: null,
    tools: (request.tools ?? []).filter((tool) => tool.type === "function").map((tool) => ({
      ...tool, description: "description" in tool ? tool.description ?? null : null,
      parameters: "parameters" in tool ? tool.parameters ?? null : null, strict: "strict" in tool ? tool.strict ?? null : null,
    })) as ModelResponse["tools"],
    tool_choice: request.tool_choice ?? "auto", truncation: request.truncation ?? "disabled",
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    text: request.text?.format?.type === "json_schema"
      ? { format: { type: "json_schema", name: request.text.format.name ?? "output",
          description: request.text.format.description ?? null, schema: null, strict: request.text.format.strict ?? false },
        ...(request.text.verbosity ? { verbosity: request.text.verbosity } : {}) }
      : { format: { type: "text" }, ...(request.text?.verbosity ? { verbosity: request.text.verbosity } : {}) },
    top_p: request.top_p ?? 1, presence_penalty: request.presence_penalty ?? 0, frequency_penalty: request.frequency_penalty ?? 0,
    top_logprobs: request.top_logprobs ?? 0, temperature: request.temperature ?? 1, reasoning: request.reasoning ?? null,
    usage, max_output_tokens: request.max_output_tokens ?? null, max_tool_calls: request.max_tool_calls ?? null,
    store: request.store ?? false, background: false, service_tier: request.service_tier ?? "default",
    metadata: request.metadata ?? null, safety_identifier: request.safety_identifier ?? null,
    prompt_cache_key: request.prompt_cache_key ?? null,
  } as ModelResponse
}

type Identity = { readonly id: string; readonly createdAt: number; readonly model: string }
interface State {
  readonly identity: Option.Option<Identity>
  readonly sequence: number
  readonly finished: boolean
  readonly messageIndex: Option.Option<number>
  readonly output: readonly OutputItem[]
  readonly tools: HashMap.HashMap<string, number>
}
type UnnumberedEvent = { readonly type: string; readonly [key: string]: unknown }

const initial = (): State => ({
  identity: Option.none(), sequence: 0, finished: false, messageIndex: Option.none(),
  output: [], tools: HashMap.empty(),
})

const emit = (state: State, events: readonly UnnumberedEvent[]): readonly [State, readonly ModelEvent[]] => [
  { ...state, sequence: state.sequence + events.length },
  events.map((entry, index) => ({ ...entry, sequence_number: state.sequence + index }) as ModelEvent),
]

function transition(
  request: ModelRequest, state: State, chunk: NativeChunk | { readonly type: "end" }, completedAt: number | null,
): Result.Result<readonly [State, readonly ModelEvent[]], ProviderError> {
  if (chunk.type === "end") {
    return state.finished ? Result.succeed([state, []]) : Result.fail(invalid("Upstream ended without a terminal response"))
  }
  if (state.finished) return Result.fail(invalid("Events followed the terminal response"))
  if (chunk.type === "start") {
    if (Option.isSome(state.identity) || !chunk.id || !Number.isFinite(chunk.createdAt)) {
      return Result.fail(invalid("Invalid response identity"))
    }
    return Result.succeed(emit(
      { ...state, identity: Option.some({ id: chunk.id, createdAt: chunk.createdAt, model: chunk.model }) },
      [{ type: "response.created", response: snapshot(request, chunk.id, chunk.createdAt, chunk.model, [], "in_progress", null, null) }],
    ))
  }
  return Result.gen(function* () {
    const identity = yield* Result.fromOption(state.identity, () => invalid("Output before response identity"))
    if (chunk.type === "text") {
      const first = Option.isNone(state.messageIndex)
      const index = first ? state.output.length : state.messageIndex.value
      const item = first
        ? { type: "message" as const, id: `${identity.id}-message`, status: "in_progress" as const,
            role: "assistant" as const, content: [{ type: "output_text" as const, text: "", annotations: [] }] }
        : state.output[index]
      if (item.type !== "message" || item.content[0]?.type !== "output_text") {
        return yield* Result.fail(invalid("Invalid message state"))
      }
      const updated = { ...item, content: [{ ...item.content[0], text: item.content[0].text + chunk.value }] }
      const output = first ? [...state.output, updated] : state.output.map((current, position) => position === index ? updated : current)
      return emit(
        { ...state, messageIndex: Option.some(index), output: output as readonly OutputItem[] },
        [
          ...(first ? [
            { type: "response.output_item.added", output_index: index, item },
            { type: "response.content_part.added", item_id: item.id, output_index: index, content_index: 0, part: item.content[0] },
          ] : []),
          { type: "response.output_text.delta", item_id: item.id, output_index: index, content_index: 0, delta: chunk.value },
        ],
      )
    }
    if (chunk.type === "tool_start") {
      if (HashMap.has(state.tools, chunk.id) || !chunk.id || !chunk.name) {
        return yield* Result.fail(invalid("Duplicate or invalid tool call"))
      }
      const index = state.output.length
      const item = { type: "function_call" as const, id: `${identity.id}-call-${index}`, status: "in_progress" as const,
        call_id: chunk.id, name: chunk.name, arguments: "" }
      return emit(
        { ...state, output: [...state.output, item], tools: HashMap.set(state.tools, chunk.id, index) },
        [{ type: "response.output_item.added", output_index: index, item }],
      )
    }
    if (chunk.type === "tool_delta") {
      const index = yield* Result.fromOption(HashMap.get(state.tools, chunk.id), () => invalid("Tool arguments before tool call"))
      const item = state.output[index]
      if (item.type !== "function_call") return yield* Result.fail(invalid("Invalid tool state"))
      return emit(
        { ...state, output: state.output.map((current, position) =>
          position === index ? { ...item, arguments: item.arguments + chunk.value } : current) },
        [{ type: "response.function_call_arguments.delta", item_id: item.id, output_index: index, delta: chunk.value }],
      )
    }
    const status = chunk.reason === "length" || chunk.reason === "content_filter" ? "incomplete" : "completed"
    const output = state.output.map((item) => ({ ...item, status })) as readonly OutputItem[]
    const items = state.output.flatMap((item, index): readonly UnnumberedEvent[] => [
      ...(item.type === "message" && item.content[0]?.type === "output_text" ? [
        { type: "response.output_text.done", item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text },
        { type: "response.content_part.done", item_id: item.id, output_index: index, content_index: 0, part: item.content[0] },
      ] : []),
      ...(item.type === "function_call" ? [
        { type: "response.function_call_arguments.done", item_id: item.id, output_index: index, arguments: item.arguments },
      ] : []),
      { type: "response.output_item.done", output_index: index, item: output[index] },
    ])
    const response = snapshot(request, identity.id, identity.createdAt, identity.model, output, status, chunk.usage ?? null, completedAt)
    const terminal = status === "incomplete" && chunk.reason === "content_filter"
      ? { ...response, incomplete_details: { reason: "content_filter" } }
      : response
    return emit({ ...state, output, finished: true }, [
      ...items, { type: `response.${status}`, response: terminal },
    ])
  })
}

/** Assemble provider-native deltas with subscription-local, immutable state. */
export function fromNative(request: ModelRequest, source: Stream.Stream<NativeChunk, ProviderError>): Stream.Stream<ModelEvent, ProviderError> {
  return Stream.concat(source, Stream.succeed({ type: "end" as const })).pipe(
    Stream.mapAccumEffect(initial, (state, chunk) => Effect.gen(function* () {
      const completedAt = chunk.type === "finish" ? Math.floor((yield* Clock.currentTimeMillis) / 1000) : null
      return yield* Effect.fromResult(transition(request, state, chunk, completedAt))
    })),
  )
}
