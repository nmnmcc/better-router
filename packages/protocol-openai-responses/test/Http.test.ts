import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Redacted, Ref, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import type { Scope } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { GenerationEvent, GenerationResponse } from "@better-router/core/Generation"
import type { Process } from "@better-router/core/GenerationProcess"
import * as GenerationProcess from "@better-router/core/GenerationProcess"
import { Error as ProviderError } from "@better-router/core/Provider"
import type { Service as RouteService } from "@better-router/core/Route"
import { Route as RouteTag, UnknownModel } from "@better-router/core/Route"
import { api, Http, makeHttpContribution } from "@better-router/protocol-openai-responses"
import {
	Error as WireError,
	Event as WireEvent,
	Response as WireResponse,
} from "@better-router/protocol-openai-responses/Api"

const response = (status: "completed" | "in_progress" = "completed"): GenerationResponse => ({
	id: "response_1",
	object: "response",
	created_at: 1,
	completed_at: status === "completed" ? 2 : null,
	status,
	incomplete_details: null,
	model: "public",
	previous_response_id: null,
	instructions: null,
	output:
		status === "completed"
			? [
					{
						type: "message",
						id: "message_1",
						status: "completed",
						role: "assistant",
						content: [{ type: "output_text", text: "Hi", annotations: [] }],
					},
				]
			: [],
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
		input_tokens: 2,
		output_tokens: 1,
		total_tokens: 3,
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
})

const completed: GenerationEvent = {
	type: "response.completed",
	sequence_number: 1,
	response: response(),
}

const created: GenerationEvent = {
	type: "response.created",
	sequence_number: 0,
	response: response("in_progress"),
}

const processFor = <E>(
	events: Stream.Stream<GenerationEvent, E>,
	cancelled: Ref.Ref<number>,
): Effect.Effect<Process<unknown, never>> =>
	Effect.gen(function* () {
		const process = yield* GenerationProcess.Process.make(events)
		return {
			...process,
			cancel: Effect.andThen(
				process.cancel,
				Ref.update(cancelled, (value) => value + 1),
			),
		}
	})

const request = (
	body: unknown,
	headers: Readonly<Record<string, string>> = {},
): HttpServerRequest.HttpServerRequest =>
	HttpServerRequest.fromWeb(
		new Request("http://gateway/v1/responses", {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	)

const run = (
	route: RouteService,
	body: unknown,
	options: Http.Options = {},
	headers: Readonly<Record<string, string>> = {},
): Effect.Effect<Response, unknown, Scope.Scope> =>
	Effect.gen(function* () {
		const handler = yield* HttpRouter.toHttpEffect(
			Http.layer(options).pipe(HttpRouter.provideRequest(Layer.succeed(RouteTag, route))),
		).pipe(Effect.provide(HttpServer.layerServices))
		const responseValue = yield* Effect.provideService(
			handler,
			HttpServerRequest.HttpServerRequest,
			request(body, headers),
		)
		return HttpServerResponse.toWeb(responseValue)
	}) as Effect.Effect<Response, unknown, Scope.Scope>

const readError = (webResponse: Response) =>
	Effect.promise(() => webResponse.text()).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(WireError))),
	)

const readResponse = (webResponse: Response) =>
	Effect.promise(() => webResponse.text()).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(WireResponse))),
	)

const readEvents = (webResponse: Response) =>
	Effect.promise(() => webResponse.text()).pipe(
		Effect.flatMap((text) =>
			Stream.succeed(text).pipe(
				Stream.pipeThroughChannel(Sse.decodeDataSchema(WireEvent)),
				Stream.runCollect,
			),
		),
	)

it("exposes one schema-backed HTTP contribution", () => {
	const contribution = makeHttpContribution()
	assert.equal(contribution.api, api)
})

it("maps shared failures to stable Responses statuses and messages", () => {
	const rateLimited = ProviderError.make({
		kind: "rate_limited",
		message: "slow down",
		retryable: true,
	})
	assert.equal(Http.statusForError(rateLimited), 429)
	assert.equal(Http.messageForError(rateLimited), "slow down")

	const unknownModel = UnknownModel.make({ model: "missing" })
	assert.equal(Http.statusForError(unknownModel), 404)
	assert.equal(Http.messageForError(unknownModel), "Unknown model: missing")
})

it.effect("authenticates before reading or invoking the route", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const route: RouteService = {
			generate: () =>
				Ref.update(calls, (value) => value + 1).pipe(
					Effect.andThen(Effect.die("route must not run")),
				),
		}
		const webResponse = yield* run(route, "not-json", { gatewayKey: Redacted.make("secret") })
		assert.equal(webResponse.status, 401)
		assert.equal(yield* Ref.get(calls), 0)
		const body = yield* readError(webResponse)
		assert.deepEqual(body, {
			error: { message: "Authentication failed", type: "authentication_error" },
		})
	}),
)

it.effect("returns nested Schema conversion paths without invoking the route", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const route: RouteService = {
			generate: () =>
				Ref.update(calls, (value) => value + 1).pipe(
					Effect.andThen(Effect.die("route must not run")),
				),
		}
		const webResponse = yield* run(route, {
			model: "public",
			input: [
				{
					type: "message",
					role: "user",
					content: [{ type: "input_text", text: 42 }],
				},
			],
		})
		assert.equal(webResponse.status, 400)
		assert.equal(yield* Ref.get(calls), 0)
		const body = yield* readError(webResponse)
		assert.equal(body.error.param, "request.input[0].content[0].text")
	}),
)

it.effect("returns a stable invalid JSON message after authentication", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const route: RouteService = {
			generate: () =>
				Ref.update(calls, (value) => value + 1).pipe(
					Effect.andThen(Effect.die("route must not run")),
				),
		}
		const webResponse = yield* run(
			route,
			"{",
			{ gatewayKey: Redacted.make("secret") },
			{ authorization: "Bearer secret" },
		)
		assert.equal(webResponse.status, 400)
		assert.equal((yield* readError(webResponse)).error.message, "Invalid JSON body")
		assert.equal(yield* Ref.get(calls), 0)
	}),
)

it.effect("rejects an oversized valid JSON body before invoking the route", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const route: RouteService = {
			generate: () =>
				Ref.update(calls, (value) => value + 1).pipe(
					Effect.andThen(Effect.die("route must not run")),
				),
		}
		const body = JSON.stringify({ model: "public", input: "a valid but oversized body" })
		const webResponse = yield* run(route, body, { maxBodyBytes: body.length - 1 })
		assert.equal(webResponse.status, 413)
		assert.deepEqual(yield* readError(webResponse), {
			error: { message: "Request body too large", type: "invalid_request_error" },
		})
		assert.equal(yield* Ref.get(calls), 0)
	}),
)

it.effect("rejects an unsupported top-level request parameter before invoking the route", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const route: RouteService = {
			generate: () =>
				Ref.update(calls, (value) => value + 1).pipe(
					Effect.andThen(Effect.die("route must not run")),
				),
		}
		const webResponse = yield* run(route, {
			model: "public",
			input: "Hello",
			unexpected: true,
		})
		assert.equal(webResponse.status, 422)
		const body = yield* readError(webResponse)
		assert.equal(body.error.param, "request.unexpected")
		assert.equal(yield* Ref.get(calls), 0)
	}),
)

it.effect("projects a completed generation to a JSON Responses body", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const process = yield* processFor(Stream.make(created, completed), cancelled)
		const route: RouteService = {
			generate: () => Effect.succeed(process),
		}
		const webResponse = yield* run(
			route,
			{ model: "public", input: "Hello" },
			{ gatewayKey: Redacted.make("secret") },
			{ authorization: "bearer secret" },
		)
		assert.equal(webResponse.status, 200)
		assert.equal(webResponse.headers.get("content-type"), "application/json")
		const body = yield* readResponse(webResponse)
		assert.equal(body.id, "response_1")
		assert.equal(body.status, "completed")
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("maps provider failures to a JSON HTTP error", () =>
	Effect.gen(function* () {
		const route: RouteService = {
			generate: () =>
				Effect.fail(
					ProviderError.make({
						kind: "rate_limited",
						message: "slow down",
						retryable: true,
					}),
				),
		}
		const webResponse = yield* run(route, { model: "public", input: "Hello" })
		assert.equal(webResponse.status, 429)
		const body = yield* readError(webResponse)
		assert.deepEqual(body, {
			error: { message: "slow down", type: "invalid_request_error" },
		})
	}),
)

it.effect("releases the process after its JSON response fails", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const process = yield* processFor(
			Stream.fail(
				ProviderError.make({
					kind: "timeout",
					message: "upstream timed out",
					retryable: true,
				}),
			),
			cancelled,
		)
		const route: RouteService = { generate: () => Effect.succeed(process) }
		const webResponse = yield* run(route, { model: "public", input: "Hello" })
		assert.equal(webResponse.status, 504)
		assert.equal((yield* readError(webResponse)).error.message, "upstream timed out")
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("keeps response Schema paths when a JSON projection fails", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const malformed: GenerationEvent = {
			...completed,
			response: { ...response(), status: "unsupported" },
		}
		const process = yield* processFor(Stream.succeed(malformed), cancelled)
		const route: RouteService = { generate: () => Effect.succeed(process) }
		const webResponse = yield* run(route, { model: "public", input: "Hello" })
		assert.equal(webResponse.status, 422)
		const body = yield* readError(webResponse)
		assert.equal(body.error.type, "invalid_response_error")
		assert.equal(body.error.param, "response.status")
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("writes one successful SSE terminal and finalizes the process", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const process = yield* processFor(Stream.make(created, completed), cancelled)
		const route: RouteService = {
			generate: () => Effect.succeed(process),
		}
		const webResponse = yield* run(route, {
			model: "public",
			input: "Hello",
			stream: true,
		})
		assert.equal(webResponse.status, 200)
		assert.equal(webResponse.headers.get("content-type"), "text/event-stream; charset=utf-8")
		const text = yield* Effect.promise(() => webResponse.text())
		assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1)
		assert.equal(text.includes("event: error"), false)
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("turns an upstream stream failure into an error frame after headers", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const process = yield* processFor(
			Stream.fail(
				ProviderError.make({
					kind: "unavailable",
					message: "upstream unavailable",
					retryable: true,
				}),
			),
			cancelled,
		)
		const route: RouteService = {
			generate: () => Effect.succeed(process),
		}
		const webResponse = yield* run(route, {
			model: "public",
			input: "Hello",
			stream: true,
		})
		const text = yield* Effect.promise(() => webResponse.text())
		assert.equal(text.includes("event: error"), true)
		assert.equal(text.includes("upstream unavailable"), true)
		assert.equal(text.includes("data: [DONE]"), false)
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("encodes a typed SSE error event with sequence and null fields", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const process = yield* processFor(
			Stream.fail(
				ProviderError.make({
					kind: "unavailable",
					message: "upstream unavailable",
					retryable: true,
				}),
			),
			cancelled,
		)
		const route: RouteService = { generate: () => Effect.succeed(process) }
		const webResponse = yield* run(route, {
			model: "public",
			input: "Hello",
			stream: true,
		})
		const events = yield* readEvents(webResponse)
		assert.equal(events.length, 1)
		const event = events[0]
		assert.ok(event)
		assert.equal(event.event, "error")
		assert.equal(event.data.type, "error")
		if (event.data.type === "error") {
			assert.equal(event.data.sequence_number, 0)
			assert.equal(event.data.error.code, null)
			assert.equal(event.data.error.param, null)
			assert.equal(event.data.error.message, "upstream unavailable")
		}
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("numbers an emitted SSE error after the last decoded event", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const delta: GenerationEvent = {
			type: "response.output_text.delta",
			sequence_number: 9,
			item_id: "message_1",
			output_index: 0,
			content_index: 0,
			delta: "Hi",
		}
		const process = yield* processFor(
			Stream.concat(
				Stream.make({ ...created, sequence_number: 7 }, delta),
				Stream.fail(
					ProviderError.make({
						kind: "unavailable",
						message: "upstream unavailable",
						retryable: true,
						cause: { authorization: "Bearer secret" },
					}),
				),
			),
			cancelled,
		)
		const route: RouteService = { generate: () => Effect.succeed(process) }
		const webResponse = yield* run(route, {
			model: "public",
			input: "Hello",
			stream: true,
		})
		const events = yield* readEvents(webResponse)
		assert.deepEqual(
			events.map((event) => event.data.sequence_number),
			[7, 9, 10],
		)
		const event = events[2]
		assert.ok(event)
		assert.equal(event.data.type, "error")
		if (event.data.type === "error") {
			assert.equal(event.data.error.code, null)
			assert.equal(event.data.error.param, null)
			assert.equal(event.data.error.message, "upstream unavailable")
		}
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("turns an SSE encode failure into an error frame without a terminal", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const malformed: GenerationEvent = { ...completed, sequence_number: -1 }
		const process = yield* processFor(Stream.succeed(malformed), cancelled)
		const route: RouteService = {
			generate: () => Effect.succeed(process),
		}
		const webResponse = yield* run(route, {
			model: "public",
			input: "Hello",
			stream: true,
		})
		const text = yield* Effect.promise(() => webResponse.text())
		assert.equal(text.includes("event: error"), true)
		assert.equal(text.includes("data: [DONE]"), false)
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("rejects a stream without a successful semantic terminal", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const process = yield* processFor(Stream.succeed(created), cancelled)
		const route: RouteService = { generate: () => Effect.succeed(process) }
		const webResponse = yield* run(route, {
			model: "public",
			input: "Hello",
			stream: true,
		})
		const text = yield* Effect.promise(() => webResponse.text())
		assert.equal(text.includes("event: response.created"), true)
		assert.equal(text.includes("event: error"), true)
		assert.equal(text.includes("data: [DONE]"), false)
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("omits the successful SSE terminal after a failed semantic response", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const failed: GenerationEvent = {
			type: "response.failed",
			sequence_number: 1,
			response: {
				...response(),
				status: "failed",
				error: { code: "server_error", message: "upstream failed" },
			},
		}
		const process = yield* processFor(Stream.make(created, failed), cancelled)
		const route: RouteService = { generate: () => Effect.succeed(process) }
		const webResponse = yield* run(route, {
			model: "public",
			input: "Hello",
			stream: true,
		})
		const text = yield* Effect.promise(() => webResponse.text())
		assert.equal(text.includes("event: error"), true)
		assert.equal(text.includes("data: [DONE]"), false)
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("rejects terminal event and response status mismatches", () =>
	Effect.forEach(
		[
			{ ...completed, response: response("in_progress") },
			{
				...completed,
				response: {
					...response(),
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
				},
			},
			{ type: "response.incomplete", sequence_number: 1, response: response() },
			{ type: "response.failed", sequence_number: 1, response: response() },
		] satisfies readonly GenerationEvent[],
		(mismatched) =>
			Effect.gen(function* () {
				const cancelled = yield* Ref.make(0)
				const process = yield* processFor(Stream.make(created, mismatched), cancelled)
				const route: RouteService = { generate: () => Effect.succeed(process) }
				const webResponse = yield* run(route, {
					model: "public",
					input: "Hello",
					stream: true,
				})
				const events = yield* readEvents(webResponse)
				const event = events[1]
				assert.ok(event)
				assert.equal(event.data.type, "error")
				if (event.data.type === "error") {
					assert.equal(event.data.error.param, "event.response.status")
					assert.equal(event.data.sequence_number, 1)
				}
				assert.equal(yield* Ref.get(cancelled), 1)
			}),
	),
)

it.effect("rejects unknown and negative SSE event sequence values", () =>
	Effect.forEach(
		[
			{
				stream: Stream.succeed({ type: "unknown.event", sequence_number: 1 } as never),
				param: "event.type",
			},
			{
				stream: Stream.succeed({ ...completed, sequence_number: "unknown" } as never),
				param: "event.sequence_number",
			},
			{
				stream: Stream.succeed({ ...completed, sequence_number: -1 }),
				param: "event.sequence_number",
			},
		] as const,
		({ stream, param }) =>
			Effect.gen(function* () {
				const cancelled = yield* Ref.make(0)
				const process = yield* processFor(stream, cancelled)
				const route: RouteService = { generate: () => Effect.succeed(process) }
				const webResponse = yield* run(route, {
					model: "public",
					input: "Hello",
					stream: true,
				})
				const events = yield* readEvents(webResponse)
				const event = events[0]
				assert.ok(event)
				assert.equal(event.data.type, "error")
				if (event.data.type === "error") assert.equal(event.data.error.param, param)
				assert.equal(yield* Ref.get(cancelled), 1)
			}),
	),
)

it.effect("rejects repeated SSE sequence numbers", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const repeated = { ...completed, sequence_number: 0 }
		const process = yield* processFor(Stream.make(created, repeated), cancelled)
		const route: RouteService = { generate: () => Effect.succeed(process) }
		const webResponse = yield* run(route, {
			model: "public",
			input: "Hello",
			stream: true,
		})
		const events = yield* readEvents(webResponse)
		const event = events[1]
		assert.ok(event)
		assert.equal(event.data.type, "error")
		if (event.data.type === "error") {
			assert.equal(event.data.sequence_number, 1)
			assert.equal(event.data.error.param, "event.sequence_number")
		}
		assert.equal(yield* Ref.get(cancelled), 1)
	}),
)

it.effect("releases a suspended stream when the client cancels", () =>
	Effect.gen(function* () {
		const cancelled = yield* Ref.make(0)
		const started = yield* Deferred.make<void>()
		const released = yield* Ref.make(false)
		const process: Process<never, never> = {
			events: Stream.fromEffect(
				Deferred.succeed(started, void 0).pipe(Effect.andThen(Effect.never)),
			).pipe(Stream.ensuring(Ref.set(released, true))),
			response: Effect.never,
			terminal: Effect.never,
			cancel: Ref.update(cancelled, (value) => value + 1),
		}
		const route: RouteService = {
			generate: () => Effect.succeed(process),
		}
		const webResponse = yield* run(route, {
			model: "public",
			input: "Hello",
			stream: true,
		})
		const body = webResponse.body
		assert.ok(body)
		const reader = body.getReader()
		const pending = yield* Effect.promise(() => reader.read()).pipe(Effect.forkChild)
		yield* Deferred.await(started)
		yield* Effect.promise(() => reader.cancel())
		yield* Fiber.interrupt(pending)
		assert.equal(yield* Ref.get(cancelled), 1)
		assert.equal(yield* Ref.get(released), true)
	}),
)
