import { Effect, HashMap, Layer, Option, Redacted, Result, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { ConversionError, fromSchema } from "@better-router/core/Conversion"
import type { HttpContribution } from "@better-router/core/Http"
import { HttpJsonError, read as readJson } from "@better-router/core/HttpJson"
import type { ModelEvent, ModelResponse } from "@better-router/core/Model"
import { Event, Response } from "@better-router/core/ModelSchema"
import { RouterError } from "@better-router/core/Router"
import type { Router } from "@better-router/core/Router"
import { decodeRequest, toResponseRequest } from "./OpenAIChatCompletions.js"

export interface OpenAIChatCompletionsHttpOptions { readonly gatewayKey: Redacted.Redacted<string> }

export const OpenAIChatCompletionsHttpError = Schema.Struct({ error: Schema.Struct({
  message: Schema.String,
  type: Schema.Literals(["authentication_error", "invalid_request_error", "unsupported_feature", "upstream_error", "server_error"]),
}) })

export const api = HttpApi.make("openai-chat-completions").add(
  HttpApiGroup.make("openAIChatCompletions").add(HttpApiEndpoint.post("create", "/v1/chat/completions", {
    success: [Schema.Unknown, HttpApiSchema.StreamUint8Array({ contentType: "text/event-stream; charset=utf-8" })],
    error: [400, 401, 404, 413, 415, 422, 429, 500, 502, 503, 504].map((status) =>
      OpenAIChatCompletionsHttpError.pipe(HttpApiSchema.status(status))),
  })),
)

export const OpenAIChatCompletionsUpstreamResponseError = Schema.Struct({
  _tag: Schema.Literal("OpenAIChatCompletionsUpstreamResponseError"), message: Schema.String,
})
export type OpenAIChatCompletionsUpstreamResponseError = typeof OpenAIChatCompletionsUpstreamResponseError.Type

const upstreamError = (message: string) => OpenAIChatCompletionsUpstreamResponseError.make({
  _tag: "OpenAIChatCompletionsUpstreamResponseError", message,
})

interface Call { readonly id: string; readonly type: "function"; readonly function: { readonly name: string; readonly arguments: string } }
interface Output { readonly content: string; readonly refusal: string | null; readonly tool_calls: readonly Call[] }

function projectOutput(response: ModelResponse): Result.Result<Output, OpenAIChatCompletionsUpstreamResponseError> {
  return response.output.reduce<Result.Result<Output, OpenAIChatCompletionsUpstreamResponseError>>(
    (previous, item, index) => Result.gen(function* () {
      const output = yield* previous
      if (item.type === "reasoning") return yield* Result.fail(upstreamError(`Unsupported response.output[${index}].type`))
      if (item.type === "function_call") return { ...output, tool_calls: [...output.tool_calls,
        { id: item.call_id, type: "function" as const, function: { name: item.name, arguments: item.arguments } }] }
      if (item.type !== "message" || item.role !== "assistant") {
        return yield* Result.fail(upstreamError(`Unsupported response.output[${index}].type`))
      }
      return yield* item.content.reduce<Result.Result<Output, OpenAIChatCompletionsUpstreamResponseError>>(
        (current, part, partIndex) => Result.gen(function* () {
          const state = yield* current
          if (part.type === "output_text") {
            if (part.annotations.length || (part.logprobs?.length ?? 0)) {
              return yield* Result.fail(upstreamError("Output annotations and logprobs cannot be represented as Chat Completions"))
            }
            return { ...state, content: state.content + part.text }
          }
          if (part.type === "refusal") return { ...state, refusal: (state.refusal ?? "") + part.refusal }
          return yield* Result.fail(upstreamError(`Unsupported response.output[${index}].content[${partIndex}].type`))
        }), Result.succeed(output),
      )
    }), Result.succeed({ content: "", refusal: null, tool_calls: [] }),
  )
}

type Completion = {
  readonly id: string
  readonly object: "chat.completion"
  readonly created: number
  readonly model: string
  readonly choices: readonly [{ readonly index: 0; readonly message: { readonly role: "assistant"; readonly content: string | null;
    readonly refusal: string | null; readonly tool_calls?: readonly Call[] }; readonly finish_reason: "stop" | "tool_calls" | "length" | "content_filter" }]
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number; readonly total_tokens: number;
    readonly prompt_tokens_details: { readonly cached_tokens: number }; readonly completion_tokens_details: { readonly reasoning_tokens: number } }
}

/** Parse the complete terminal resource before projecting one Chat choice. */
export function toChatCompletion(value: unknown, model?: string): Result.Result<Completion, OpenAIChatCompletionsUpstreamResponseError> {
  return Result.gen(function* () {
    const response = yield* Result.mapError(Schema.decodeUnknownResult(Response)(value),
      (error) => upstreamError(fromSchema(error, "response").message))
    const output = yield* projectOutput(response)
    const reason = response.status === "completed" ? output.tool_calls.length ? "tool_calls" as const : "stop" as const
      : response.status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens" ? "length" as const
        : response.status === "incomplete" && response.incomplete_details?.reason === "content_filter" ? "content_filter" as const
          : undefined
    if (!reason) return yield* Result.fail(upstreamError(`Cannot represent response status: ${response.status}`))
    return {
      id: `chatcmpl-${response.id}`, object: "chat.completion" as const, created: response.created_at,
      model: model ?? response.model,
      choices: [{ index: 0 as const, message: { role: "assistant" as const, content: output.content || null, refusal: output.refusal,
        ...(output.tool_calls.length ? { tool_calls: output.tool_calls } : {}) }, finish_reason: reason }] as const,
      ...(response.usage ? { usage: {
        prompt_tokens: response.usage.input_tokens, completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.total_tokens,
        prompt_tokens_details: { cached_tokens: response.usage.input_tokens_details.cached_tokens },
        completion_tokens_details: { reasoning_tokens: response.usage.output_tokens_details.reasoning_tokens },
      } } : {}),
    }
  })
}

const frame = (value: unknown) => Sse.encoder.write({
  _tag: "Event", event: "message", id: undefined, data: value === "[DONE]" ? "[DONE]" : JSON.stringify(value),
})

interface Identity { readonly id: string; readonly created: number; readonly model: string }
interface FrameState {
  readonly identity: Option.Option<Identity>
  readonly finished: boolean
  readonly calls: HashMap.HashMap<number, number>
  readonly items: HashMap.HashMap<number, string>
}
const initial = (): FrameState => ({ identity: Option.none(), finished: false, calls: HashMap.empty(), items: HashMap.empty() })
const send = (state: FrameState, delta: object, finish_reason: string | null = null): Result.Result<string, OpenAIChatCompletionsUpstreamResponseError> =>
  Result.map(Result.fromOption(state.identity, () => upstreamError("Missing response.created event")), (identity) =>
    frame({ ...identity, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] }))

function project(state: FrameState, event: ModelEvent | { readonly type: "end" }, model: string, includeUsage: boolean): Result.Result<readonly [FrameState, readonly string[]], OpenAIChatCompletionsUpstreamResponseError> {
  return Result.gen(function* () {
    if (event.type === "end") {
      if (!state.finished) return yield* Result.fail(upstreamError("Upstream stream ended without a terminal response"))
      return [state, [frame("[DONE]")]] as const
    }
    if (state.finished) return yield* Result.fail(upstreamError("Events followed the terminal response"))
    const parsed = yield* Result.mapError(Schema.decodeUnknownResult(Event)(event),
      (error) => upstreamError(fromSchema(error, "event").message))
    if (parsed.type === "response.created") {
      if (Option.isSome(state.identity)) return yield* Result.fail(upstreamError("Duplicate response.created event"))
      const response = yield* Result.mapError(Schema.decodeUnknownResult(Response)(parsed.response),
        (error) => upstreamError(fromSchema(error, "event.response").message))
      const next = { ...state, identity: Option.some({ id: `chatcmpl-${response.id}`, created: response.created_at, model }) }
      return [next, [yield* send(next, { role: "assistant", content: "" })]] as const
    }
    if (parsed.type === "response.output_item.added") {
      const index = parsed.output_index
      if (!Number.isInteger(index) || index < 0 || HashMap.has(state.items, index)) {
        return yield* Result.fail(upstreamError("Invalid output item index"))
      }
      const item = parsed.item
      if (!item) return yield* Result.fail(upstreamError("Invalid output item"))
      const next = { ...state, items: HashMap.set(state.items, index, item.type) }
      if (item.type === "function_call") {
        const callIndex = HashMap.size(state.calls)
        const withCall = { ...next, calls: HashMap.set(state.calls, index, callIndex) }
        return [withCall, [yield* send(withCall, { tool_calls: [{ index: callIndex, id: item.call_id, type: "function",
          function: { name: item.name, arguments: "" } }] })]] as const
      }
      if (item.type !== "message" || item.role !== "assistant") {
        return yield* Result.fail(upstreamError("Unsupported output item"))
      }
      return [next, []] as const
    }
    if (parsed.type === "response.output_text.delta" || parsed.type === "response.refusal.delta") {
      if (Option.getOrUndefined(HashMap.get(state.items, parsed.output_index)) !== "message") {
        return yield* Result.fail(upstreamError("Message delta before assistant item"))
      }
      if (parsed.type === "response.output_text.delta" && (parsed.logprobs?.length ?? 0)) {
        return yield* Result.fail(upstreamError("Output logprobs cannot be represented"))
      }
      return [state, [yield* send(state, { [parsed.type === "response.refusal.delta" ? "refusal" : "content"]: parsed.delta })]] as const
    }
    if (parsed.type === "response.function_call_arguments.delta") {
      const index = yield* Result.fromOption(HashMap.get(state.calls, parsed.output_index), () => upstreamError("Function call delta before item"))
      return [state, [yield* send(state, { tool_calls: [{ index, function: { arguments: parsed.delta } }] })]] as const
    }
    if (parsed.type === "response.output_text.annotation.added") return yield* Result.fail(upstreamError("Output annotations cannot be represented"))
    if (parsed.type === "response.completed" || parsed.type === "response.incomplete") {
      const completion = yield* toChatCompletion(parsed.response, model)
      const next = { ...state, finished: true }
      return [next, [yield* send(next, {}, completion.choices[0].finish_reason),
        ...(includeUsage ? [frame({ ...Option.getOrUndefined(next.identity), object: "chat.completion.chunk", choices: [], usage: completion.usage ?? null })] : [])]] as const
    }
    if (parsed.type === "response.failed" || parsed.type === "error") return yield* Result.fail(upstreamError("Upstream response failed"))
    return [state, []] as const
  })
}

const chatFrames = (source: Stream.Stream<ModelEvent, RouterError>, model: string, includeUsage: boolean): Stream.Stream<string> =>
  Stream.concat(source, Stream.succeed({ type: "end" as const })).pipe(
    Stream.mapAccumEffect(initial, (state, event) => Effect.fromResult(project(state, event, model, includeUsage))),
    Stream.catch((error) => Stream.succeed(frame(OpenAIChatCompletionsHttpError.make({ error: {
      message: Schema.is(OpenAIChatCompletionsUpstreamResponseError)(error) ? error.message
        : RouterError.guards.ProviderFailed(error) ? error.cause.message : "Upstream stream failed",
      type: "upstream_error",
    } })))),
  )

const errorResponse = (status: number, message: string, type: typeof OpenAIChatCompletionsHttpError.Type.error.type) =>
  HttpServerResponse.jsonUnsafe(OpenAIChatCompletionsHttpError.make({ error: { message, type } }), { status })

function onError(error: unknown): HttpServerResponse.HttpServerResponse {
  if (Schema.is(HttpJsonError)(error)) return errorResponse(error.status, error.message,
    error.status === 401 ? "authentication_error" : "invalid_request_error")
  if (Schema.is(ConversionError)(error)) return errorResponse(error.reason === "unsupported" ? 422 : 400,
    error.message, error.reason === "unsupported" ? "unsupported_feature" : "invalid_request_error")
  if (Schema.is(OpenAIChatCompletionsUpstreamResponseError)(error)) return errorResponse(502, error.message, "upstream_error")
  if (Schema.is(RouterError)(error)) return RouterError.match(error, {
    NoRoute: ({ model }) => errorResponse(404, "Unknown model: " + model, "invalid_request_error"),
    InvalidRequest: ({ message }) => errorResponse(400, message, "invalid_request_error"),
    UnsupportedCapability: ({ capability }) => errorResponse(422, "Unsupported capability: " + capability, "unsupported_feature"),
    NoAvailableDeployment: () => errorResponse(503, "No deployment available", "upstream_error"),
    ProviderFailed: ({ cause }) => errorResponse(cause.kind === "rate_limited" ? 429 : cause.kind === "timeout" ? 504
      : cause.kind === "unavailable" ? 503 : cause.kind === "invalid_request" ? 400 : cause.kind === "unsupported" ? 422 : 502,
      cause.message, "upstream_error"),
    InvalidResponse: () => errorResponse(502, "Model execution failed", "upstream_error"),
    RoutingFailed: () => errorResponse(502, "Model execution failed", "upstream_error"),
    TransformFailed: () => errorResponse(502, "Model execution failed", "upstream_error"),
  })
  return errorResponse(500, "Gateway failed", "server_error")
}

const handle = (router: Router, request: HttpServerRequest.HttpServerRequest, key: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const value = yield* readJson(request, request.headers.authorization === "Bearer " + Redacted.value(key))
    const native = yield* Effect.fromResult(decodeRequest(value))
    if (native.stream_options && native.stream !== true) return errorResponse(400, "Invalid stream_options", "invalid_request_error")
    const converted = yield* Effect.fromResult(toResponseRequest(value))
    const invocation = { ...converted, store: converted.store ?? false }
    if (converted.stream) {
      const source = yield* router.open(invocation)
      return HttpServerResponse.stream(chatFrames(source, converted.model, native.stream_options?.include_usage ?? false).pipe(Stream.encodeText), {
        headers: { "cache-control": "no-cache", "x-accel-buffering": "no" }, contentType: "text/event-stream; charset=utf-8",
      })
    }
    const response = yield* router.complete(invocation)
    return HttpServerResponse.jsonUnsafe(yield* Effect.fromResult(toChatCompletion(response, converted.model)))
  }).pipe(Effect.catch((error) => Effect.succeed(onError(error))))

export function make(options: OpenAIChatCompletionsHttpOptions): HttpContribution<typeof api> {
  return { api, routes: (router) => HttpApiBuilder.layer(api).pipe(Layer.provide(
    HttpApiBuilder.group(api, "openAIChatCompletions", (handlers) =>
      handlers.handleRaw("create", ({ request }) => handle(router, request, options.gatewayKey))),
  )) }
}
