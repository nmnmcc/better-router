import { Effect, Layer, Redacted, Result, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import { ConversionError, at, fromSchema, requireThat } from "@better-router/core/Conversion"
import { HttpJsonError, read as readJson } from "@better-router/core/HttpJson"
import type { HttpContribution } from "@better-router/core/Http"
import type { ModelEvent, ModelRequest } from "@better-router/core/Model"
import { Event, Request, Response } from "@better-router/core/ModelSchema"
import { RouterError } from "@better-router/core/Router"
import type { Router } from "@better-router/core/Router"

export interface OpenAIResponsesHttpOptions { readonly gatewayKey: Redacted.Redacted<string> }

export const OpenAIResponsesHttpError = Schema.Struct({ error: Schema.Struct({ message: Schema.String, type: Schema.String }) })
export const OpenAIResponsesConversionError = ConversionError
export type OpenAIResponsesConversionError = ConversionError

export const api = HttpApi.make("openai-responses").add(
  HttpApiGroup.make("openAIResponses").add(HttpApiEndpoint.post("create", "/v1/responses", {
    success: [Schema.Unknown, HttpApiSchema.StreamUint8Array({ contentType: "text/event-stream; charset=utf-8" })],
    error: [400, 401, 404, 413, 415, 422, 429, 500, 502, 503, 504].map((status) =>
      OpenAIResponsesHttpError.pipe(HttpApiSchema.status(status))),
  })),
)

const allowed = ["model", "input", "instructions", "tools", "tool_choice", "text", "max_output_tokens", "temperature", "top_p",
  "presence_penalty", "frequency_penalty", "parallel_tool_calls", "stream", "stream_options", "store", "metadata",
  "previous_response_id"] as const
const allowedPart = (type: string): readonly string[] => type === "input_text" ? ["type", "text"]
  : type === "input_image" ? ["type", "image_url", "detail"]
    : type === "output_text" ? ["type", "text", "annotations"] : ["type"]

/** Decode the complete wire shape, then reject semantics this ingress cannot project. */
export function toResponseRequest(value: unknown): Result.Result<ModelRequest, ConversionError> {
  return Result.gen(function* () {
    const request = yield* Result.mapError(Schema.decodeUnknownResult(Request)(value, { onExcessProperty: "error" }),
      (error) => fromSchema(error, "request"))
    yield* requireThat(!!request.model, "request.model", "invalid", "model is required")
    const excluded = Object.entries(request).find(([key, entry]) => entry !== undefined && !allowed.includes(key as typeof allowed[number]))
    if (excluded) return yield* Result.fail(at(`request.${excluded[0]}`, "unsupported", "no portable mapping"))
    if (Array.isArray(request.input)) {
      const item = request.input.findIndex((entry) => !["message", "function_call", "function_call_output"].includes(entry.type))
      if (item >= 0) return yield* Result.fail(at(`request.input[${item}].type`, "unsupported", "input item"))
      const parts = request.input.flatMap((entry, index) => entry.type === "message" && Array.isArray(entry.content)
        ? entry.content.map((part: { readonly type: string }, position: number) =>
          ({ part, path: `request.input[${index}].content[${position}]` })) : [])
      const unsupportedPart = parts.map(({ part, path }) => ({ path,
        extra: Object.keys(part).find((key) => !allowedPart(part.type).includes(key)),
      })).find(({ extra }) => extra !== undefined)
      if (unsupportedPart) return yield* Result.fail(at(`${unsupportedPart.path}.${unsupportedPart.extra}`, "unsupported", "no portable mapping"))
      const images = request.input.flatMap((entry, index) => entry.type === "message" && Array.isArray(entry.content)
        ? entry.content.map((part: { readonly type: string; readonly image_url?: string | null }, position: number) =>
          ({ part, path: `request.input[${index}].content[${position}].image_url` })) : [])
      const invalidImage = images.find(({ part }) => part.type === "input_image" && typeof part.image_url === "string"
        && !/^https?:\/\/\S+$/.test(part.image_url)
        && !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/.test(part.image_url))
      if (invalidImage) return yield* Result.fail(at(invalidImage.path, "unsupported", "only URL and base64 image data are portable"))
    }
    if (request.tools) {
      const tool = request.tools.findIndex((entry) => entry.type !== "function")
      if (tool >= 0) return yield* Result.fail(at(`request.tools[${tool}].type`, "unsupported", "only function tools are portable"))
    }
    return request
  })
}

const frame = (event: ModelEvent | "[DONE]"): string => Sse.encoder.write({
  _tag: "Event", event: event === "[DONE]" ? "message" : event.type, id: undefined,
  data: event === "[DONE]" ? event : JSON.stringify(event),
})

const frames = (source: Stream.Stream<ModelEvent, RouterError>, model: string): Stream.Stream<string> =>
  Stream.concat(source, Stream.succeed({ type: "end" as const })).pipe(
    Stream.mapAccumEffect(() => ({ terminal: false, sequence: 0 }), (state, event) => Effect.fromResult(Result.gen(function* () {
      if (event.type === "end") {
        if (!state.terminal) return yield* Result.fail(at("event", "invalid", "Missing terminal response"))
        return [state, [frame("[DONE]")]] as const
      }
      if (state.terminal) return yield* Result.fail(at("event", "invalid", "Events followed the terminal response"))
      if ("response" in event && (!event.response || typeof event.response !== "object" || Array.isArray(event.response))) {
        return yield* Result.fail(at("event.response", "invalid", "Invalid upstream response"))
      }
      const projected = "response" in event
        ? { ...event, sequence_number: state.sequence, response: { ...(event.response as object), model } }
        : { ...event, sequence_number: state.sequence }
      const parsed = yield* Result.mapError(Schema.decodeUnknownResult(Event)(projected),
        (error) => fromSchema(error, "event"))
      const terminal = parsed.type === "response.completed" || parsed.type === "response.incomplete" || parsed.type === "response.failed"
      return [{ terminal, sequence: state.sequence + 1 }, [frame(parsed)]] as const
    }))),
    Stream.catch((error) => Stream.succeed(Sse.encoder.write({
      _tag: "Event", event: "error", id: undefined,
      data: JSON.stringify({ type: "error", error: { message: Schema.is(ConversionError)(error) ? error.message : "Upstream stream failed" } }),
    }))),
  )

const errorResponse = (status: number, message: string, type = "invalid_request_error") =>
  HttpServerResponse.jsonUnsafe(OpenAIResponsesHttpError.make({ error: { message, type } }), { status })

function onError(error: unknown) {
  if (Schema.is(ConversionError)(error)) return errorResponse(error.reason === "unsupported" ? 422 : 400, error.message)
  if (Schema.is(HttpJsonError)(error)) return errorResponse(error.status, error.message)
  if (Schema.is(RouterError)(error)) return RouterError.match(error, {
    NoRoute: ({ model }) => errorResponse(404, `Unknown model: ${model}`),
    InvalidRequest: ({ message }) => errorResponse(400, message),
    UnsupportedCapability: ({ capability }) => errorResponse(422, `Unsupported capability: ${capability}`),
    NoAvailableDeployment: () => errorResponse(503, "No deployment available", "server_error"),
    ProviderFailed: ({ cause }) => errorResponse(
      cause.kind === "rate_limited" ? 429 : cause.kind === "timeout" ? 504 : cause.kind === "unavailable" ? 503
        : cause.kind === "invalid_request" ? 400 : cause.kind === "unsupported" ? 422 : 502,
      cause.message, "upstream_error",
    ),
    InvalidResponse: () => errorResponse(502, "Model execution failed", "upstream_error"),
    RoutingFailed: () => errorResponse(502, "Model execution failed", "upstream_error"),
    TransformFailed: () => errorResponse(502, "Model execution failed", "upstream_error"),
  })
  return errorResponse(500, "Gateway failed", "server_error")
}

const handle = (router: Router, request: HttpServerRequest.HttpServerRequest, key: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const body = yield* readJson(request, request.headers.authorization === `Bearer ${Redacted.value(key)}`)
    const converted = yield* Effect.fromResult(toResponseRequest(body))
    if (converted.stream) {
      const events = yield* router.open(converted)
      return HttpServerResponse.stream(frames(events, converted.model).pipe(Stream.encodeText), {
        headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
        contentType: "text/event-stream; charset=utf-8",
      })
    }
    const response = yield* router.complete(converted)
    const projected = yield* Effect.fromResult(Result.mapError(
      Schema.decodeUnknownResult(Response)({ ...response, model: converted.model }),
      (error) => fromSchema(error, "response"),
    )).pipe(Effect.mapError((error) => RouterError.cases.InvalidResponse.make({ message: error.message })))
    return HttpServerResponse.jsonUnsafe(projected)
  }).pipe(Effect.catch((error) => Effect.succeed(onError(error))))

export function make(options: OpenAIResponsesHttpOptions): HttpContribution<typeof api> {
  return { api, routes: (router) => HttpApiBuilder.layer(api).pipe(Layer.provide(
    HttpApiBuilder.group(api, "openAIResponses", (handlers) =>
      handlers.handleRaw("create", ({ request }) => handle(router, request, options.gatewayKey))),
  )) }
}
