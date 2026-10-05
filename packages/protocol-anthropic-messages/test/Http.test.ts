import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Redacted, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { Sse } from "effect/encoding"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Generation from "@better-router/core/Generation"
import { Request as GenerationRequestSchema } from "@better-router/core/GenerationSchema"
import { Error as ProviderError } from "@better-router/core/Provider"
import { InvalidRequest } from "@better-router/core/Route"
import type { Service as RouteService } from "@better-router/core/Route"
import { api, Http, makeHttpContribution } from "@better-router/protocol-anthropic-messages"
import { Error as WireError } from "@better-router/protocol-anthropic-messages/Api"

const response: Generation.GenerationResponse = {
	id: "response_1",
	object: "response",
	created_at: 1,
	completed_at: 2,
	status: "completed",
	incomplete_details: null,
	model: "public",
	previous_response_id: null,
	instructions: null,
	output: [
		{
			type: "message",
			id: "message_1",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: "Hello", annotations: [] }],
		},
	],
	error: null,
	tools: [],
	tool_choice: "auto",
	truncation: "disabled",
	parallel_tool_calls: true,
	text: { format: { type: "text" } },
	top_p: 1,
	presence_penalty: 0,
	frequency_penalty: 0,
	top_logprobs: 0,
	temperature: 1,
	reasoning: null,
	usage: {
		input_tokens: 4,
		output_tokens: 2,
		total_tokens: 6,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens_details: { reasoning_tokens: 0 },
	},
	max_output_tokens: null,
	max_tool_calls: null,
	store: false,
	background: false,
	service_tier: "default",
	metadata: null,
	safety_identifier: null,
	prompt_cache_key: null,
}

const created: Generation.GenerationEvent = {
	type: "response.created",
	sequence_number: 0,
	response: { ...response, status: "in_progress", completed_at: null, output: [], usage: null },
}

const delta: Generation.GenerationEvent = {
	type: "response.output_text.delta",
	sequence_number: 1,
	item_id: "message_1",
	output_index: 0,
	content_index: 0,
	delta: "Hello",
}

const terminal: Generation.GenerationEvent = {
	type: "response.completed",
	sequence_number: 2,
	response,
}

const wireRequest = (stream = false) => ({
	model: "public",
	messages: [{ role: "user", content: "Hi" }],
	max_tokens: 64,
	stream,
})

const deniedHeaders: readonly Readonly<Record<string, string>>[] = [
	{},
	{ "x-api-key": "wrong" },
	{ authorization: "Bearer wrong" },
]

const allowedHeaders: readonly Readonly<Record<string, string>>[] = [
	{ "x-api-key": "gateway" },
	{ authorization: "Bearer gateway" },
	{ authorization: "bearer gateway" },
]

const request = (body: unknown, headers: Readonly<Record<string, string>> = {}) =>
	new Request("http://localhost/v1/messages", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	})

const serve = (
	route: RouteService,
	incoming: Request,
	options: Http.Options = {},
): Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, Scope.Scope> =>
	Effect.gen(function* () {
		const handler = yield* HttpRouter.toHttpEffect(
			HttpRouter.add("POST", "/v1/messages", (incomingRequest) =>
				Http.handle(route, incomingRequest, options),
			),
		)
		return yield* handler.pipe(
			Effect.provideService(
				HttpServerRequest.HttpServerRequest,
				HttpServerRequest.fromWeb(incoming),
			),
		)
	})

const readText = (value: HttpServerResponse.HttpServerResponse) =>
	Effect.promise(() => HttpServerResponse.toWeb(value).text())

const readError = (value: HttpServerResponse.HttpServerResponse) =>
	readText(value).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(WireError))),
	)

const fixture = (
	events: Stream.Stream<Generation.GenerationEvent, unknown> = Stream.make(
		created,
		delta,
		terminal,
	),
) =>
	Effect.gen(function* () {
		const requests = yield* Ref.make<readonly Generation.GenerationRequest[]>([])
		const cancellations = yield* Ref.make(0)
		const releases = yield* Ref.make(0)
		const process = yield* Generation.Process.make(
			events.pipe(Stream.ensuring(Ref.update(releases, (count) => count + 1))),
		)
		const cancellable = {
			...process,
			cancel: Ref.update(cancellations, (count) => count + 1).pipe(
				Effect.andThen(process.cancel),
			),
		}
		return {
			requests,
			cancellations,
			releases,
			route: {
				generate: (value) =>
					Schema.decodeUnknownEffect(GenerationRequestSchema)(value, {
						onExcessProperty: "error",
					}).pipe(
						Effect.mapError((error) => InvalidRequest.make({ message: error.message })),
						Effect.flatMap((parsed) =>
							Ref.update(requests, (values) => [...values, parsed]).pipe(
								Effect.as(cancellable),
							),
						),
					),
			} satisfies RouteService,
		}
	})

const projectedResponse = Schema.fromJsonString(
	Schema.Struct({
		id: Schema.String,
		type: Schema.Literal("message"),
		role: Schema.Literal("assistant"),
		model: Schema.String,
		content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
		stop_reason: Schema.String,
		stop_sequence: Schema.Null,
		usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
	}),
)

const streamPayload = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("message_start"),
		message: Schema.Struct({
			id: Schema.String,
			type: Schema.Literal("message"),
			role: Schema.Literal("assistant"),
			model: Schema.String,
			content: Schema.Array(Schema.Unknown),
			stop_reason: Schema.Null,
			stop_sequence: Schema.Null,
			usage: Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number }),
		}),
	}),
	Schema.Struct({
		type: Schema.Literal("content_block_start"),
		index: Schema.Int,
		content_block: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
	}),
	Schema.Struct({
		type: Schema.Literal("content_block_delta"),
		index: Schema.Int,
		delta: Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
	}),
	Schema.Struct({ type: Schema.Literal("content_block_stop"), index: Schema.Int }),
	Schema.Struct({
		type: Schema.Literal("message_delta"),
		delta: Schema.Struct({ stop_reason: Schema.String, stop_sequence: Schema.Null }),
		usage: Schema.optional(Schema.Struct({ output_tokens: Schema.Number })),
	}),
	Schema.Struct({ type: Schema.Literal("message_stop") }),
	WireError,
])

const readFrames = (value: HttpServerResponse.HttpServerResponse) =>
	readText(value).pipe(
		Effect.flatMap((text) =>
			Stream.succeed(text).pipe(
				Stream.pipeThroughChannel(Sse.decodeDataSchema(streamPayload)),
				Stream.runCollect,
			),
		),
	)

it("exposes one schema-backed HTTP contribution", () => {
	const contribution = makeHttpContribution()
	assert.equal(contribution.api, api)
})

it.effect("authenticates before reading malformed JSON or invoking the route", () =>
	Effect.forEach(deniedHeaders, (headers) =>
		Effect.gen(function* () {
			const state = yield* fixture()
			const incoming = new Request("http://localhost/v1/messages", {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: "{",
			})
			const result = yield* serve(state.route, incoming, {
				gatewayKey: Redacted.make("gateway"),
			})
			assert.equal(result.status, 401)
			assert.equal(incoming.bodyUsed, false)
			assert.equal((yield* readError(result)).error.type, "authentication_error")
			assert.deepEqual(yield* Ref.get(state.requests), [])
			assert.equal(yield* Ref.get(state.cancellations), 0)
		}),
	),
)

it.effect("accepts API key and Bearer credentials before generating a JSON response", () =>
	Effect.forEach(allowedHeaders, (headers) =>
		Effect.gen(function* () {
			const state = yield* fixture()
			const result = yield* serve(state.route, request(wireRequest(), headers), {
				gatewayKey: Redacted.make("gateway"),
			})
			assert.equal(result.status, 200)
			const body = yield* readText(result).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(projectedResponse)),
			)
			assert.equal(body.id, "response_1")
			assert.deepEqual(body.content, [{ type: "text", text: "Hello" }])
			assert.equal(body.stop_reason, "end_turn")
			assert.deepEqual(body.usage, { input_tokens: 4, output_tokens: 2 })
			assert.deepEqual(yield* Ref.get(state.requests), [
				{
					model: "public",
					input: [{ type: "message", role: "user", content: "Hi" }],
					max_output_tokens: 64,
					stream: false,
				},
			])
			assert.equal(yield* Ref.get(state.cancellations), 1)
			assert.equal(yield* Ref.get(state.releases), 1)
		}),
	),
)

it.effect("rejects a valid JSON body above maxBodyBytes before invoking the route", () =>
	Effect.gen(function* () {
		const state = yield* fixture()
		const result = yield* serve(state.route, request(wireRequest()), {
			maxBodyBytes: 16,
		})
		assert.equal(result.status, 413)
		const error = yield* readError(result)
		assert.equal(error.error.type, "invalid_request_error")
		assert.equal(error.error.message, "Request body too large")
		assert.deepEqual(yield* Ref.get(state.requests), [])
		assert.equal(yield* Ref.get(state.cancellations), 0)
	}),
)

it.effect("rejects an unsupported top-level request parameter before invoking the route", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const state = yield* fixture()
		const route: RouteService = {
			generate: (value) =>
				Ref.update(calls, (count) => count + 1).pipe(
					Effect.andThen(state.route.generate(value)),
				),
		}
		const result = yield* serve(route, request({ ...wireRequest(), unexpected: true }))
		assert.equal(result.status, 422)
		const error = yield* readError(result)
		assert.equal(error.error.param, "request.unexpected")
		assert.equal(yield* Ref.get(calls), 0)
		assert.deepEqual(yield* Ref.get(state.requests), [])
	}),
)

it.effect("reports the complete nested Schema path without invoking the route", () =>
	Effect.gen(function* () {
		const state = yield* fixture()
		const result = yield* serve(
			state.route,
			request({
				model: "public",
				messages: [{ role: "user", content: [{ type: "text", text: 123 }] }],
				max_tokens: 64,
			}),
		)
		assert.equal(result.status, 400)
		assert.equal((yield* readError(result)).error.param, "request.messages[0].content[0].text")
		assert.deepEqual(yield* Ref.get(state.requests), [])
		assert.equal(yield* Ref.get(state.cancellations), 0)
	}),
)

it.effect("maps provider failure kinds to stable JSON statuses and messages", () =>
	Effect.forEach(
		[
			["invalid_request", 400],
			["unauthorized", 502],
			["rate_limited", 429],
			["timeout", 504],
			["unavailable", 503],
			["unsupported", 422],
			["unknown", 502],
		] as const,
		([kind, expectedStatus]) =>
			Effect.gen(function* () {
				const requests = yield* Ref.make(0)
				const failure = ProviderError.make({
					kind,
					message: `provider ${kind}`,
					retryable: false,
				})
				const route: RouteService = {
					generate: () =>
						Ref.update(requests, (count) => count + 1).pipe(
							Effect.andThen(Effect.fail(failure)),
						),
				}
				const result = yield* serve(route, request(wireRequest()))
				assert.equal(result.status, expectedStatus)
				assert.equal((yield* readError(result)).error.message, `provider ${kind}`)
				assert.equal(yield* Ref.get(requests), 1)
			}),
	),
)

it.effect("releases the process when reading its JSON response fails", () =>
	Effect.gen(function* () {
		const failure = ProviderError.make({
			kind: "unavailable",
			message: "upstream disappeared",
			retryable: true,
		})
		const state = yield* fixture(Stream.fail(failure))
		const result = yield* serve(state.route, request(wireRequest()))
		assert.equal(result.status, 503)
		assert.equal((yield* readError(result)).error.message, "upstream disappeared")
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("keeps the output path and releases resources when JSON projection fails", () =>
	Effect.gen(function* () {
		const unsupported: Generation.GenerationEvent = {
			...terminal,
			response: {
				...response,
				output: [{ type: "acme:result", id: "extension_1", status: "completed" }],
			},
		}
		const state = yield* fixture(Stream.succeed(unsupported))
		const result = yield* serve(state.route, request(wireRequest()))
		assert.equal(result.status, 422)
		const error = yield* readError(result)
		assert.equal(error.error.type, "invalid_response_error")
		assert.equal(error.error.param, "response.output[0]")
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("projects successful SSE events and emits exactly one message_stop", () =>
	Effect.gen(function* () {
		const state = yield* fixture()
		const result = yield* serve(state.route, request(wireRequest(true)))
		assert.equal(result.status, 200)
		assert.match(result.headers["content-type"] ?? "", /text\/event-stream/)
		assert.equal(result.headers["cache-control"], "no-cache")
		assert.equal(result.headers["x-accel-buffering"], "no")
		const frames = yield* readFrames(result)
		assert.deepEqual(
			frames.map((frame) => frame.event),
			[
				"message_start",
				"content_block_start",
				"content_block_delta",
				"content_block_stop",
				"message_delta",
				"message_stop",
			],
		)
		assert.equal(frames.filter((frame) => frame.data.type === "message_stop").length, 1)
		const textFrame = frames[2]
		assert.equal(textFrame?.data.type, "content_block_delta")
		if (textFrame?.data.type === "content_block_delta")
			assert.deepEqual(textFrame.data.delta, { type: "text_delta", text: "Hello" })
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("emits a typed upstream error frame and skips message_stop after stream failure", () =>
	Effect.gen(function* () {
		const failure = ProviderError.make({
			kind: "unavailable",
			message: "upstream offline",
			retryable: true,
		})
		const state = yield* fixture(
			Stream.concat(Stream.make(created, delta), Stream.fail(failure)),
		)
		const result = yield* serve(state.route, request(wireRequest(true)))
		const frames = yield* readFrames(result)
		assert.deepEqual(
			frames.map((frame) => frame.event),
			["message_start", "content_block_start", "content_block_delta", "error"],
		)
		const errorFrame = frames[3]
		assert.equal(errorFrame?.data.type, "error")
		if (errorFrame?.data.type === "error") {
			assert.equal(errorFrame.data.error.type, "upstream_error")
			assert.equal(errorFrame.data.error.message, "upstream offline")
		}
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("emits an encoding error frame and skips the subsequent success terminal", () =>
	Effect.gen(function* () {
		const unsupported: Generation.GenerationEvent = {
			type: "acme:unrepresentable",
			sequence_number: 1,
		}
		const state = yield* fixture(Stream.make(created, unsupported, terminal))
		const result = yield* serve(state.route, request(wireRequest(true)))
		const frames = yield* readFrames(result)
		assert.deepEqual(
			frames.map((frame) => frame.event),
			["message_start", "error"],
		)
		const errorFrame = frames[1]
		assert.equal(errorFrame?.data.type, "error")
		if (errorFrame?.data.type === "error") {
			assert.equal(errorFrame.data.error.type, "upstream_error")
			assert.equal(
				errorFrame.data.error.message,
				"Cannot project generation output at event.type",
			)
			assert.equal(errorFrame.data.error.param, "event.type")
		}
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("emits an error frame when the semantic stream ends without a terminal response", () =>
	Effect.gen(function* () {
		const state = yield* fixture(Stream.make(created, delta))
		const result = yield* serve(state.route, request(wireRequest(true)))
		const frames = yield* readFrames(result)
		assert.deepEqual(
			frames.map((frame) => frame.event),
			["message_start", "content_block_start", "content_block_delta", "error"],
		)
		const errorFrame = frames[3]
		assert.equal(errorFrame?.data.type, "error")
		if (errorFrame?.data.type === "error") {
			assert.equal(errorFrame.data.error.type, "upstream_error")
			assert.equal(
				errorFrame.data.error.message,
				"Cannot project generation output at event.type",
			)
			assert.equal(errorFrame.data.error.param, "event.type")
		}
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("emits an error frame for a failed terminal and omits successful terminal frames", () =>
	Effect.gen(function* () {
		const failed: Generation.GenerationEvent = {
			type: "response.failed",
			sequence_number: 2,
			response: {
				...response,
				status: "failed",
				error: { code: "upstream_failed", message: "internal provider failure" },
			},
		}
		const state = yield* fixture(Stream.make(created, delta, failed))
		const result = yield* serve(state.route, request(wireRequest(true)))
		const frames = yield* readFrames(result)
		assert.deepEqual(
			frames.map((frame) => frame.event),
			["message_start", "content_block_start", "content_block_delta", "error"],
		)
		const errorFrame = frames[3]
		assert.equal(errorFrame?.data.type, "error")
		if (errorFrame?.data.type === "error") {
			assert.equal(errorFrame.data.error.type, "upstream_error")
			assert.equal(
				errorFrame.data.error.message,
				"Cannot project generation output at event.response.error",
			)
			assert.equal(errorFrame.data.error.param, "event.response.error")
		}
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("cancels and releases the upstream when the client stops reading SSE", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const state = yield* fixture(
			Stream.concat(
				Stream.succeed(created),
				Stream.fromEffect(
					Deferred.succeed(started, void 0).pipe(Effect.andThen(Effect.never)),
				),
			),
		)
		const result = yield* serve(state.route, request(wireRequest(true)))
		assert.equal(result.body._tag, "Stream")
		if (result.body._tag !== "Stream") return yield* Effect.die("Expected an SSE stream")
		const consumer = yield* result.body.stream.pipe(Stream.runDrain, Effect.forkChild)
		yield* Deferred.await(started)
		yield* Fiber.interrupt(consumer)
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
		const exit = yield* Fiber.await(consumer)
		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) assert.equal(Cause.hasInterruptsOnly(exit.cause), true)
	}),
)
