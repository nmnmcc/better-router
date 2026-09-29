import { Effect, Layer, Match, Option, Redacted, Result, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
} from "effect/unstable/httpapi"
import { ConversionError, at, fromSchema, requireThat } from "@better-router/core/Conversion"
import { HttpJsonError, read as readJson } from "@better-router/core/HttpJson"
import type { HttpContribution } from "@better-router/core/Http"
import type { GenerationEvent, GenerationRequest } from "@better-router/core/Generation"
import { Request as GenerationRequestSchema } from "@better-router/core/GenerationSchema"
import type { ProtocolDefinition } from "@better-router/core/Projection"
import { RouterError } from "@better-router/core/Router"
import type { Router } from "@better-router/core/Router"
import { complete as completeGeneration } from "@better-router/core/Execution"
import type { Execution } from "@better-router/core/Execution"
import { Event, Request, Response } from "./OpenAIResponsesSchema.js"

export interface OpenAIResponsesHttpOptions {
	readonly gatewayKey: Redacted.Redacted<string>
}

export const OpenAIResponsesHttpError = Schema.Struct({
	error: Schema.Struct({ message: Schema.String, type: Schema.String }),
})
export const OpenAIResponsesConversionError = ConversionError
export type OpenAIResponsesConversionError = ConversionError

export const projection: ProtocolDefinition<
	string,
	unknown,
	"openai.responses",
	"openai.responses",
	"generation"
> = {
	id: "openai.responses",
	protocol: "openai.responses",
	capability: "generation",
	decode: toResponseRequest,
	encodeEvent: (event) =>
		Result.mapError(Result.map(Schema.encodeUnknownResult(Event)(event), frame), (error) =>
			fromSchema(error, "event"),
		),
	encodeResponse: (response) =>
		Result.mapError(Schema.encodeUnknownResult(Response)(response), (error) =>
			fromSchema(error, "response"),
		),
	encodeEvents: (events, context) => frames(events, context.model),
}

const NativeRequest = Schema.StructWithRest(
	Schema.Struct({ model: Schema.String, stream: Schema.optional(Schema.Boolean) }),
	[Schema.Record(Schema.String, Schema.Unknown)] as const,
)
export const toNativeRequest = (
	value: unknown,
): Result.Result<{ readonly model: string; readonly stream?: boolean }, ConversionError> =>
	Result.map(Schema.decodeUnknownResult(NativeRequest)(value), ({ model, stream }) => ({
		model,
		...(stream === undefined ? {} : { stream }),
	})).pipe(Result.mapError((error) => fromSchema(error, "request")))

export const api = HttpApi.make("openai-responses").add(
	HttpApiGroup.make("openAIResponses").add(
		HttpApiEndpoint.post("create", "/v1/responses", {
			success: [
				Schema.Unknown,
				HttpApiSchema.StreamUint8Array({ contentType: "text/event-stream; charset=utf-8" }),
			],
			error: [400, 401, 404, 413, 415, 422, 429, 500, 502, 503, 504].map((status) =>
				OpenAIResponsesHttpError.pipe(HttpApiSchema.status(status)),
			),
		}),
	),
)

const allowed = [
	"model",
	"input",
	"instructions",
	"tools",
	"tool_choice",
	"text",
	"max_output_tokens",
	"temperature",
	"top_p",
	"presence_penalty",
	"frequency_penalty",
	"parallel_tool_calls",
	"stream",
	"stream_options",
	"store",
	"metadata",
	"previous_response_id",
] as const
const allowedPart = (type: string): readonly string[] =>
	Match.value(type).pipe(
		Match.when("input_text", () => ["type", "text"]),
		Match.when("input_image", () => ["type", "image_url", "detail"]),
		Match.when("output_text", () => ["type", "text", "annotations"]),
		Match.orElse(() => ["type"]),
	)

type InputFacts = {
	readonly unsupportedItem: number | undefined
	readonly unsupportedPart: { readonly path: string; readonly extra: string } | undefined
	readonly invalidImage: string | undefined
}

type NativePart = {
	readonly type: string
	readonly image_url?: unknown
	readonly [key: string]: unknown
}

const emptyInputFacts = (): InputFacts => ({
	unsupportedItem: undefined,
	unsupportedPart: undefined,
	invalidImage: undefined,
})

const collectInputFacts = (request: typeof Request.Type): InputFacts => {
	if (!Array.isArray(request.input)) return emptyInputFacts()
	return request.input.reduce<InputFacts>((facts, entry, index) => {
		if (facts.unsupportedItem !== undefined) return facts
		return Match.value(entry.type).pipe(
			Match.when("message", () => {
				if (!Array.isArray(entry.content)) return facts
				const parts: readonly NativePart[] = entry.content
				return parts.reduce<InputFacts>((current, part, position) => {
					const path = `request.input[${index}].content[${position}]`
					const extra = Object.keys(part).find(
						(key) => !allowedPart(part.type).includes(key),
					)
					const unsupportedPart =
						current.unsupportedPart ??
						(extra === undefined ? undefined : { path, extra })
					const invalidImage =
						current.invalidImage ??
						(part.type === "input_image" &&
						typeof part.image_url === "string" &&
						!/^https?:\/\/\S+$/.test(part.image_url) &&
						!/^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/.test(
							part.image_url,
						)
							? `${path}.image_url`
							: undefined)
					return { ...current, unsupportedPart, invalidImage }
				}, facts)
			}),
			Match.whenOr("function_call", "function_call_output", () => facts),
			Match.orElse(() => ({ ...facts, unsupportedItem: index })),
		)
	}, emptyInputFacts())
}

/** Decode the complete wire shape, then reject semantics this ingress cannot project. */
export function toResponseRequest(
	value: unknown,
): Result.Result<GenerationRequest, ConversionError> {
	return Result.gen(function* () {
		const request = yield* Result.mapError(
			Schema.decodeUnknownResult(Request)(value, { onExcessProperty: "error" }),
			(error) => fromSchema(error, "request"),
		)
		yield* requireThat(!!request.model, "request.model", "invalid", "model is required")
		const excluded = Object.entries(request).find(
			([key, entry]) =>
				entry !== undefined && !allowed.includes(key as (typeof allowed)[number]),
		)
		if (excluded)
			return yield* Result.fail(
				at(`request.${excluded[0]}`, "unsupported", "no portable mapping"),
			)
		const inputFacts = collectInputFacts(request)
		if (inputFacts.unsupportedItem !== undefined)
			return yield* Result.fail(
				at(
					`request.input[${inputFacts.unsupportedItem}].type`,
					"unsupported",
					"input item",
				),
			)
		if (inputFacts.unsupportedPart)
			return yield* Result.fail(
				at(
					`${inputFacts.unsupportedPart.path}.${inputFacts.unsupportedPart.extra}`,
					"unsupported",
					"no portable mapping",
				),
			)
		if (inputFacts.invalidImage)
			return yield* Result.fail(
				at(
					inputFacts.invalidImage,
					"unsupported",
					"only URL and base64 image data are portable",
				),
			)
		if (request.tools) {
			const tool = request.tools.findIndex((entry) => entry.type !== "function")
			if (tool >= 0)
				return yield* Result.fail(
					at(
						`request.tools[${tool}].type`,
						"unsupported",
						"only function tools are portable",
					),
				)
		}
		return yield* Result.mapError(
			Schema.decodeUnknownResult(GenerationRequestSchema)(request),
			(error) => fromSchema(error, "request"),
		)
	})
}

const frame = (event: GenerationEvent | "[DONE]"): string =>
	Match.value(event).pipe(
		Match.when("[DONE]", (value) =>
			Sse.encoder.write({
				_tag: "Event",
				event: "message",
				id: undefined,
				data: value,
			}),
		),
		Match.orElse((value) =>
			Sse.encoder.write({
				_tag: "Event",
				event: value.type,
				id: undefined,
				data: JSON.stringify(value),
			}),
		),
	)

const nativeErrorFrame = (message: string): string =>
	Sse.encoder.write({
		_tag: "Event",
		event: "error",
		id: undefined,
		data: JSON.stringify({ type: "error", error: { message } }),
	})

const frames = (
	source: Stream.Stream<GenerationEvent, unknown>,
	model: string,
): Stream.Stream<string> =>
	Stream.concat(source, Stream.succeed({ type: "end" as const })).pipe(
		Stream.mapAccumEffect(
			() => ({ terminal: false, sequence: 0 }),
			(state, event) =>
				Effect.fromResult(
					Result.gen(function* () {
						const endResult = Match.value(event).pipe(
							Match.when({ type: "end" }, () =>
								state.terminal
									? Result.succeed([state, [frame("[DONE]")]] as const)
									: Result.fail(
											at("event", "invalid", "Missing terminal response"),
										),
							),
							Match.orElse(() => Result.succeed(undefined)),
						) as Result.Result<
							| readonly [
									{ readonly terminal: boolean; readonly sequence: number },
									readonly string[],
							  ]
							| undefined,
							ConversionError
						>
						const end = yield* endResult
						if (end !== undefined) return end
						if (state.terminal)
							return yield* Result.fail(
								at("event", "invalid", "Events followed the terminal response"),
							)
						if (
							"response" in event &&
							(!event.response ||
								typeof event.response !== "object" ||
								Array.isArray(event.response))
						) {
							return yield* Result.fail(
								at("event.response", "invalid", "Invalid upstream response"),
							)
						}
						const projected =
							"response" in event
								? {
										...event,
										sequence_number: state.sequence,
										response: { ...(event.response as object), model },
									}
								: { ...event, sequence_number: state.sequence }
						const parsed = yield* Result.mapError(
							Schema.decodeUnknownResult(Event)(projected),
							(error) => fromSchema(error, "event"),
						)
						const terminal = Match.value(parsed).pipe(
							Match.when(
								{
									type: Match.is(
										"response.completed",
										"response.incomplete",
										"response.failed",
									),
								},
								() => true,
							),
							Match.orElse(() => false),
						)
						return [
							{ terminal, sequence: state.sequence + 1 },
							[frame(parsed)],
						] as const
					}),
				),
		),
		Stream.catch((error) =>
			Stream.succeed(
				Sse.encoder.write({
					_tag: "Event",
					event: "error",
					id: undefined,
					data: JSON.stringify({
						type: "error",
						error: {
							message: Match.value(error).pipe(
								Match.when(Schema.is(ConversionError), (value) => value.message),
								Match.orElse(() => "Upstream stream failed"),
							),
						},
					}),
				}),
			),
		),
	)

const errorResponse = (status: number, message: string, type = "invalid_request_error") =>
	HttpServerResponse.jsonUnsafe(OpenAIResponsesHttpError.make({ error: { message, type } }), {
		status,
	})

function onError(error: unknown) {
	if (Schema.is(ConversionError)(error))
		return errorResponse(
			Match.value(error.reason).pipe(
				Match.when("unsupported", () => 422),
				Match.orElse(() => 400),
			),
			error.message,
		)
	if (Schema.is(HttpJsonError)(error)) return errorResponse(error.status, error.message)
	if (Schema.is(RouterError)(error))
		return RouterError.match(error, {
			NoRoute: ({ model }) => errorResponse(404, `Unknown model: ${model}`),
			InvalidRequest: ({ message }) => errorResponse(400, message),
			UnsupportedCapability: ({ capability }) =>
				errorResponse(422, `Unsupported capability: ${capability}`),
			NoAvailableDeployment: () =>
				errorResponse(503, "No deployment available", "server_error"),
			ProviderFailed: ({ cause }) =>
				errorResponse(
					Match.value(cause.kind).pipe(
						Match.when("rate_limited", () => 429),
						Match.when("timeout", () => 504),
						Match.when("unavailable", () => 503),
						Match.when("invalid_request", () => 400),
						Match.when("unsupported", () => 422),
						Match.orElse(() => 502),
					),
					cause.message,
					"upstream_error",
				),
			InvalidResponse: () => errorResponse(502, "Model execution failed", "upstream_error"),
			RoutingFailed: () => errorResponse(502, "Model execution failed", "upstream_error"),
			MiddlewareFailed: () => errorResponse(502, "Model execution failed", "upstream_error"),
		})
	return errorResponse(500, "Gateway failed", "server_error")
}

const handle = (
	router: Router,
	request: HttpServerRequest.HttpServerRequest,
	key: Redacted.Redacted<string>,
) =>
	Effect.gen(function* () {
		const body = yield* readJson(
			request,
			request.headers.authorization === `Bearer ${Redacted.value(key)}`,
		)
		const nativeRequest = yield* Effect.fromResult(toNativeRequest(body))
		const direct =
			nativeRequest.stream === true
				? Option.some(
						yield* router.invoke({
							type: "protocol",
							request: {
								protocol: "openai.responses",
								model: nativeRequest.model,
								body,
								headers: Object.fromEntries(Object.entries(request.headers)),
							},
						}),
					)
				: Option.none<Execution>()
		if (Option.isSome(direct) && direct.value.type === "opaque") {
			const nativeBody = direct.value.response.body.pipe(
				Stream.catch((error) =>
					Stream.succeed(
						new TextEncoder().encode(
							nativeErrorFrame(
								error instanceof Error ? error.message : "Upstream stream failed",
							),
						),
					),
				),
			)
			return HttpServerResponse.stream(nativeBody, {
				status: direct.value.response.status,
				headers: direct.value.response.headers,
				contentType: direct.value.response.headers["content-type"],
			})
		}
		const converted = yield* Effect.fromResult(toResponseRequest(body))
		if (converted.stream) {
			const execution = Option.isSome(direct)
				? direct.value
				: yield* router.invoke({ type: "generation", request: converted })
			if (execution.type !== "generation")
				return yield* Effect.fail(
					RouterError.cases.InvalidResponse.make({
						message: "Expected generation events",
					}),
				)
			const events = execution.events
			return HttpServerResponse.stream(
				projection.encodeEvents!(events, { model: converted.model }).pipe(
					Stream.encodeText,
				),
				{
					headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
					contentType: "text/event-stream; charset=utf-8",
				},
			)
		}
		const execution = yield* router.invoke({ type: "generation", request: converted })
		if (execution.type !== "generation")
			return yield* Effect.fail(
				RouterError.cases.InvalidResponse.make({ message: "Expected generation events" }),
			)
		const response = yield* completeGeneration(execution.events)
		const projected = yield* Effect.fromResult(
			Result.mapError(
				Schema.decodeUnknownResult(Response)({ ...response, model: converted.model }),
				(error) => fromSchema(error, "response"),
			),
		).pipe(
			Effect.mapError((error) =>
				RouterError.cases.InvalidResponse.make({ message: error.message }),
			),
		)
		return HttpServerResponse.jsonUnsafe(projected)
	}).pipe(Effect.catch((error) => Effect.succeed(onError(error))))

export function make(options: OpenAIResponsesHttpOptions): HttpContribution<typeof api> {
	return {
		api,
		routes: (router) =>
			HttpApiBuilder.layer(api).pipe(
				Layer.provide(
					HttpApiBuilder.group(api, "openAIResponses", (handlers) =>
						handlers.handleRaw("create", ({ request }) =>
							handle(router, request, options.gatewayKey),
						),
					),
				),
			),
	}
}
