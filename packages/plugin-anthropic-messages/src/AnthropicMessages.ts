import { Clock, Effect, HashMap, Option, Redacted, Result, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import type { ModelDeployment, ModelExecutor, ProviderError } from "@better-router/core/Deployment"
import type { InputItem, ModelRequest } from "@better-router/core/Model"
import { fromNative } from "@better-router/core/ModelEvents"
import type { NativeChunk } from "@better-router/core/ModelEvents"
import { Request } from "@better-router/core/ModelSchema"
import { fromSchema } from "@better-router/core/Conversion"

export interface AnthropicMessagesDeploymentConfig {
  readonly id: string
  readonly model: string
  readonly apiKey: Redacted.Redacted<string>
  readonly url?: URL
  readonly defaultMaxTokens: number
  readonly version?: string
}

export const DeploymentConfig = Schema.Struct({
  id: Schema.String, model: Schema.String, apiKey: Schema.Redacted(Schema.String),
  url: Schema.optional(Schema.URL), defaultMaxTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(16)),
  version: Schema.optional(Schema.String),
})
export const DeploymentError = Schema.Struct({ message: Schema.String })
export type DeploymentError = typeof DeploymentError.Type

export interface AnthropicMessagesDeployment<Requirements = never> extends ModelDeployment<Requirements> {
  readonly provider: "anthropic"
  readonly protocol: "anthropic.messages"
  readonly execute: {
    readonly http: ModelExecutor<Requirements>
    readonly websocket?: never
  }
}

const fail = (kind: ProviderError["kind"], message: string, retryable = false, cause?: unknown): ProviderError =>
  ({ kind, message, retryable, ...(cause === undefined ? {} : { cause }) })
const isError = Schema.is(Schema.Struct({ kind: Schema.String, message: Schema.String, retryable: Schema.Boolean }))
const rejected = (field: string): ProviderError => fail("unsupported", `Cannot map ${field} to Anthropic Messages`)
const malformed = (field: string): ProviderError => fail("invalid_request", `Invalid ${field}`)

function image(url: string, path: string): Result.Result<Record<string, unknown>, ProviderError> {
  if (url.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(url)
    return match ? Result.succeed({ type: "image", source: { type: "base64", media_type: match[1], data: match[2] } })
      : Result.fail(malformed(path))
  }
  return /^https?:\/\/\S+$/.test(url) ? Result.succeed({ type: "image", source: { type: "url", url } }) : Result.fail(malformed(path))
}

type Message = { readonly role: "user" | "assistant"; readonly content: string | readonly Record<string, unknown>[] }
type State = { readonly system: Option.Option<string>; readonly messages: readonly Message[] }

const append = (messages: readonly Message[], role: Message["role"], block: Record<string, unknown>): readonly Message[] => {
  const last = messages.at(-1)
  const content = last?.role === role ? typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content : []
  return last?.role === role
    ? [...messages.slice(0, -1), { ...last, content: [...content, block] }]
    : [...messages, { role, content: [block] }]
}

/** Convert portable OpenResponses input into a stateless Anthropic Messages request. */
export function toMessagesRequest(request: ModelRequest, defaultMaxTokens: number): Result.Result<Record<string, unknown>, ProviderError> {
  return Result.gen(function* () {
  const allowed = [
    "model", "input", "instructions", "tools", "tool_choice", "text", "max_output_tokens", "temperature", "top_p",
    "parallel_tool_calls", "stream", "store",
  ] as const
  const extra = Object.entries(request).find(([key, value]) => value !== undefined && !allowed.includes(key as typeof allowed[number]))
  if (extra) return yield* Result.fail(rejected(extra[0]))
  if (request.store === true) return yield* Result.fail(rejected("store: true"))
  const max = request.max_output_tokens ?? defaultMaxTokens
  if (!Number.isInteger(max) || max < 16) return yield* Result.fail(malformed("max_output_tokens"))
  const input: readonly InputItem[] = typeof request.input === "string"
    ? [{ type: "message", role: "user", content: request.input }] : request.input ?? []
  const converted = yield* input.reduce<Result.Result<State, ProviderError>>((previous, item, index) => Result.gen(function* () {
    const state = yield* previous
    const path = `input[${index}]`
    if (item.type === "message" && "role" in item && "content" in item) {
      if (item.status && item.status !== "completed") return yield* Result.fail(rejected(`${path}.status`))
      if ("phase" in item && item.phase !== undefined) return yield* Result.fail(rejected(`${path}.phase`))
      if (item.role === "developer") return yield* Result.fail(rejected(`${path}.role`))
      if (item.role === "system") {
        if (Option.isSome(state.system)) return yield* Result.fail(rejected("multiple system instructions"))
        if (typeof item.content !== "string") return yield* Result.fail(rejected(`${path}.content`))
        return { ...state, system: Option.some(item.content) }
      }
      if (item.role !== "user" && item.role !== "assistant") return yield* Result.fail(rejected(`${path}.role`))
      if (typeof item.content !== "string" && !Array.isArray(item.content)) return yield* Result.fail(malformed(`${path}.content`))
      const content = typeof item.content === "string" ? item.content : yield* item.content.reduce<Result.Result<readonly Record<string, unknown>[], ProviderError>>((prior, part, partIndex) => Result.gen(function* () {
        const entries = yield* prior
        const field = `${path}.content[${partIndex}]`
        if (part.type === "input_text" || part.type === "output_text") {
          if (part.type === "output_text" && (part.annotations?.length ?? 0)) return yield* Result.fail(rejected(`${field}.annotations`))
          return [...entries, { type: "text", text: part.text }]
        }
        if (part.type === "input_image" && item.role === "user") {
          if (part.detail && part.detail !== "auto") return yield* Result.fail(rejected(`${field}.detail`))
          if (!part.image_url) return yield* Result.fail(malformed(`${field}.image_url`))
          return [...entries, yield* image(part.image_url, field)]
        }
        return yield* Result.fail(rejected(field))
      }), Result.succeed([]))
      return { ...state, messages: [...state.messages, { role: item.role, content }] }
    }
    if (item.type === "function_call" && "arguments" in item && "call_id" in item && "name" in item) {
      if (item.status && item.status !== "completed") return yield* Result.fail(rejected(`${path}.status`))
      const args = yield* Result.mapError(Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(item.arguments),
        () => malformed(`${path}.arguments`))
      return { ...state, messages: append(state.messages, "assistant", { type: "tool_use", id: item.call_id, name: item.name, input: args }) }
    }
    if (item.type === "function_call_output" && "output" in item && "call_id" in item) {
      if (item.status && item.status !== "completed") return yield* Result.fail(rejected(`${path}.status`))
      if (typeof item.output !== "string" && !Array.isArray(item.output)) return yield* Result.fail(malformed(`${path}.output`))
      const content = typeof item.output === "string" ? item.output : yield* item.output.reduce<Result.Result<readonly Record<string, unknown>[], ProviderError>>(
        (prior, part, partIndex) => Result.gen(function* () {
          const entries = yield* prior
          if (part.type === "input_text") return [...entries, { type: "text", text: part.text }]
          if (part.type === "input_image") {
            if (part.detail && part.detail !== "auto") return yield* Result.fail(rejected(`${path}.output[${partIndex}].detail`))
            if (!part.image_url) return yield* Result.fail(malformed(`${path}.output[${partIndex}].image_url`))
            return [...entries, yield* image(part.image_url, `${path}.output[${partIndex}]`)]
          }
          return yield* Result.fail(rejected(`${path}.output[${partIndex}]`))
        }), Result.succeed([]),
      )
      return { ...state, messages: append(state.messages, "user", { type: "tool_result", tool_use_id: item.call_id, content }) }
    }
    return yield* Result.fail(rejected(`${path}.type`))
  }), Result.succeed({ system: Option.fromNullishOr(request.instructions), messages: [] }))
  const tools = yield* (request.tools ?? []).reduce<Result.Result<readonly Record<string, unknown>[], ProviderError>>(
    (previous, tool, index) => Result.gen(function* () {
      const entries = yield* previous
      if (tool.type !== "function") return yield* Result.fail(rejected(`tools[${index}]`))
      if (tool.strict != null) return yield* Result.fail(rejected(`tools[${index}].strict`))
      return [...entries, { name: tool.name, description: tool.description ?? "", input_schema: tool.parameters ?? { type: "object" } }]
    }), Result.succeed([]),
  )
  const choice = request.tool_choice ?? "auto"
  if (typeof choice !== "string" && choice.type !== "function") return yield* Result.fail(rejected("tool_choice"))
  const format = request.text?.format
  if (request.text?.verbosity) return yield* Result.fail(rejected("text.verbosity"))
  if (format && format.type !== "text" && format.type !== "json_schema") return yield* Result.fail(rejected("text.format"))
  if (format?.type === "json_schema" && (format.description || format.strict === false)) {
    return yield* Result.fail(rejected("text.format.description/strict"))
  }
  return {
    model: request.model, max_tokens: max, messages: converted.messages, stream: true,
    ...Option.match(converted.system, { onNone: () => ({}), onSome: (system) => ({ system }) }),
    ...(request.tools ? { tools } : {}),
    ...(request.tool_choice || request.parallel_tool_calls === false ? { tool_choice: {
      ...(typeof choice === "string" ? { type: choice === "required" ? "any" : choice } : { type: "tool", name: choice.name }),
      ...(request.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {}),
    } } : {}),
    ...(format?.type === "json_schema" ? { output_config: { format: { type: "json_schema", schema: format.schema } } } : {}),
    ...(request.temperature == null ? {} : { temperature: request.temperature }),
    ...(request.top_p == null ? {} : { top_p: request.top_p }),
  }
  })
}

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const
const fields = <S extends Schema.StructWithRest.Objects>(schema: S) => Schema.StructWithRest(schema, rest)
const tokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const usage = fields(Schema.Struct({
  input_tokens: Schema.optional(tokenCount), output_tokens: Schema.optional(tokenCount),
  cache_creation_input_tokens: Schema.optional(tokenCount), cache_read_input_tokens: Schema.optional(tokenCount),
}))
const block = fields(Schema.Struct({
  type: Schema.String, text: Schema.optional(Schema.String), id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String), input: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
}))
const delta = fields(Schema.Struct({
  type: Schema.String, text: Schema.optional(Schema.String), partial_json: Schema.optional(Schema.String),
}))

export const AnthropicEvent = Schema.Union([
  fields(Schema.Struct({ type: Schema.Literal("ping") })),
  fields(Schema.Struct({ type: Schema.Literal("error"), error: fields(Schema.Struct({ type: Schema.String, message: Schema.String })) })),
  fields(Schema.Struct({ type: Schema.Literal("message_start"), message: fields(Schema.Struct({
    id: Schema.String, model: Schema.String, type: Schema.Literal("message"), role: Schema.Literal("assistant"),
    content: Schema.Array(block), usage,
    stop_reason: Schema.optional(Schema.Null), stop_sequence: Schema.optional(Schema.Null),
  })) })),
  fields(Schema.Struct({ type: Schema.Literal("content_block_start"), index: tokenCount, content_block: block })),
  fields(Schema.Struct({ type: Schema.Literal("content_block_delta"), index: tokenCount, delta })),
  fields(Schema.Struct({ type: Schema.Literal("content_block_stop"), index: tokenCount })),
  fields(Schema.Struct({ type: Schema.Literal("message_delta"), delta: fields(Schema.Struct({
    stop_reason: Schema.String, stop_sequence: Schema.optional(Schema.Null),
  })), usage: Schema.optional(usage) })),
  fields(Schema.Struct({ type: Schema.Literal("message_stop") })),
])

interface EventState {
  readonly started: boolean
  readonly finished: boolean
  readonly reason: Option.Option<"stop" | "tool_calls" | "length" | "content_filter">
  readonly inputTokens: number
  readonly cachedTokens: number
  readonly outputTokens: number
  readonly blocks: HashMap.HashMap<number, { readonly type: "text" } | { readonly type: "tool_use"; readonly id: string }>
}
const initial = (): EventState => ({ started: false, finished: false, reason: Option.none(), inputTokens: 0,
  cachedTokens: 0, outputTokens: 0, blocks: HashMap.empty() })
const eventError = (path: string, reason: "invalid" | "unsupported", message: string): ProviderError =>
  fail(reason === "invalid" ? "unknown" : "unsupported", `${path}: ${message}`)
const only = (value: object, path: string, allowed: readonly string[]): Result.Result<void, ProviderError> => {
  const extra = Object.keys(value).find((key) => !allowed.includes(key))
  return extra ? Result.fail(eventError(`${path}.${extra}`, "unsupported", "no portable mapping")) : Result.void
}
const required = <A>(value: A | undefined, path: string): Result.Result<A, ProviderError> =>
  value === undefined ? Result.fail(eventError(path, "invalid", "required")) : Result.succeed(value)

function transition(state: EventState, entry: { readonly kind: "end" } | { readonly kind: "frame"; readonly event: string | undefined;
  readonly data: string }, now: number): Result.Result<readonly [EventState, readonly NativeChunk[]], ProviderError> {
  return Result.gen(function* () {
    if (entry.kind === "end") return state.finished ? [state, []] as const
      : yield* Result.fail(fail("unknown", "Anthropic stream ended without message_stop"))
    const event = yield* Result.mapError(Schema.decodeUnknownResult(Schema.fromJsonString(AnthropicEvent))(entry.data),
      (error) => fail("unknown", fromSchema(error, "event").message, false, error))
    if (event.type !== entry.event) return yield* Result.fail(fail("unknown", "Anthropic SSE event mismatch"))
    if (state.finished) return yield* Result.fail(fail("unknown", "Events followed message_stop"))
    yield* only(event, "event", event.type === "message_start" ? ["type", "message"]
      : event.type === "content_block_start" ? ["type", "index", "content_block"]
        : event.type === "content_block_delta" ? ["type", "index", "delta"]
          : event.type === "content_block_stop" ? ["type", "index"]
            : event.type === "message_delta" ? ["type", "delta", "usage"]
              : event.type === "error" ? ["type", "error"] : ["type"])
    if (event.type === "ping") return [state, []] as const
    if (event.type === "error") return yield* Result.fail(fail("unavailable", event.error.message))
    if (event.type === "message_start") {
      if (state.started) return yield* Result.fail(fail("unknown", "Duplicate message_start"))
      yield* only(event.message, "event.message", ["id", "model", "type", "role", "content", "usage", "stop_reason", "stop_sequence"])
      yield* only(event.message.usage, "event.message.usage", ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"])
      if (event.message.content.length) return yield* Result.fail(eventError("event.message.content", "unsupported", "nonempty initial content"))
      const initialInput = event.message.usage.input_tokens ?? 0
      const cachedTokens = event.message.usage.cache_read_input_tokens ?? 0
      return [{ ...state, started: true, inputTokens: initialInput + (event.message.usage.cache_creation_input_tokens ?? 0) + cachedTokens,
        cachedTokens, outputTokens: event.message.usage.output_tokens ?? 0 },
      [{ type: "start", id: event.message.id, model: event.message.model, createdAt: now }]] as const
    }
    if (!state.started) return yield* Result.fail(fail("unknown", "Anthropic output before message_start"))
    if (event.type === "content_block_start") {
      if (HashMap.has(state.blocks, event.index)) return yield* Result.fail(eventError("event.index", "invalid", "duplicate block"))
      const value = event.content_block
      if (value.type === "text") {
        yield* only(value, "event.content_block", ["type", "text"])
        const text = yield* required(value.text, "event.content_block.text")
        return [{ ...state, blocks: HashMap.set(state.blocks, event.index, { type: "text" }) },
          [{ type: "text", value: text }]] as const
      }
      if (value.type === "tool_use") {
        yield* only(value, "event.content_block", ["type", "id", "name", "input"])
        const id = yield* required(value.id, "event.content_block.id")
        const name = yield* required(value.name, "event.content_block.name")
        const input = yield* required(value.input, "event.content_block.input")
        return [{ ...state, blocks: HashMap.set(state.blocks, event.index, { type: "tool_use", id }) }, [
          { type: "tool_start", id, name },
          ...(Object.keys(input).length ? [{ type: "tool_delta" as const, id, value: JSON.stringify(input) }] : []),
        ]] as const
      }
      return yield* Result.fail(eventError("event.content_block.type", "unsupported", "content block"))
    }
    if (event.type === "content_block_delta") {
      const active = yield* Result.fromOption(HashMap.get(state.blocks, event.index), () => eventError("event.index", "invalid", "block not open"))
      if (active.type === "text" && event.delta.type === "text_delta") {
        yield* only(event.delta, "event.delta", ["type", "text"])
        return [state, [{ type: "text", value: yield* required(event.delta.text, "event.delta.text") }]] as const
      }
      if (active.type === "tool_use" && event.delta.type === "input_json_delta") {
        yield* only(event.delta, "event.delta", ["type", "partial_json"])
        return [state, [{ type: "tool_delta", id: active.id, value: yield* required(event.delta.partial_json, "event.delta.partial_json") }]] as const
      }
      return yield* Result.fail(eventError("event.delta.type", "unsupported", "delta for active block"))
    }
    if (event.type === "content_block_stop") {
      if (!HashMap.has(state.blocks, event.index)) return yield* Result.fail(eventError("event.index", "invalid", "block not open"))
      return [{ ...state, blocks: HashMap.remove(state.blocks, event.index) }, []] as const
    }
    if (event.type === "message_delta") {
      if (Option.isSome(state.reason)) return yield* Result.fail(fail("unknown", "Duplicate Anthropic stop reason"))
      yield* only(event.delta, "event.delta", ["stop_reason", "stop_sequence"])
      if (event.usage) yield* only(event.usage, "event.usage", ["output_tokens"])
      const reason = event.delta.stop_reason === "end_turn" ? "stop" as const
        : event.delta.stop_reason === "tool_use" ? "tool_calls" as const
          : event.delta.stop_reason === "max_tokens" ? "length" as const
            : event.delta.stop_reason === "refusal" ? "content_filter" as const : undefined
      if (!reason) return yield* Result.fail(eventError("event.delta.stop_reason", "unsupported", "stop reason"))
      return [{ ...state, reason: Option.some(reason), outputTokens: event.usage?.output_tokens ?? state.outputTokens }, []] as const
    }
    const reason = yield* Result.fromOption(state.reason, () => fail("unknown", "Anthropic stream ended before content completed"))
    if (HashMap.size(state.blocks)) return yield* Result.fail(fail("unknown", "Anthropic stream ended with open content blocks"))
    const inputTokens = state.inputTokens
    const outputTokens = state.outputTokens
    return [{ ...state, finished: true }, [{ type: "finish", reason, usage: {
      input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens,
      input_tokens_details: { cached_tokens: state.cachedTokens }, output_tokens_details: { reasoning_tokens: 0 },
    } }]] as const
  })
}

function events(bytes: Stream.Stream<Uint8Array, unknown>): Stream.Stream<NativeChunk, ProviderError> {
  const frames = bytes.pipe(Stream.decodeText(), Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1024 * 1024 })))
  return Stream.concat(Stream.map(frames, (frame) => ({ kind: "frame" as const, event: frame.event, data: frame.data })),
    Stream.succeed({ kind: "end" as const })).pipe(
      Stream.mapAccumEffect(initial, (state, entry) => Effect.gen(function* () {
        const now = entry.kind === "frame" ? Math.floor((yield* Clock.currentTimeMillis) / 1000) : 0
        return yield* Effect.fromResult(transition(state, entry, now))
      })),
      Stream.mapError((cause): ProviderError => isError(cause) ? cause as ProviderError : fail("unknown", "Anthropic stream failed", false, cause)),
    )
}

function statusError(status: number): ProviderError {
  if (status === 429 || status === 529) return fail("rate_limited", "Anthropic rate limited the request", true)
  if (status === 401 || status === 403) return fail("unauthorized", "Anthropic authentication failed")
  if (status === 408 || status === 504) return fail("timeout", "Anthropic request timed out")
  if (status >= 500) return fail("unavailable", "Anthropic is unavailable", true)
  return fail("invalid_request", `Anthropic rejected the request (${status})`)
}

/** Bind a private Anthropic Messages model to the router's event interface. */
export function make(config: AnthropicMessagesDeploymentConfig): Result.Result<AnthropicMessagesDeployment<HttpClient.HttpClient>, DeploymentError> {
  const parsed = Schema.decodeUnknownResult(DeploymentConfig)(config)
  if (Result.isFailure(parsed)) return Result.fail(DeploymentError.make({ message: parsed.failure.message }))
  const url = parsed.success.url ?? new URL("https://api.anthropic.com/v1/messages")
  if (url.protocol !== "http:" && url.protocol !== "https:") return Result.fail(DeploymentError.make({ message: "Anthropic Messages URL must use HTTP(S)" }))
  return Result.succeed({ id: parsed.success.id, provider: "anthropic", protocol: "anthropic.messages", model: parsed.success.model,
    execute: { http: (request) => Effect.gen(function* () {
      const parsedRequest = yield* Schema.decodeUnknownEffect(Request)(request).pipe(
        Effect.mapError((cause) => fail("invalid_request", cause.message, false, cause)))
      const body = yield* Effect.fromResult(toMessagesRequest(parsedRequest, parsed.success.defaultMaxTokens))
      const client = yield* HttpClient.HttpClient
      const outgoing = HttpClientRequest.post(url.toString()).pipe(
        HttpClientRequest.setHeader("x-api-key", Redacted.value(parsed.success.apiKey)),
        HttpClientRequest.setHeader("anthropic-version", parsed.success.version ?? "2023-06-01"),
        HttpClientRequest.setHeader("content-type", "application/json"), HttpClientRequest.bodyJsonUnsafe(body))
      const response = yield* client.execute(outgoing).pipe(
        Effect.mapError((cause) => fail("unavailable", "Anthropic connection failed", false, cause)))
      if (response.status < 200 || response.status >= 300) return yield* Effect.fail(statusError(response.status))
      if (!response.headers["content-type"]?.toLowerCase().startsWith("text/event-stream")) {
        return yield* Effect.fail(fail("unknown", "Expected an Anthropic event stream"))
      }
      return fromNative(request, events(response.stream))
    }) },
  })
}
