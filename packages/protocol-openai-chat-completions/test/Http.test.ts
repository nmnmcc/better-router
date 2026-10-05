import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Redacted, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import * as Generation from "@better-router/core/Generation"
import { Request as GenerationRequestSchema } from "@better-router/core/GenerationSchema"
import { Error as ProviderError } from "@better-router/core/Provider"
import { InvalidRequest } from "@better-router/core/Route"
import type { Service as RouteService } from "@better-router/core/Route"
import { api, Http, makeHttpContribution } from "@better-router/protocol-openai-chat-completions"
import { Error as WireError } from "@better-router/protocol-openai-chat-completions/Api"

const response: Generation.GenerationResponse = {
	id: "chat_1",
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
	stream,
})

const request = (body: unknown, headers: Readonly<Record<string, string>> = {}) =>
	new Request("http://localhost/v1/chat/completions", {
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
			HttpRouter.add("POST", "/v1/chat/completions", (incomingRequest) =>
				Http.handle(route, incomingRequest, options),
			),
		)
		return yield* Effect.provideService(
			handler,
			HttpServerRequest.HttpServerRequest,
			HttpServerRequest.fromWeb(incoming),
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
					Schema.decodeUnknownEffect(GenerationRequestSchema)(value).pipe(
						Effect.mapError((error) => InvalidRequest.make({ message: error.message })),
						Effect.tap((parsed) =>
							Ref.update(requests, (values) => [...values, parsed]),
						),
						Effect.as(cancellable),
					),
			} satisfies RouteService,
		}
	})

const projectedResponse = Schema.fromJsonString(
	Schema.Struct({
		id: Schema.String,
		object: Schema.Literal("chat.completion"),
		model: Schema.String,
		choices: Schema.Array(
			Schema.Struct({
				message: Schema.Struct({
					role: Schema.String,
					content: Schema.NullOr(Schema.String),
				}),
				finish_reason: Schema.String,
			}),
		),
		usage: Schema.Struct({
			prompt_tokens: Schema.Number,
			completion_tokens: Schema.Number,
			total_tokens: Schema.Number,
		}),
	}),
)

const projectedChunk = Schema.fromJsonString(
	Schema.Struct({
		id: Schema.Literal("chat_1"),
		object: Schema.Literal("chat.completion.chunk"),
		created: Schema.Literal(1),
		model: Schema.Literal("public"),
		choices: Schema.Array(Schema.Struct({ finish_reason: Schema.NullOr(Schema.String) })),
		usage: Schema.optional(
			Schema.Struct({
				prompt_tokens: Schema.Number,
				completion_tokens: Schema.Number,
				total_tokens: Schema.Number,
				prompt_tokens_details: Schema.Struct({ cached_tokens: Schema.Number }),
				completion_tokens_details: Schema.Struct({ reasoning_tokens: Schema.Number }),
			}),
		),
	}),
)

it("exposes one schema-backed HTTP contribution", () => {
	const contribution = makeHttpContribution()
	assert.equal(contribution.api, api)
})

it("maps shared provider failures to stable Chat Completions statuses", () => {
	const timeout = ProviderError.make({ kind: "timeout", message: "timed out", retryable: true })
	assert.equal(Http.statusForError(timeout), 504)
	assert.equal(Http.messageForError(timeout), "timed out")
	assert.equal(Http.messageForError(new Error("sk-secret raw error")), "Gateway failed")
})

it.effect("authenticates before reading malformed JSON or invoking the route", () =>
	Effect.forEach(
		[{}, { authorization: "Bearer wrong" }],
		(headers: Readonly<Record<string, string>>) =>
			Effect.gen(function* () {
				const state = yield* fixture()
				const incoming = new Request("http://localhost/v1/chat/completions", {
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

it.effect("reports the complete nested Schema path without invoking the route", () =>
	Effect.gen(function* () {
		const state = yield* fixture()
		const result = yield* serve(
			state.route,
			request({
				model: "public",
				messages: [
					{
						role: "user",
						content: [{ type: "image_url", image_url: { url: 123 } }],
					},
				],
			}),
		)
		assert.equal(result.status, 400)
		assert.equal(
			(yield* readError(result)).error.param,
			"request.messages[0].content[0].image_url.url",
		)
		assert.deepEqual(yield* Ref.get(state.requests), [])
	}),
)

it.effect("rejects a valid oversized JSON body before invoking the route", () =>
	Effect.gen(function* () {
		const state = yield* fixture()
		const calls = yield* Ref.make(0)
		const route: RouteService = {
			generate: (value) =>
				Ref.update(calls, (count) => count + 1).pipe(
					Effect.andThen(state.route.generate(value)),
				),
		}
		const body = JSON.stringify(wireRequest())
		const result = yield* serve(route, request(wireRequest()), {
			maxBodyBytes: body.length - 1,
		})
		assert.equal(result.status, 413)
		assert.equal((yield* readError(result)).error.message, "Request body too large")
		assert.equal(yield* Ref.get(calls), 0)
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

it.effect(
	"projects an authenticated JSON request with a case-insensitive Bearer scheme and releases the completed process",
	() =>
		Effect.gen(function* () {
			const state = yield* fixture()
			const result = yield* serve(
				state.route,
				request(wireRequest(), { authorization: "bearer gateway" }),
				{
					gatewayKey: Redacted.make("gateway"),
				},
			)
			assert.equal(result.status, 200)
			assert.match(result.headers["content-type"] ?? "", /application\/json/)
			const body = yield* readText(result).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(projectedResponse)),
			)
			assert.equal(body.id, "chat_1")
			assert.equal(body.model, "public")
			assert.equal(body.choices[0]?.message.role, "assistant")
			assert.equal(body.choices[0]?.message.content, "Hello")
			assert.equal(body.choices[0]?.finish_reason, "stop")
			assert.deepEqual(body.usage, {
				prompt_tokens: 4,
				completion_tokens: 2,
				total_tokens: 6,
			})
			const seen = yield* Ref.get(state.requests)
			assert.equal(seen.length, 1)
			assert.equal(seen[0]?.model, "public")
			assert.deepEqual(seen[0]?.input, [{ type: "message", role: "user", content: "Hi" }])
			assert.equal(yield* Ref.get(state.cancellations), 1)
			assert.equal(yield* Ref.get(state.releases), 1)
		}),
)

it.effect("maps provider failures to stable HTTP statuses through the registered route", () =>
	Effect.forEach(
		[
			{ kind: "rate_limited", status: 429 },
			{ kind: "timeout", status: 504 },
			{ kind: "unavailable", status: 503 },
			{ kind: "invalid_request", status: 400 },
			{ kind: "unsupported", status: 422 },
		] as const,
		({ kind, status }) =>
			Effect.gen(function* () {
				const calls = yield* Ref.make(0)
				const error = ProviderError.make({
					kind,
					message: `provider ${kind}`,
					retryable: true,
				})
				const route: RouteService = {
					generate: () =>
						Ref.update(calls, (count) => count + 1).pipe(
							Effect.andThen(Effect.fail(error)),
						),
				}
				const result = yield* serve(route, request(wireRequest()))
				assert.equal(result.status, status)
				assert.equal((yield* readError(result)).error.message, `provider ${kind}`)
				assert.equal(yield* Ref.get(calls), 1)
			}),
	),
)

it.effect("streams projected chunks followed by exactly one successful DONE marker", () =>
	Effect.gen(function* () {
		const state = yield* fixture()
		const result = yield* serve(state.route, request(wireRequest(true)))
		assert.equal(result.status, 200)
		assert.match(result.headers["content-type"] ?? "", /text\/event-stream/)
		assert.equal(result.headers["cache-control"], "no-cache")
		assert.equal(result.headers["x-accel-buffering"], "no")
		const body = yield* readText(result)
		assert.equal(body.match(/data: \[DONE\]/g)?.length, 1)
		const chunks = yield* Effect.forEach(
			body
				.split("\n")
				.filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
				.map((line) => line.slice("data: ".length)),
			(value) => Schema.decodeUnknownEffect(projectedChunk)(value),
		)
		assert.equal(chunks.length, 3)
		assert.equal(
			chunks.some((chunk) => chunk.choices.length === 0),
			false,
		)
		assert.equal(
			chunks.some((chunk) => chunk.usage !== undefined),
			false,
		)
		assert.match(body, /"object":"chat.completion.chunk"/)
		assert.match(body, /"content":"Hello"/)
		assert.match(body, /"finish_reason":"stop"/)
		assert.equal(body.includes("event: error"), false)
		assert.ok(body.indexOf("Hello") < body.indexOf("[DONE]"))
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("emits one final usage-only chunk before the successful DONE marker when requested", () =>
	Effect.gen(function* () {
		const state = yield* fixture()
		const result = yield* serve(
			state.route,
			request({ ...wireRequest(true), stream_options: { include_usage: true } }),
		)
		assert.equal(result.status, 200)
		const body = yield* readText(result)
		const dataLines = body.split("\n").filter((line) => line.startsWith("data: "))
		assert.equal(body.match(/data: \[DONE\]/g)?.length, 1)
		assert.equal(dataLines.at(-1), "data: [DONE]")
		const chunks = yield* Effect.forEach(
			dataLines
				.filter((line) => line !== "data: [DONE]")
				.map((line) => line.slice("data: ".length)),
			(value) => Schema.decodeUnknownEffect(projectedChunk)(value),
		)
		assert.equal(chunks.length, 4)
		assert.equal(chunks.filter((chunk) => chunk.choices.length === 0).length, 1)
		assert.equal(chunks.filter((chunk) => chunk.usage !== undefined).length, 1)
		assert.equal(chunks[2]?.choices[0]?.finish_reason, "stop")
		assert.deepEqual(chunks[3]?.choices, [])
		assert.deepEqual(chunks[3]?.usage, {
			prompt_tokens: 4,
			completion_tokens: 2,
			total_tokens: 6,
			prompt_tokens_details: { cached_tokens: 0 },
			completion_tokens_details: { reasoning_tokens: 0 },
		})
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("emits an upstream error frame without a successful DONE marker after headers", () =>
	Effect.gen(function* () {
		const upstream = ProviderError.make({
			kind: "unavailable",
			message: "upstream stopped",
			retryable: true,
			cause: { authorization: "Bearer sk-secret" },
		})
		const state = yield* fixture(
			Stream.concat(Stream.make(created, delta), Stream.fail(upstream)),
		)
		const result = yield* serve(state.route, request(wireRequest(true)))
		assert.equal(result.status, 200)
		const body = yield* readText(result)
		assert.match(body, /"content":"Hello"/)
		assert.match(body, /event: error/)
		assert.match(body, /"message":"upstream stopped"/)
		assert.equal(body.includes("[DONE]"), false)
		assert.equal(body.includes("sk-secret"), false)
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("emits an encoding error frame without a successful DONE marker", () =>
	Effect.gen(function* () {
		const extension: Generation.GenerationEvent = {
			type: "acme:unrepresentable",
			sequence_number: 2,
		}
		const state = yield* fixture(Stream.make(created, delta, extension))
		const result = yield* serve(state.route, request(wireRequest(true)))
		const body = yield* readText(result)
		assert.match(body, /event: error/)
		assert.match(body, /"message":"Cannot project generation output at event.type"/)
		assert.match(body, /"param":"event.type"/)
		assert.equal(body.includes("[DONE]"), false)
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("reports a missing semantic terminal as an SSE error without DONE", () =>
	Effect.gen(function* () {
		const state = yield* fixture(Stream.make(created, delta))
		const result = yield* serve(state.route, request(wireRequest(true)))
		assert.equal(result.status, 200)
		const body = yield* readText(result)
		assert.match(body, /"content":"Hello"/)
		assert.match(body, /event: error/)
		assert.match(body, /"message":"Cannot project generation output at event.type"/)
		assert.match(body, /"param":"event.type"/)
		assert.equal(body.includes("[DONE]"), false)
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("reports a failed semantic terminal as an SSE error without DONE", () =>
	Effect.gen(function* () {
		const failed: Generation.GenerationEvent = {
			type: "response.failed",
			sequence_number: 2,
			response: {
				...response,
				status: "failed",
				error: { code: "upstream_error", message: "sk-secret provider trace" },
			},
		}
		const state = yield* fixture(Stream.make(created, delta, failed))
		const result = yield* serve(state.route, request(wireRequest(true)))
		assert.equal(result.status, 200)
		const body = yield* readText(result)
		assert.match(body, /"content":"Hello"/)
		assert.match(body, /event: error/)
		assert.match(body, /"message":"Cannot project generation output at event.response.error"/)
		assert.match(body, /"param":"event.response.error"/)
		assert.equal(body.includes("[DONE]"), false)
		assert.equal(body.includes("sk-secret"), false)
		assert.equal(yield* Ref.get(state.cancellations), 1)
		assert.equal(yield* Ref.get(state.releases), 1)
	}),
)

it.effect("cancels and releases the suspended upstream when the response consumer stops", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const state = yield* fixture(
			Stream.concat(
				Stream.make(created, delta),
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
