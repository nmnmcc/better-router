import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Redacted, Result, Schema, SchemaIssue, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import {
	Request as RequestSchema,
	Response as ResponseSchema,
} from "@better-router/core/GenerationSchema"
import * as Anthropic from "@better-router/provider-anthropic/AnthropicMessages"
import { fromNative } from "@better-router/provider-anthropic/GenerationAssembler"
import type { NativeChunk } from "@better-router/provider-anthropic/GenerationAssembler"

const request = Schema.decodeUnknownSync(RequestSchema)({ model: "public", input: "Hello" })
const config = Schema.decodeUnknownSync(Anthropic.ConfigSchema)({
	model: "claude-test",
	apiKey: Redacted.make("secret"),
	defaultMaxTokens: 256,
})
const frame = (value: unknown): string => "data: " + JSON.stringify(value) + "\n\n"
const started = frame({ type: "message_start", message: { id: "msg_1", model: "claude-test" } })
const stopped = frame({ type: "message_stop" })
const finish = (stop_reason = "end_turn") =>
	frame({
		type: "message_delta",
		delta: { stop_reason },
		usage: { input_tokens: 3, output_tokens: 2 },
	})
const text = frame({
	type: "content_block_delta",
	index: 0,
	delta: { type: "text_delta", text: "Hi" },
})
const toolSse = [
	started,
	frame({
		type: "content_block_start",
		index: 0,
		content_block: { type: "tool_use", id: "call_1", name: "lookup" },
	}),
	frame({
		type: "content_block_delta",
		index: 0,
		delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
	}),
	finish("tool_use"),
	stopped,
].join("")
const client = (body: string | null, status = 200, contentType = "text/event-stream") =>
	HttpClient.make((outgoing) =>
		Effect.succeed(
			HttpClientResponse.fromWeb(
				outgoing,
				new Response(body, { status, headers: { "content-type": contentType } }),
			),
		),
	)

it("encodes Anthropic headers, tool semantics and token limits without mutating input", () => {
	const input = Schema.decodeUnknownSync(RequestSchema)({
		...request,
		instructions: "Be brief",
		max_output_tokens: 64,
		tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
		tool_choice: { type: "function", name: "lookup" },
		parallel_tool_calls: false,
	})
	const snapshot = JSON.stringify(input)
	const encoded = Anthropic.encodeRequest({ ...config, version: "2023-06-01" }, input)
	assert.ok(Result.isSuccess(encoded))
	assert.equal(encoded.success.url, "https://api.anthropic.com/v1/messages")
	assert.deepEqual(encoded.success.headers, {
		"x-api-key": "secret",
		"content-type": "application/json",
		"anthropic-version": "2023-06-01",
	})
	assert.deepEqual(encoded.success.body, {
		model: "claude-test",
		max_tokens: 64,
		messages: [{ role: "user", content: "Hello" }],
		stream: true,
		system: "Be brief",
		tools: [{ name: "lookup", input_schema: { type: "object" } }],
		tool_choice: { type: "tool", name: "lookup", disable_parallel_tool_use: true },
	})
	assert.equal(JSON.stringify(input), snapshot)
})

it.effect("signs the actual transport request using deployment credentials and max tokens", () =>
	Effect.gen(function* () {
		const upstream = HttpClient.make((outgoing) =>
			Effect.gen(function* () {
				assert.equal(outgoing.method, "POST")
				assert.equal(outgoing.url, "https://upstream.example/messages")
				assert.equal(outgoing.headers["x-api-key"], "secret")
				assert.equal(outgoing.headers["anthropic-version"], "2023-06-01")
				assert.equal(outgoing.headers.authorization, undefined)
				assert.ok(outgoing.body._tag === "Uint8Array")
				const body = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Unknown),
				)(new TextDecoder().decode(outgoing.body.body)).pipe(Effect.orDie)
				assert.deepEqual(body, {
					model: "claude-test",
					max_tokens: 256,
					messages: [{ role: "user", content: "Hello" }],
					stream: true,
				})
				return HttpClientResponse.fromWeb(
					outgoing,
					new Response([started, text, finish(), stopped].join(""), {
						headers: { "content-type": "text/event-stream" },
					}),
				)
			}),
		)
		const process = yield* Anthropic.makeService(
			{
				...config,
				url: new URL("https://upstream.example/messages"),
			},
			upstream,
		).generate(request)
		const response = yield* process.response
		assert.equal(response.id, "msg_1")
		assert.equal(response.model, "claude-test")
		assert.equal(response.usage?.total_tokens, 5)
	}),
)

it("rejects unportable semantics through the pure request encoder", () => {
	const encoded = Anthropic.encodeRequest(
		config,
		Schema.decodeUnknownSync(RequestSchema)({
			...request,
			previous_response_id: "resp_previous",
		}),
	)
	assert.ok(Result.isFailure(encoded))
	assert.equal(encoded.failure.kind, "unsupported")
	assert.equal(encoded.failure.retryable, false)
})

it.effect("assembles Anthropic tool input deltas and usage into one terminal response", () =>
	Effect.gen(function* () {
		const process = yield* Anthropic.makeService(config, client(toolSse)).generate(
			Schema.decodeUnknownSync(RequestSchema)({
				model: "public",
				input: "Use the lookup tool",
				tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
			}),
		)
		const events = yield* Stream.runCollect(process.events)
		assert.deepEqual(
			events.map((event) => event.sequence_number),
			events.map((_, index) => index),
		)
		const terminal = events.at(-1)
		assert.equal(terminal?.type, "response.completed")
		if (terminal?.type === "response.completed") {
			const response = yield* Schema.decodeUnknownEffect(ResponseSchema)(terminal.response)
			assert.equal(response.usage?.input_tokens, 3)
			assert.equal(response.usage?.output_tokens, 2)
			assert.equal(response.output[0]?.type, "function_call")
			assert.equal(
				response.output[0]?.type === "function_call"
					? response.output[0].arguments
					: undefined,
				'{"city":"Paris"}',
			)
		}
		assert.equal(events.filter((event) => event.type === "response.completed").length, 1)
	}),
)

it.effect("maps max_tokens finish reasons to an incomplete response", () =>
	Effect.gen(function* () {
		const process = yield* Anthropic.makeService(
			config,
			client([started, text, finish("max_tokens"), stopped].join("")),
		).generate(request)
		const response = yield* process.response
		assert.equal(response.status, "incomplete")
		assert.equal(response.incomplete_details?.reason, "length")
		assert.equal(response.usage?.total_tokens, 5)
	}),
)

it.effect("maps an Anthropic overloaded error event to a retryable provider failure", () =>
	Effect.gen(function* () {
		const body = [
			started,
			frame({ type: "error", error: { type: "overloaded_error", message: "busy" } }),
		].join("")
		const process = yield* Anthropic.makeService(config, client(body)).generate(request)
		const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
		assert.equal(error._tag, "ProviderError")
		assert.equal(error.kind, "unavailable")
		assert.equal(error.retryable, true)
	}),
)

it.effect("allows ping events before message_start without inventing response output", () =>
	Effect.gen(function* () {
		const process = yield* Anthropic.makeService(
			config,
			client([frame({ type: "ping" }), started, text, finish(), stopped].join("")),
		).generate(request)
		const response = yield* process.response
		assert.equal(response.id, "msg_1")
		assert.equal(response.output[0]?.type, "message")
	}),
)

it.effect("preserves usage split between message_start and message_delta", () =>
	Effect.gen(function* () {
		const process = yield* Anthropic.makeService(
			config,
			client(
				[
					frame({
						type: "message_start",
						message: {
							id: "msg_1",
							model: "claude-test",
							usage: { input_tokens: 3, output_tokens: 0 },
						},
					}),
					text,
					frame({
						type: "message_delta",
						delta: { stop_reason: "end_turn" },
						usage: { output_tokens: 2 },
					}),
					stopped,
				].join(""),
			),
		).generate(request)
		const response = yield* process.response
		assert.equal(response.usage?.input_tokens, 3)
		assert.equal(response.usage?.output_tokens, 2)
		assert.equal(response.usage?.total_tokens, 5)
	}),
)

it.effect("rejects malformed tool arguments and unsupported semantics before transport", () =>
	Effect.forEach(
		[
			{
				input: [
					{
						type: "function_call",
						call_id: "call_1",
						name: "lookup",
						arguments: "not-json",
					},
				],
				kind: "invalid_request",
			},
			{ previous_response_id: "resp_previous", kind: "unsupported" },
			{ temperature: 2, kind: "invalid_request" },
		] as const,
		(invalid) =>
			Effect.gen(function* () {
				const upstream = HttpClient.make(() => Effect.die("Transport must not execute"))
				const error = yield* Anthropic.makeService(config, upstream)
					.generate(Schema.decodeUnknownSync(RequestSchema)({ ...request, ...invalid }))
					.pipe(Effect.flip)
				assert.equal(error._tag, "ProviderError")
				assert.equal(error.kind, invalid.kind)
				assert.equal(error.retryable, false)
			}),
	),
)

it.effect("rejects malformed events, missing stops, duplicate stops and events after stop", () =>
	Effect.forEach(
		[
			{ name: "malformed JSON", body: "data: {\n\n" },
			{ name: "malformed event", body: frame({ type: 42 }) },
			{ name: "missing finish", body: started },
			{ name: "missing message_stop", body: [started, text, finish()].join("") },
			{ name: "stop without a finish reason", body: [started, stopped].join("") },
			{ name: "duplicate stop", body: [started, text, finish(), stopped, stopped].join("") },
			{ name: "event after stop", body: [started, text, finish(), stopped, text].join("") },
			{ name: "output before message_start", body: [text, finish(), stopped].join("") },
			{
				name: "duplicate message_start",
				body: [started, started, text, finish(), stopped].join(""),
			},
		],
		(test) =>
			Effect.gen(function* () {
				const process = yield* Anthropic.makeService(config, client(test.body)).generate(
					request,
				)
				const result = yield* Stream.runCollect(process.events).pipe(Effect.result)
				assert.ok(Result.isFailure(result), test.name)
				const error = result.failure
				assert.equal(error._tag, "ProviderError")
				assert.equal(error.kind, "unknown")
				assert.equal(error.retryable, false)
			}),
	),
)

it.effect("preserves Schema paths for malformed Anthropic events", () =>
	Effect.gen(function* () {
		const process = yield* Anthropic.makeService(
			config,
			client(
				frame({
					type: "content_block_delta",
					index: "wrong",
					delta: { type: "text_delta", text: "Hi" },
				}),
			),
		).generate(request)
		const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
		assert.ok(Schema.isSchemaError(error.cause))
		const issues = SchemaIssue.makeFormatterStandardSchemaV1()(error.cause.issue).issues
		assert.deepEqual(
			issues.map((issue) => issue.path),
			[["index"]],
		)
	}),
)

it.effect("keeps the Anthropic assembler state independent between subscribers", () =>
	Effect.gen(function* () {
		const source = fromNative(
			request,
			Stream.fromArray<NativeChunk>([
				{ type: "start", id: "msg_1", model: "claude-test", createdAt: 1 },
				{ type: "text", value: "Hi" },
				{ type: "finish", reason: "stop" },
			]),
		)
		const first = yield* Stream.runCollect(source)
		const second = yield* Stream.runCollect(source)
		assert.deepEqual(first, second)
		assert.equal(first[0]?.sequence_number, 0)
		assert.equal(second[0]?.sequence_number, 0)
		assert.equal(second.at(-1)?.type, "response.completed")
	}),
)

it.effect("classifies upstream status failures and rejects non-SSE responses", () =>
	Effect.gen(function* () {
		yield* Effect.forEach(
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
					const error = yield* Anthropic.makeService(config, client(null, failure.status))
						.generate(request)
						.pipe(Effect.flip)
					assert.equal(error.kind, failure.kind)
					assert.equal(error.retryable, failure.retryable)
				}),
		)
		const error = yield* Anthropic.makeService(config, client("{}", 200, "application/json"))
			.generate(request)
			.pipe(Effect.flip)
		assert.equal(error.kind, "unsupported")
		assert.equal(error.retryable, false)
	}),
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
			const process = yield* Anthropic.makeService(config, upstream).generate(request)
			const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
			assert.equal(error._tag, "ProviderError")
			assert.equal(error.kind, "unknown")
		}),
	),
)

it.effect(
	"aborts upstream requests immediately after status, transport and content-type failures",
	() =>
		Effect.forEach(["status", "transport", "content-type"] as const, (mode) =>
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
												status: mode === "status" ? 429 : 200,
												headers: {
													"content-type": "application/json",
												},
											}),
										),
									),
						),
					),
				)
				const error = yield* Anthropic.makeService(config, upstream)
					.generate(request)
					.pipe(Effect.flip, Effect.timeout("5 seconds"))
				const signal = yield* Deferred.await(sent).pipe(Effect.timeout("5 seconds"))
				assert.equal(
					error.kind,
					mode === "status"
						? "rate_limited"
						: mode === "transport"
							? "unavailable"
							: "unsupported",
				)
				assert.equal(signal.aborted, true)
			}),
		),
)

it.effect("cancels an unconsumed Anthropic process and closes the upstream request Scope", () =>
	Effect.gen(function* () {
		const sent = yield* Deferred.make<AbortSignal>()
		const upstream = HttpClient.make((outgoing, _url, signal) =>
			Deferred.succeed(sent, signal).pipe(
				Effect.as(
					HttpClientResponse.fromWeb(
						outgoing,
						new Response([started, text, finish(), stopped].join(""), {
							headers: { "content-type": "text/event-stream" },
						}),
					),
				),
			),
		)
		const process = yield* Anthropic.makeService(config, upstream).generate(request)
		const signal = yield* Deferred.await(sent).pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, false)
		yield* process.cancel.pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, true)
		yield* process.cancel.pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, true)
	}),
)

it.effect("closes the upstream request Scope after consuming the Anthropic terminal event", () =>
	Effect.gen(function* () {
		const sent = yield* Deferred.make<AbortSignal>()
		const upstream = HttpClient.make((outgoing, _url, signal) =>
			Deferred.succeed(sent, signal).pipe(
				Effect.as(
					HttpClientResponse.fromWeb(
						outgoing,
						new Response([started, text, finish(), stopped].join(""), {
							headers: { "content-type": "text/event-stream" },
						}),
					),
				),
			),
		)
		const process = yield* Anthropic.makeService(config, upstream).generate(request)
		const signal = yield* Deferred.await(sent).pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, false)
		const result = yield* process.response.pipe(Effect.timeout("5 seconds"))
		assert.equal(result.status, "completed")
		assert.equal(signal.aborted, true)
	}),
)

it.effect("cancels a suspended Anthropic transport and finalizes the source stream", () =>
	Effect.gen(function* () {
		const active = yield* Deferred.make<void>()
		const released = yield* Deferred.make<void>()
		const bytes = Stream.concat(
			Stream.succeed(new TextEncoder().encode(started)),
			Stream.fromEffect(Deferred.succeed(active, undefined)).pipe(
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
		const process = yield* Anthropic.makeService(config, upstream).generate(request)
		const fiber = yield* Stream.runDrain(process.events).pipe(Effect.forkChild)
		yield* Deferred.await(active).pipe(Effect.timeout("5 seconds"))
		yield* process.cancel
		yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"))
		yield* Deferred.await(released).pipe(Effect.timeout("5 seconds"))
		assert.equal(yield* Deferred.isDone(released), true)
	}),
)
