import { Effect, Layer, Redacted, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpApiBuilder } from "effect/http-api"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { Service as RouteService } from "@better-router/core/Route"
import { Route as RouteTag } from "@better-router/core/Route"
import * as CoreHttpApi from "@better-router/core/HttpApi"
import * as Generation from "@better-router/core/Generation"
import { api, Error as ApiError } from "./Api.js"
import { decodeRequest, encodeEvent, encodeResponse, encodeStream } from "./Convert.js"

export interface Options {
	readonly gatewayKey?: Redacted.Redacted<string> | undefined
	readonly maxBodyBytes?: number | undefined
}

const frame = (event: Generation.Event | "[DONE]"): string =>
	Sse.encoder.write({
		_tag: "Event",
		event: event === "[DONE]" ? "message" : event.type,
		id: undefined,
		data: event === "[DONE]" ? event : JSON.stringify(event),
	})

/** Convert a router/provider failure to the HTTP status exposed by Responses. */
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
			error: {
				message,
				type,
				...(param === undefined ? {} : { param }),
			},
		}),
		{ status },
	)

const errorEvent = (error: unknown, sequence: number): Generation.Event => ({
	type: "error",
	sequence_number: sequence,
	error: {
		message: messageForError(error),
		type: "upstream_error",
		code: null,
		param: CoreHttpApi.paramForError(error) ?? null,
	},
})

type StreamEntry =
	| { readonly type: "event"; readonly event: Generation.Event }
	| { readonly type: "error"; readonly error: unknown }
	| { readonly type: "done" }

const bodyStream = <E, R>(events: Stream.Stream<Generation.Event, E, R>) => {
	const source: Stream.Stream<StreamEntry, never, R> = Stream.concat(
		encodeStream(events).pipe(Stream.map((event): StreamEntry => ({ type: "event", event }))),
		Stream.succeed<StreamEntry>({ type: "done" }),
	).pipe(
		Stream.catch((error) => Stream.succeed<StreamEntry>({ type: "error", error })),
		Stream.catchDefect((error) => Stream.succeed<StreamEntry>({ type: "error", error })),
	)
	return source.pipe(
		Stream.mapAccumEffect(
			() => 0,
			(sequence, entry) =>
				entry.type === "event"
					? Effect.succeed([
							Math.max(sequence, entry.event.sequence_number + 1),
							[frame(entry.event)],
						] as const)
					: entry.type === "done"
						? Effect.succeed([sequence, [frame("[DONE]")]] as const)
						: Effect.fromResult(encodeEvent(errorEvent(entry.error, sequence))).pipe(
								Effect.map((event) => [sequence + 1, [frame(event)]] as const),
							),
		),
		Stream.encodeText,
	)
}

export const handle = (
	route: RouteService,
	request: HttpServerRequest.HttpServerRequest,
	options: Options,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
	Effect.gen(function* () {
		if (
			options.gatewayKey &&
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
			const body = bodyStream(process.events).pipe(Stream.ensuring(process.cancel))
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

export const layer = (
	options: Options = {},
): Layer.Layer<
	never,
	never,
	CoreHttpApi.HttpHostServices | HttpRouter.Request<"Requires", RouteTag>
> =>
	HttpApiBuilder.layer(api).pipe(
		Layer.provide(
			HttpApiBuilder.group(api, "openAIResponses", (handlers) =>
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
