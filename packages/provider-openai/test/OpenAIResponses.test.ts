import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Redacted, Result, Schema, SchemaIssue, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import {
	Event as EventSchema,
	Request as RequestSchema,
	Response as ResponseSchema,
} from "@better-router/core/GenerationSchema"
import * as OpenAIResponses from "@better-router/provider-openai/OpenAIResponses"

const request = Schema.decodeUnknownSync(RequestSchema)({ model: "public", input: "Hello" })
const config = Schema.decodeUnknownSync(OpenAIResponses.ConfigSchema)({
	model: "gpt-test",
	apiKey: Redacted.make("secret"),
})
const response = Schema.decodeUnknownSync(ResponseSchema)({
	id: "resp_1",
	object: "response",
	created_at: 1,
	completed_at: 2,
	status: "completed",
	incomplete_details: null,
	model: "gpt-test",
	previous_response_id: null,
	instructions: null,
	output: [
		{
			type: "message",
			id: "message_1",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: "Hi", annotations: [] }],
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
const created = Schema.decodeUnknownSync(EventSchema)({
	type: "response.created",
	sequence_number: 0,
	response: { ...response, status: "in_progress", completed_at: null, output: [] },
})
const completed = Schema.decodeUnknownSync(EventSchema)({
	type: "response.completed",
	sequence_number: 1,
	response,
})
const eventWithSequence = (event: typeof created | typeof completed, sequence_number: number) =>
	Schema.decodeUnknownSync(EventSchema)({ ...event, sequence_number })
const frame = (value: unknown): string => "data: " + JSON.stringify(value) + "\n\n"
const done = "data: [DONE]\n\n"
const client = (body: string | null, status = 200, contentType = "text/event-stream") =>
	HttpClient.make((outgoing) =>
		Effect.succeed(
			HttpClientResponse.fromWeb(
				outgoing,
				new Response(body, {
					status,
					headers: { "content-type": contentType },
				}),
			),
		),
	)

it("rejects malformed provider configuration through Schema", () => {
	const result = Schema.decodeUnknownResult(OpenAIResponses.ConfigSchema)({
		model: "",
		apiKey: Redacted.make("secret"),
	})
	assert.equal(Result.isFailure(result), true)
	if (Result.isFailure(result)) {
		const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues
		assert.deepEqual(
			issues.map((issue) => issue.path),
			[["model"]],
		)
	}
})

it("encodes credentials and the private model without changing the public request", () => {
	const snapshot = JSON.stringify(request)
	const encoded = OpenAIResponses.encodeRequest(
		{
			...config,
			url: new URL("https://upstream.example/responses"),
			organization: "org_test",
		},
		request,
	)
	assert.ok(Result.isSuccess(encoded))
	assert.equal(encoded.success.url, "https://upstream.example/responses")
	assert.deepEqual(encoded.success.headers, {
		authorization: "Bearer secret",
		"content-type": "application/json",
		"openai-organization": "org_test",
	})
	assert.deepEqual(encoded.success.body, { model: "gpt-test", input: "Hello", stream: true })
	assert.equal(JSON.stringify(request), snapshot)
})

it.effect("signs the actual outgoing request and uses the deployment model", () =>
	Effect.gen(function* () {
		const upstream = HttpClient.make((outgoing) =>
			Effect.gen(function* () {
				assert.equal(outgoing.method, "POST")
				assert.equal(outgoing.url, "https://upstream.example/responses")
				assert.equal(outgoing.headers.authorization, "Bearer secret")
				assert.equal(outgoing.headers["openai-organization"], "org_test")
				assert.equal(outgoing.headers["content-type"], "application/json")
				assert.ok(outgoing.body._tag === "Uint8Array")
				const body = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Unknown),
				)(new TextDecoder().decode(outgoing.body.body)).pipe(Effect.orDie)
				assert.deepEqual(body, { model: "gpt-test", input: "Hello", stream: true })
				return HttpClientResponse.fromWeb(
					outgoing,
					new Response(JSON.stringify(response), {
						headers: { "content-type": "application/json" },
					}),
				)
			}),
		)
		const service = OpenAIResponses.makeService(
			{
				...config,
				url: new URL("https://upstream.example/responses"),
				organization: "org_test",
			},
			upstream,
		)
		const process = yield* service.generate(request)
		const result = yield* process.response
		assert.equal(result.id, "resp_1")
		assert.equal(result.usage?.total_tokens, 3)
	}),
)

it.effect("projects completed, incomplete and failed JSON responses into terminal events", () =>
	Effect.forEach(
		[
			{
				status: "completed",
				type: "response.completed",
				incomplete_details: null,
				error: null,
			},
			{
				status: "incomplete",
				type: "response.incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				error: null,
			},
			{
				status: "failed",
				type: "response.failed",
				incomplete_details: null,
				error: { code: "server_error", message: "Upstream failed" },
			},
		] as const,
		(terminal) =>
			Effect.gen(function* () {
				const fixture = Schema.decodeUnknownSync(ResponseSchema)({
					...response,
					...terminal,
				})
				const service = OpenAIResponses.makeService(
					config,
					client(JSON.stringify(fixture), 200, "application/json"),
				)
				const process = yield* service.generate(request)
				const events = yield* Stream.runCollect(process.events)
				assert.equal(events.length, 1)
				const event = events[0]
				assert.equal(event?.type, terminal.type)
				if (
					event?.type === "response.completed" ||
					event?.type === "response.incomplete" ||
					event?.type === "response.failed"
				) {
					assert.equal(event.response.status, terminal.status)
					assert.deepEqual(event.response.usage, response.usage)
					assert.deepEqual(event.response.error, terminal.error)
				}
			}),
	),
)

it.effect("rejects nonterminal or unknown JSON response statuses", () =>
	Effect.forEach(["queued", "in_progress", "bogus"], (status) =>
		Effect.gen(function* () {
			const fixture = Schema.decodeUnknownSync(ResponseSchema)({ ...response, status })
			const process = yield* OpenAIResponses.makeService(
				config,
				client(JSON.stringify(fixture), 200, "application/json"),
			).generate(request)
			const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
			assert.equal(error._tag, "ProviderError")
			assert.equal(error.kind, "unknown")
			assert.equal(error.retryable, false)
		}),
	),
)

it.effect("decodes a Responses SSE terminal with or without the optional DONE marker", () =>
	Effect.forEach(["", done], (terminator) =>
		Effect.gen(function* () {
			const service = OpenAIResponses.makeService(
				config,
				client([frame(created), frame(completed), terminator].join("")),
			)
			const process = yield* service.generate(request)
			const events = yield* Stream.runCollect(process.events)
			assert.deepEqual(
				events.map((event) => event.type),
				["response.created", "response.completed"],
			)
			assert.deepEqual(
				events.map((event) => event.sequence_number),
				[0, 1],
			)
		}),
	),
)

it.effect("reports invalid upstream JSON with its nested Schema issue path", () =>
	Effect.gen(function* () {
		const malformed = {
			...response,
			output: [
				{
					type: "message",
					id: "message_1",
					status: "completed",
					role: "assistant",
					content: [{ type: "output_text", text: 42, annotations: [] }],
				},
			],
		}
		const process = yield* OpenAIResponses.makeService(
			config,
			client(JSON.stringify(malformed), 200, "application/json"),
		).generate(request)
		const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
		assert.equal(error._tag, "ProviderError")
		assert.equal(error.kind, "unknown")
		assert.equal(error.retryable, false)
		assert.ok(Schema.isSchemaError(error.cause))
		const issues = SchemaIssue.makeFormatterStandardSchemaV1()(error.cause.issue).issues
		assert.ok(
			issues.some(
				(issue) =>
					JSON.stringify(issue.path) ===
					JSON.stringify(["output", 0, "content", 0, "text"]),
			),
		)
	}),
)

it.effect("rejects malformed, missing, duplicate and out-of-order SSE terminals", () =>
	Effect.forEach(
		[
			"data: {\n\n",
			frame({ type: "response.completed", sequence_number: "wrong", response }),
			frame(created),
			done,
			[frame(completed), frame(completed)].join(""),
			[frame(completed), frame(created)].join(""),
			[frame(completed), done, done].join(""),
		],
		(body) =>
			Effect.gen(function* () {
				const process = yield* OpenAIResponses.makeService(config, client(body)).generate(
					request,
				)
				const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
				assert.equal(error._tag, "ProviderError")
				assert.equal(error.kind, "unknown")
				assert.equal(error.retryable, false)
			}),
	),
)

it.effect("requires terminal event types to match their response status", () =>
	Effect.forEach(
		[
			{
				type: "response.completed",
				status: "failed",
				error: { code: "server_error", message: "failed" },
			},
			{ type: "response.failed", status: "completed", error: null },
			{
				type: "response.incomplete",
				status: "completed",
				error: null,
			},
		] as const,
		(mismatch) =>
			Effect.gen(function* () {
				const event = Schema.decodeUnknownSync(EventSchema)({
					type: mismatch.type,
					sequence_number: 0,
					response: {
						...response,
						status: mismatch.status,
						error: mismatch.error,
					},
				})
				const process = yield* OpenAIResponses.makeService(
					config,
					client([frame(event), done].join("")),
				).generate(request)
				const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
				assert.equal(error._tag, "ProviderError")
				assert.equal(error.kind, "unknown")
				assert.equal(error.retryable, false)
			}),
	),
)

it.effect("accepts matching completed, failed and incomplete SSE terminal snapshots", () =>
	Effect.forEach(
		[
			{
				type: "response.completed",
				status: "completed",
				error: null,
				incomplete_details: null,
			},
			{
				type: "response.failed",
				status: "failed",
				error: { code: "server_error", message: "failed" },
				incomplete_details: null,
			},
			{
				type: "response.incomplete",
				status: "incomplete",
				error: null,
				incomplete_details: { reason: "max_output_tokens" },
			},
		] as const,
		(terminal) =>
			Effect.gen(function* () {
				const event = Schema.decodeUnknownSync(EventSchema)({
					type: terminal.type,
					sequence_number: 1,
					response: {
						...response,
						status: terminal.status,
						error: terminal.error,
						incomplete_details: terminal.incomplete_details,
					},
				})
				const process = yield* OpenAIResponses.makeService(
					config,
					client([frame(created), frame(event), done].join("")),
				).generate(request)
				const events = yield* Stream.runCollect(process.events)
				assert.deepEqual(
					events.map((item) => item.type),
					["response.created", terminal.type],
				)
				const last = events.at(-1)
				assert.ok(
					last?.type === "response.completed" ||
						last?.type === "response.failed" ||
						last?.type === "response.incomplete",
				)
				assert.equal(last.response.status, terminal.status)
				assert.deepEqual(last.response.error, terminal.error)
			}),
	),
)

it.effect("rejects duplicate and backward SSE sequence numbers", () =>
	Effect.forEach(
		[
			[created, eventWithSequence(completed, 0)],
			[eventWithSequence(created, 2), eventWithSequence(completed, 1)],
		] as const,
		(events) =>
			Effect.gen(function* () {
				const process = yield* OpenAIResponses.makeService(
					config,
					client([...events.map(frame), done].join("")),
				).generate(request)
				const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
				assert.equal(error._tag, "ProviderError")
				assert.equal(error.kind, "unknown")
				assert.equal(error.retryable, false)
			}),
	),
)

it.effect("classifies status failures before reading an upstream body", () =>
	Effect.forEach(
		[
			{ status: 400, kind: "invalid_request", retryable: false },
			{ status: 401, kind: "unauthorized", retryable: false },
			{ status: 403, kind: "unauthorized", retryable: false },
			{ status: 408, kind: "timeout", retryable: true },
			{ status: 429, kind: "rate_limited", retryable: true },
			{ status: 500, kind: "unavailable", retryable: true },
			{ status: 504, kind: "timeout", retryable: true },
		] as const,
		(failure) =>
			Effect.gen(function* () {
				const error = yield* OpenAIResponses.makeService(
					config,
					client(null, failure.status),
				)
					.generate(request)
					.pipe(Effect.flip)
				assert.equal(error._tag, "ProviderError")
				assert.equal(error.kind, failure.kind)
				assert.equal(error.retryable, failure.retryable)
			}),
	),
)

it.effect("rejects malformed and truncated upstream UTF-8", () =>
	Effect.forEach([new Uint8Array([0xff]), new Uint8Array([0xc3])] as const, (body) =>
		Effect.gen(function* () {
			const upstream = HttpClient.make((outgoing) =>
				Effect.succeed(
					HttpClientResponse.fromWeb(
						outgoing,
						new Response(body, { headers: { "content-type": "text/event-stream" } }),
					),
				),
			)
			const process = yield* OpenAIResponses.makeService(config, upstream).generate(request)
			const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
			assert.equal(error._tag, "ProviderError")
			assert.equal(error.kind, "unknown")
		}),
	),
)

it.effect("aborts upstream requests immediately after status and transport failures", () =>
	Effect.forEach(["status", "transport"] as const, (mode) =>
		Effect.gen(function* () {
			const sent = yield* Deferred.make<AbortSignal>()
			const upstream = HttpClient.make((outgoing, _url, signal) =>
				Deferred.succeed(sent, signal).pipe(
					Effect.andThen(
						mode === "transport"
							? Effect.fail(
									new HttpClientError.HttpClientError({
										reason: new HttpClientError.TransportError({
											request: outgoing,
											cause: "connection refused",
										}),
									}),
								)
							: Effect.succeed(
									HttpClientResponse.fromWeb(
										outgoing,
										new Response(null, {
											status: 429,
											headers: { "content-type": "text/event-stream" },
										}),
									),
								),
					),
				),
			)
			const error = yield* OpenAIResponses.makeService(config, upstream)
				.generate(request)
				.pipe(Effect.flip, Effect.timeout("5 seconds"))
			const signal = yield* Deferred.await(sent).pipe(Effect.timeout("5 seconds"))
			assert.equal(error.kind, mode === "status" ? "rate_limited" : "unavailable")
			assert.equal(signal.aborted, true)
		}),
	),
)

it.effect("cancels an unconsumed Responses process and closes the upstream request Scope", () =>
	Effect.gen(function* () {
		const sent = yield* Deferred.make<AbortSignal>()
		const upstream = HttpClient.make((outgoing, _url, signal) =>
			Deferred.succeed(sent, signal).pipe(
				Effect.as(
					HttpClientResponse.fromWeb(
						outgoing,
						new Response([frame(created), frame(completed), done].join(""), {
							headers: { "content-type": "text/event-stream" },
						}),
					),
				),
			),
		)
		const process = yield* OpenAIResponses.makeService(config, upstream).generate(request)
		const signal = yield* Deferred.await(sent).pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, false)
		yield* process.cancel.pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, true)
		yield* process.cancel.pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, true)
	}),
)

it.effect("closes the upstream request Scope after consuming the Responses terminal event", () =>
	Effect.gen(function* () {
		const sent = yield* Deferred.make<AbortSignal>()
		const upstream = HttpClient.make((outgoing, _url, signal) =>
			Deferred.succeed(sent, signal).pipe(
				Effect.as(
					HttpClientResponse.fromWeb(
						outgoing,
						new Response(JSON.stringify(response), {
							headers: { "content-type": "application/json" },
						}),
					),
				),
			),
		)
		const process = yield* OpenAIResponses.makeService(config, upstream).generate(request)
		const signal = yield* Deferred.await(sent).pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, false)
		const result = yield* process.response.pipe(Effect.timeout("5 seconds"))
		assert.equal(result.status, "completed")
		assert.equal(signal.aborted, true)
	}),
)

it.effect("cancels a suspended upstream stream and releases its resources", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const released = yield* Deferred.make<void>()
		const bytes = Stream.concat(
			Stream.succeed(new TextEncoder().encode(frame(created))),
			Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
				Stream.drain,
				Stream.concat(Stream.never),
			),
		).pipe(Stream.ensuring(Deferred.succeed(released, undefined)))
		const upstream = HttpClient.make((outgoing) =>
			Effect.gen(function* () {
				const body = yield* Stream.toReadableStreamEffect(bytes)
				return HttpClientResponse.fromWeb(
					outgoing,
					new Response(body, {
						headers: { "content-type": "text/event-stream" },
					}),
				)
			}),
		)
		const process = yield* OpenAIResponses.makeService(config, upstream).generate(request)
		const fiber = yield* Stream.runDrain(process.events).pipe(Effect.forkChild)
		yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
		yield* process.cancel
		yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"))
		yield* Deferred.await(released).pipe(Effect.timeout("5 seconds"))
		assert.equal(yield* Deferred.isDone(released), true)
	}),
)
