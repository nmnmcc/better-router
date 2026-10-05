import { Effect, Layer, Redacted, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpApiBuilder } from "effect/http-api"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Service as RouteService } from "@better-router/core/Route"
import { Route as RouteTag } from "@better-router/core/Route"
import * as CoreHttpApi from "@better-router/core/HttpApi"
import { api, Error as ApiError } from "./Api.js"
import { decodeRequest, encodeResponse, encodeStream } from "./Convert.js"

export interface Options {
	readonly gatewayKey?: Redacted.Redacted<string> | undefined
	readonly maxBodyBytes?: number | undefined
}

const frame = (event: Readonly<Record<string, unknown>>): string =>
	Sse.encoder.write({
		_tag: "Event",
		event: typeof event.type === "string" ? event.type : "message",
		id: undefined,
		data: JSON.stringify(event),
	})

/** Convert a router/provider failure to the status exposed by Messages. */
export const statusForError: (error: unknown) => number = CoreHttpApi.statusForError

/** Return the stable public message for a router/provider failure. */
export const messageForError: (error: unknown) => string = CoreHttpApi.messageForError

export const errorResponse = (
	status: number,
	message: string,
	type = "invalid_request_error",
	param?: string,
) =>
	HttpServerResponse.jsonUnsafe(
		ApiError.make({
			type: "error",
			error: {
				message,
				type,
				...(param === undefined ? {} : { param }),
			},
		}),
		{ status },
	)

const errorFrame = (error: unknown): string => {
	const param = CoreHttpApi.paramForError(error)
	return Sse.encoder.write({
		_tag: "Event",
		event: "error",
		id: undefined,
		data: JSON.stringify({
			type: "error",
			error: {
				type: "upstream_error",
				message: messageForError(error),
				...(param === undefined ? {} : { param }),
			},
		}),
	})
}

export const handle = (
	route: RouteService,
	request: HttpServerRequest.HttpServerRequest,
	options: Options,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
	Effect.gen(function* () {
		if (
			options.gatewayKey &&
			request.headers["x-api-key"] !== Redacted.value(options.gatewayKey) &&
			!CoreHttpApi.hasBearerCredential(
				request.headers.authorization,
				Redacted.value(options.gatewayKey),
			)
		)
			return errorResponse(401, "Authentication failed", "authentication_error")
		const value = yield* CoreHttpApi.readJson(request, options.maxBodyBytes).pipe(
			Effect.mapError((error) => errorResponse(error.status, error.message, error.type)),
		)
		const converted = yield* Effect.fromResult(decodeRequest(value)).pipe(
			Effect.mapError((error) =>
				errorResponse(
					error.reason === "unsupported" ? 422 : 400,
					error.message,
					"invalid_request_error",
					error.path,
				),
			),
		)
		const process = yield* route
			.generate(converted)
			.pipe(
				Effect.mapError((error) =>
					errorResponse(
						statusForError(error),
						messageForError(error),
						"invalid_request_error",
						CoreHttpApi.paramForError(error),
					),
				),
			)
		if (converted.stream) {
			const body = Stream.concat(
				encodeStream(process.events).pipe(Stream.map(frame)),
				Stream.succeed(frame({ type: "message_stop" })),
			).pipe(
				Stream.catch((error) => Stream.succeed(errorFrame(error))),
				Stream.catchDefect((error) => Stream.succeed(errorFrame(error))),
				Stream.encodeText,
				Stream.ensuring(process.cancel),
			)
			return HttpServerResponse.stream(body, {
				contentType: "text/event-stream; charset=utf-8",
				headers: {
					"cache-control": "no-cache",
					"x-accel-buffering": "no",
				},
			})
		}
		const response = yield* process.response.pipe(
			Effect.mapError((error) =>
				errorResponse(
					statusForError(error),
					messageForError(error),
					"invalid_request_error",
					CoreHttpApi.paramForError(error),
				),
			),
			Effect.ensuring(process.cancel),
		)
		const encoded = yield* Effect.fromResult(encodeResponse(response)).pipe(
			Effect.mapError((error) =>
				errorResponse(422, error.message, "invalid_response_error", error.path),
			),
		)
		return HttpServerResponse.jsonUnsafe(encoded)
	}).pipe(
		Effect.catch((error) =>
			Effect.succeed(
				HttpServerResponse.isHttpServerResponse(error)
					? error
					: errorResponse(500, "Gateway failed"),
			),
		),
		Effect.catchDefect(() => Effect.succeed(errorResponse(500, "Gateway failed"))),
	)

export const layer = (options: Options = {}) =>
	HttpApiBuilder.layer(api).pipe(
		Layer.provide(
			HttpApiBuilder.group(api, "anthropicMessages", (handlers) =>
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
