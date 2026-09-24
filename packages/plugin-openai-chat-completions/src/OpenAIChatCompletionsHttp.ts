import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import type { HttpContribution } from "@better-router/core/Http"
import type { ModelResponse } from "@better-router/core/Model"
import { RouterError } from "@better-router/core/Router"
import type { Router } from "@better-router/core/Router"
import { OpenAIChatCompletionsConversionError, toResponseRequest } from "./OpenAIChatCompletions.js"

type Json = Record<string, unknown>

export interface OpenAIChatCompletionsHttpOptions {
  readonly gatewayKey: Redacted.Redacted<string>
}

export const OpenAIChatCompletionsHttpError = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,
    type: Schema.Literals([
      "authentication_error",
      "invalid_request_error",
      "unsupported_feature",
      "upstream_error",
      "server_error",
    ]),
  }),
})

export const api = HttpApi.make("openai-chat-completions").add(
  HttpApiGroup.make("openAIChatCompletions").add(
    HttpApiEndpoint.post("create", "/v1/chat/completions", {
      success: [Schema.Unknown, HttpApiSchema.StreamUint8Array({ contentType: "text/event-stream; charset=utf-8" })],
      error: [400, 401, 404, 413, 415, 422, 429, 500, 502, 503, 504].map((status) =>
        OpenAIChatCompletionsHttpError.pipe(HttpApiSchema.status(status)),
      ),
    }),
  ),
)

export class OpenAIChatCompletionsUpstreamResponseError extends Schema.TaggedError<OpenAIChatCompletionsUpstreamResponseError>()(
  "OpenAIChatCompletionsUpstreamResponseError",
  { message: Schema.String },
) {}

function upstreamError(message: string): OpenAIChatCompletionsUpstreamResponseError {
  return new OpenAIChatCompletionsUpstreamResponseError({ message })
}

function object(value: unknown, description: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw upstreamError(`Invalid ${description}`)
  return value as Json
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || !value) throw upstreamError(`Invalid ${description}`)
  return value
}

function usage(value: unknown) {
  if (value == null) return undefined
  const source = object(value, "response.usage")
  const prompt = source.input_tokens
  const completion = source.output_tokens
  const total = source.total_tokens
  if (![prompt, completion, total].every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw upstreamError("Invalid response.usage")
  }
  const input =
    source.input_tokens_details == null
      ? {}
      : object(source.input_tokens_details, "response.usage.input_tokens_details")
  const output =
    source.output_tokens_details == null
      ? {}
      : object(source.output_tokens_details, "response.usage.output_tokens_details")
  return {
    prompt_tokens: prompt as number,
    completion_tokens: completion as number,
    total_tokens: total as number,
    prompt_tokens_details: { cached_tokens: typeof input.cached_tokens === "number" ? input.cached_tokens : 0 },
    completion_tokens_details: {
      reasoning_tokens: typeof output.reasoning_tokens === "number" ? output.reasoning_tokens : 0,
    },
  }
}

function output(response: Json) {
  if (!Array.isArray(response.output)) throw upstreamError("Invalid response.output")
  let content = ""
  let refusal: string | null = null
  const tool_calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = []
  for (const [index, raw] of response.output.entries()) {
    const item = object(raw, `response.output[${index}]`)
    if (item.type === "reasoning") continue
    if (item.type === "function_call") {
      tool_calls.push({
        id: requiredString(item.call_id, `response.output[${index}].call_id`),
        type: "function",
        function: {
          name: requiredString(item.name, `response.output[${index}].name`),
          arguments: requiredStringOrEmpty(item.arguments, `response.output[${index}].arguments`),
        },
      })
      continue
    }
    if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) {
      throw upstreamError(`Unsupported response.output[${index}].type`)
    }
    for (const [partIndex, rawPart] of item.content.entries()) {
      const part = object(rawPart, `response.output[${index}].content[${partIndex}]`)
      if (part.type === "output_text") {
        if (
          (Array.isArray(part.annotations) && part.annotations.length > 0) ||
          (Array.isArray(part.logprobs) && part.logprobs.length > 0)
        ) {
          throw upstreamError("Output annotations and logprobs cannot be represented as Chat Completions")
        }
        content += requiredStringOrEmpty(part.text, `response.output[${index}].content[${partIndex}].text`)
      } else if (part.type === "refusal") {
        refusal =
          (refusal ?? "") +
          requiredStringOrEmpty(part.refusal, `response.output[${index}].content[${partIndex}].refusal`)
      } else {
        throw upstreamError(`Unsupported response.output[${index}].content[${partIndex}].type`)
      }
    }
  }
  return {
    role: "assistant" as const,
    content: content || null,
    refusal,
    ...(tool_calls.length ? { tool_calls } : {}),
  }
}

function requiredStringOrEmpty(value: unknown, description: string): string {
  if (typeof value !== "string") throw upstreamError(`Invalid ${description}`)
  return value
}

function finishReason(response: Json, hasTools: boolean): "stop" | "tool_calls" | "length" | "content_filter" {
  if (response.status === "completed") return hasTools ? "tool_calls" : "stop"
  if (response.status === "incomplete") {
    const reason = object(response.incomplete_details, "response.incomplete_details").reason
    if (reason === "max_output_tokens") return "length"
    if (reason === "content_filter") return "content_filter"
  }
  throw upstreamError(`Cannot represent response status: ${String(response.status)}`)
}

/** Project a terminal OpenResponses resource into a single Chat Completions choice. */
export function toChatCompletion(value: unknown, model?: string) {
  const response = object(value, "response") as Json & Partial<ModelResponse>
  const id = requiredString(response.id, "response.id")
  if (typeof response.created_at !== "number" || !Number.isFinite(response.created_at)) {
    throw upstreamError("Invalid response.created_at")
  }
  const message = output(response)
  const tokens = usage(response.usage)
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion" as const,
    created: response.created_at,
    model: model ?? requiredString(response.model, "response.model"),
    choices: [{ index: 0, message, finish_reason: finishReason(response, !!message.tool_calls) }],
    ...(tokens ? { usage: tokens } : {}),
  }
}

type Event = Json & { type: string }

function frame(value: unknown): string {
  return Sse.encoder.write({
    _tag: "Event",
    event: "message",
    id: undefined,
    data: value === "[DONE]" ? "[DONE]" : JSON.stringify(value),
  })
}

function chatFrames(
  source: Stream.Stream<Event, RouterError>,
  model: string,
  includeUsage: boolean,
): Stream.Stream<string> {
  return Stream.suspend(() => {
    let identity: { id: string; created: number; model: string } | undefined
    let finished = false
    const calls = new Map<number, number>()
    const items = new Map<number, string>()
    const send = (delta: Json, finish_reason: string | null = null) => {
      if (!identity) throw upstreamError("Missing response.created event")
      return frame({ ...identity, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })
    }
    const project = (event: Event): string[] => {
      if (event.type === "response.created") {
        if (identity) throw upstreamError("Duplicate response.created event")
        const response = object(event.response, "response.created.response")
        identity = {
          id: "chatcmpl-" + requiredString(response.id, "response.id"),
          created: response.created_at as number,
          model,
        }
        if (!Number.isFinite(identity.created)) throw upstreamError("Invalid response.created_at")
        return [send({ role: "assistant", content: "" })]
      }
      if (event.type === "response.output_item.added") {
        const item = object(event.item, "response.output_item.added.item")
        const index = event.output_index
        if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || items.has(index)) {
          throw upstreamError("Invalid output item index")
        }
        items.set(index, requiredString(item.type, "item.type"))
        if (item.type === "function_call") {
          const callIndex = calls.size
          calls.set(index, callIndex)
          return [
            send({
              tool_calls: [
                {
                  index: callIndex,
                  id: requiredString(item.call_id, "item.call_id"),
                  type: "function",
                  function: { name: requiredString(item.name, "item.name"), arguments: "" },
                },
              ],
            }),
          ]
        }
        if (item.type !== "reasoning" && (item.type !== "message" || item.role !== "assistant")) {
          throw upstreamError("Unsupported output item")
        }
        return []
      }
      if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
        if (items.get(event.output_index as number) !== "message")
          throw upstreamError("Message delta before assistant item")
        if (event.type === "response.output_text.delta" && Array.isArray(event.logprobs) && event.logprobs.length) {
          throw upstreamError("Output logprobs cannot be represented")
        }
        return [
          send({
            [event.type === "response.refusal.delta" ? "refusal" : "content"]: requiredStringOrEmpty(
              event.delta,
              "text delta",
            ),
          }),
        ]
      }
      if (event.type === "response.function_call_arguments.delta") {
        const index = calls.get(event.output_index as number)
        if (index === undefined) throw upstreamError("Function call delta before item")
        return [
          send({
            tool_calls: [{ index, function: { arguments: requiredStringOrEmpty(event.delta, "arguments delta") } }],
          }),
        ]
      }
      if (event.type === "response.output_text.annotation.added") {
        throw upstreamError("Output annotations cannot be represented")
      }
      if (event.type === "response.completed" || event.type === "response.incomplete") {
        const completion = toChatCompletion(event.response, model)
        finished = true
        return [
          send({}, completion.choices[0].finish_reason),
          ...(includeUsage
            ? [frame({ ...identity, object: "chat.completion.chunk", choices: [], usage: completion.usage ?? null })]
            : []),
        ]
      }
      if (event.type === "response.failed" || event.type === "error")
        throw upstreamError("Upstream response failed")
      return []
    }

    return source.pipe(
      Stream.mapEffect((event) =>
        Effect.try({
          try: () => project(event as Event),
          catch: (cause) =>
            cause instanceof OpenAIChatCompletionsUpstreamResponseError ? cause : upstreamError("Invalid upstream event"),
        }),
      ),
      Stream.flatMap(Stream.fromIterable),
      Stream.concat(
        Stream.unwrap(
          Effect.sync(() =>
            finished
              ? Stream.succeed(frame("[DONE]"))
              : Stream.fail(upstreamError("Upstream stream ended without a terminal response")),
          ),
        ),
      ),
      Stream.catch((error) =>
        Stream.succeed(
          frame(OpenAIChatCompletionsHttpError.make({
            error: {
              message:
                error instanceof OpenAIChatCompletionsUpstreamResponseError
                  ? error.message
                  : RouterError.guards.ProviderFailed(error)
                    ? error.cause.message
                    : "Upstream stream failed",
              type: "upstream_error",
            },
          })),
        ),
      ),
    )
  })
}

function errorResponse(
  status: number,
  message: string,
  type: typeof OpenAIChatCompletionsHttpError.Type.error.type,
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(OpenAIChatCompletionsHttpError.make({ error: { message, type } }), { status })
}

const isRouterError = Schema.is(RouterError)

function onError(error: unknown): HttpServerResponse.HttpServerResponse {
  if (error instanceof OpenAIChatCompletionsConversionError)
    return errorResponse(
      error.reason === "unsupported" ? 422 : 400,
      error.message,
      error.reason === "unsupported" ? "unsupported_feature" : "invalid_request_error",
    )
  if (error instanceof OpenAIChatCompletionsUpstreamResponseError) return errorResponse(502, error.message, "upstream_error")
  if (isRouterError(error)) {
    return RouterError.match(error, {
      NoRoute: ({ model }) => errorResponse(404, "Unknown model: " + model, "invalid_request_error"),
      InvalidRequest: ({ message }) => errorResponse(400, message, "invalid_request_error"),
      UnsupportedCapability: ({ capability }) =>
        errorResponse(422, "Unsupported capability: " + capability, "unsupported_feature"),
      NoAvailableDeployment: () => errorResponse(503, "No deployment available", "upstream_error"),
      ProviderFailed: ({ cause }) => {
        const status =
          cause.kind === "rate_limited"
            ? 429
            : cause.kind === "timeout"
              ? 504
              : cause.kind === "unavailable"
                ? 503
                : cause.kind === "invalid_request"
                  ? 400
                  : cause.kind === "unsupported"
                    ? 422
                    : 502
        return errorResponse(status, cause.message, "upstream_error")
      },
      InvalidResponse: () => errorResponse(502, "Model execution failed", "upstream_error"),
      RoutingFailed: () => errorResponse(502, "Model execution failed", "upstream_error"),
      TransformFailed: () => errorResponse(502, "Model execution failed", "upstream_error"),
    })
  }
  return errorResponse(500, "Gateway failed", "server_error")
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

function handle(router: Router, request: HttpServerRequest.HttpServerRequest, key: Redacted.Redacted<string>) {
  return Effect.gen(function* () {
    if (request.headers.authorization !== "Bearer " + Redacted.value(key)) {
      return errorResponse(401, "Invalid gateway key", "authentication_error")
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      return errorResponse(415, "Expected application/json", "invalid_request_error")
    }
    const limit = 1024 * 1024
    if (Number(request.headers["content-length"]) > limit)
      return errorResponse(413, "Request too large", "invalid_request_error")
    let size = 0
    const chunks: Uint8Array[] = []
    // Drain chunked uploads after the limit; closing a Node request early also closes its response socket.
    yield* Stream.runForEach(request.stream, (chunk) =>
      Effect.sync(() => {
        size += chunk.byteLength
        if (size <= limit) chunks.push(chunk.slice())
      }),
    )
    if (size > limit) return errorResponse(413, "Request too large", "invalid_request_error")
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const raw = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => OpenAIChatCompletionsConversionError.at("request", "invalid", "Invalid UTF-8 request"),
    })
    const value = yield* decodeJson(raw).pipe(
      Effect.mapError(() => OpenAIChatCompletionsConversionError.at("request", "invalid", "Invalid JSON request")),
    )
    let includeUsage = false
    let body = value
    if (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      "stream_options" in body &&
      body.stream_options !== undefined
    ) {
      const source = body as Record<string, unknown>
      const options = source.stream_options
      if (source.stream !== true || typeof options !== "object" || options === null || Array.isArray(options)) {
        return errorResponse(400, "Invalid stream_options", "invalid_request_error")
      }
      const streamOptions = options as Record<string, unknown>
      if ("include_usage" in streamOptions) {
        if (typeof streamOptions.include_usage !== "boolean") {
          return errorResponse(400, "stream_options.include_usage must be a boolean", "invalid_request_error")
        }
        includeUsage = streamOptions.include_usage
      }
      const { include_usage: _includeUsage, ...upstreamOptions } = streamOptions
      body = { ...source, stream_options: upstreamOptions }
    }
    const converted = yield* Effect.try({
      try: () => toResponseRequest(body),
      catch: (cause) =>
        cause instanceof OpenAIChatCompletionsConversionError ? cause : OpenAIChatCompletionsConversionError.at("request", "invalid", "Invalid request"),
    })
    const invocation = { ...converted, store: converted.store ?? false }
    if (converted.stream) {
      const source = yield* router.open(invocation)
      return HttpServerResponse.stream(
        chatFrames(source as Stream.Stream<Event, RouterError>, converted.model, includeUsage).pipe(Stream.encodeText),
        {
          headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
          contentType: "text/event-stream; charset=utf-8",
        },
      )
    }
    const response = yield* router.complete(invocation)
    const completion = yield* Effect.try({
      try: () => toChatCompletion(response, converted.model),
      catch: (cause) =>
        cause instanceof OpenAIChatCompletionsUpstreamResponseError ? cause : upstreamError("Invalid upstream response"),
    })
    return HttpServerResponse.jsonUnsafe(completion)
  }).pipe(Effect.catch((error) => Effect.succeed(onError(error))))
}

/** Contribute a typed Chat Completions endpoint to the composed router. */
export function make(options: OpenAIChatCompletionsHttpOptions): HttpContribution<typeof api> {
  return {
    api,
    routes: (router) =>
      HttpApiBuilder.layer(api).pipe(
        Layer.provide(
          HttpApiBuilder.group(api, "openAIChatCompletions", (handlers) =>
            handlers.handleRaw("create", ({ request }) => handle(router, request, options.gatewayKey)),
          ),
        ),
      ),
  }
}
