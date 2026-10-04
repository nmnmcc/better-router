import { Effect, Layer, Match, Redacted, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpApiBuilder } from "effect/http-api"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Service as RouteService } from "@better-router/core/Route"
import { Route as RouteTag, Error as RouteError } from "@better-router/core/Route"
import { Error as ProviderError } from "@better-router/core/Provider"
import { api, Error as ApiError } from "./Api.js"
import { decodeRequest, encodeEvent, encodeResponse } from "./Convert.js"

export interface Options {
	readonly gatewayKey?: Redacted.Redacted<string> | undefined
}

const frame = (event: Readonly<Record<string, unknown>> | "[DONE]"): string =>
	Sse.encoder.write({
		_tag: "Event",
		event: "message",
		id: undefined,
		data: event === "[DONE]" ? event : JSON.stringify(event),
	})

const errorResponse = (status: number, message: string, type = "invalid_request_error") =>
	HttpServerResponse.jsonUnsafe(ApiError.make({ error: { message, type } }), { status })

const status = (error: unknown): number =>
	Schema.is(RouteError)(error)
		? Match.value(error).pipe(
				Match.when({ _tag: "RouteUnknownModel" }, () => 404),
				Match.when({ _tag: "RouteInvalidRequest" }, () => 400),
				Match.orElse(() => 502),
			)
		: Schema.is(ProviderError)(error)
			? Match.value(error.kind).pipe(
					Match.when("rate_limited", () => 429),
					Match.when("timeout", () => 504),
					Match.when("unavailable", () => 503),
					Match.when("invalid_request", () => 400),
					Match.when("unsupported", () => 422),
					Match.orElse(() => 502),
				)
			: 500

const message = (error: unknown): string =>
	Schema.is(RouteError)(error)
		? Match.value(error).pipe(
				Match.when({ _tag: "RouteUnknownModel" }, ({ model }) => `Unknown model: ${model}`),
				Match.when({ _tag: "RouteInvalidRequest" }, ({ message: value }) => value),
				Match.orElse(() => "Route failed"),
			)
		: Schema.is(ProviderError)(error)
			? error.message
			: error instanceof Error
				? error.message
				: "Gateway failed"

const handle = (
	route: RouteService,
	request: HttpServerRequest.HttpServerRequest,
	options: Options,
) =>
	Effect.gen(function* () {
		if (
			options.gatewayKey &&
			request.headers.authorization !== `Bearer ${Redacted.value(options.gatewayKey)}`
		)
			return errorResponse(401, "Authentication failed", "authentication_error")
		const value = yield* request.json.pipe(
			Effect.mapError((cause) => errorResponse(400, String(cause))),
		)
		const converted = yield* Effect.fromResult(decodeRequest(value)).pipe(
			Effect.mapError((error) =>
				errorResponse(error.reason === "unsupported" ? 422 : 400, error.message),
			),
		)
		const process = yield* route
			.generate(converted)
			.pipe(Effect.mapError((error) => errorResponse(status(error), message(error))))
		if (converted.stream) {
			const body = Stream.concat(
				process.events.pipe(
					Stream.mapEffect((event) =>
						Effect.fromResult(encodeEvent(event)).pipe(Effect.map(frame)),
					),
				),
				Stream.succeed(frame("[DONE]")),
			).pipe(Stream.encodeText, Stream.ensuring(process.cancel))
			return HttpServerResponse.stream(body, {
				contentType: "text/event-stream; charset=utf-8",
				headers: { "cache-control": "no-cache" },
			})
		}
		const response = yield* process.response.pipe(
			Effect.mapError((error) => errorResponse(status(error), message(error))),
			Effect.ensuring(process.cancel),
		)
		const encoded = yield* Effect.fromResult(encodeResponse(response)).pipe(
			Effect.mapError((error) => errorResponse(422, error.message)),
		)
		return HttpServerResponse.jsonUnsafe(encoded)
	}).pipe(Effect.catch((error) => Effect.succeed(error as HttpServerResponse.HttpServerResponse)))

export const layer = (options: Options = {}) =>
	HttpApiBuilder.layer(api).pipe(
		Layer.provide(
			HttpApiBuilder.group(api, "openAIChatCompletions", (handlers) =>
				handlers.handleRaw("create", ({ request }) =>
					Effect.gen(function* () {
						const route = yield* RouteTag
						return yield* handle(route, request, options)
					}),
				),
			),
		),
	)

export { api }
