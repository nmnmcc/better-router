import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Redacted, Result, Schema, SchemaIssue, Stream } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import {
	Request as RequestSchema,
	Response as ResponseSchema,
} from "@better-router/core/GenerationSchema"
import * as OpenAIChat from "@better-router/provider-openai/OpenAIChatCompletions"
import { fromNative } from "@better-router/provider-openai/GenerationAssembler"
import type { NativeChunk } from "@better-router/provider-openai/GenerationAssembler"

const request = Schema.decodeUnknownSync(RequestSchema)({ model: "public", input: "Hello" })
const config = Schema.decodeUnknownSync(OpenAIChat.ConfigSchema)({
	model: "gpt-test",
	apiKey: Redacted.make("secret"),
})
const frame = (value: unknown): string => "data: " + JSON.stringify(value) + "\n\n"
const chunk = (delta: unknown, finish_reason: string | null = null) => ({
	id: "chatcmpl_1",
	created: 1,
	model: "gpt-test",
	choices: [{ delta, finish_reason }],
})
const done = "data: [DONE]\n\n"
const usage = frame({
	id: "chatcmpl_1",
	created: 1,
	model: "gpt-test",
	choices: [],
	usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
})
const sse = [frame(chunk({ content: "Hi" })), frame(chunk({}, "stop")), usage, done].join("")
const client = (body: string | null, status = 200, contentType = "text/event-stream") =>
	HttpClient.make((outgoing) =>
		Effect.succeed(
			HttpClientResponse.fromWeb(
				outgoing,
				new Response(body, { status, headers: { "content-type": contentType } }),
			),
		),
	)

const expectStreamFailure = (
	body: string,
	path: readonly PropertyKey[],
	kind: "unknown" | "unsupported" = "unknown",
) =>
	Effect.gen(function* () {
		const process = yield* OpenAIChat.makeService(config, client(body)).generate(request)
		const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
		assert.equal(error._tag, "ProviderError")
		assert.equal(error.kind, kind)
		assert.equal(error.retryable, false)
		assert.ok(Schema.isSchemaError(error.cause))
		const issues = SchemaIssue.makeFormatterStandardSchemaV1()(error.cause.issue).issues
		assert.ok(issues.some((issue) => JSON.stringify(issue.path) === JSON.stringify(path)))
	})

it("encodes system, user and function options without mutating the semantic request", () => {
	const input = Schema.decodeUnknownSync(RequestSchema)({
		...request,
		instructions: "Be brief",
		tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
		tool_choice: { type: "function", name: "lookup" },
		max_output_tokens: 64,
		temperature: 0.5,
	})
	const snapshot = JSON.stringify(input)
	const encoded = OpenAIChat.encodeRequest({ ...config, organization: "org_test" }, input)
	assert.ok(Result.isSuccess(encoded))
	assert.equal(encoded.success.url, "https://api.openai.com/v1/chat/completions")
	assert.deepEqual(encoded.success.headers, {
		authorization: "Bearer secret",
		"content-type": "application/json",
		"openai-organization": "org_test",
	})
	assert.deepEqual(encoded.success.body, {
		model: "gpt-test",
		messages: [
			{ role: "system", content: "Be brief" },
			{ role: "user", content: "Hello" },
		],
		stream: true,
		stream_options: { include_usage: true },
		tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
		tool_choice: { type: "function", function: { name: "lookup" } },
		max_tokens: 64,
		temperature: 0.5,
	})
	assert.equal(JSON.stringify(input), snapshot)
})

it.effect("sends bearer and organization headers using the private model", () =>
	Effect.gen(function* () {
		const upstream = HttpClient.make((outgoing) =>
			Effect.gen(function* () {
				assert.equal(outgoing.method, "POST")
				assert.equal(outgoing.url, "https://upstream.example/chat")
				assert.equal(outgoing.headers.authorization, "Bearer secret")
				assert.equal(outgoing.headers["openai-organization"], "org_test")
				assert.ok(outgoing.body._tag === "Uint8Array")
				const body = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Schema.Unknown),
				)(new TextDecoder().decode(outgoing.body.body)).pipe(Effect.orDie)
				assert.deepEqual(body, {
					model: "gpt-test",
					messages: [{ role: "user", content: "Hello" }],
					stream: true,
					stream_options: { include_usage: true },
				})
				return HttpClientResponse.fromWeb(
					outgoing,
					new Response(sse, {
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					}),
				)
			}),
		)
		const process = yield* OpenAIChat.makeService(
			{
				...config,
				url: new URL("https://upstream.example/chat"),
				organization: "org_test",
			},
			upstream,
		).generate(request)
		const response = yield* process.response
		assert.equal(response.id, "chatcmpl_1")
		assert.equal(response.model, "gpt-test")
		assert.equal(response.usage?.total_tokens, 3)
	}),
)

it("rejects unportable semantics through the pure request encoder", () => {
	const unsupported = Schema.decodeUnknownSync(RequestSchema)({
		...request,
		previous_response_id: "resp_previous",
	})
	const encoded = OpenAIChat.encodeRequest(config, unsupported)
	assert.ok(Result.isFailure(encoded))
	assert.equal(encoded.failure.kind, "unsupported")
	assert.equal(encoded.failure.retryable, false)
})

it.effect("assembles Chat Completions SSE usage and monotonically numbered terminal events", () =>
	Effect.gen(function* () {
		const process = yield* OpenAIChat.makeService(config, client(sse)).generate(request)
		const events = yield* Stream.runCollect(process.events)
		assert.deepEqual(
			events.map((event) => event.sequence_number),
			events.map((_, index) => index),
		)
		const terminal = events.at(-1)
		assert.equal(terminal?.type, "response.completed")
		if (terminal?.type === "response.completed") {
			const response = yield* Schema.decodeUnknownEffect(ResponseSchema)(terminal.response)
			assert.equal(response.usage?.total_tokens, 3)
			const output = response.output[0]
			assert.equal(output?.type, "message")
			assert.equal(
				output?.type === "message" && output.content[0]?.type === "output_text"
					? output.content[0].text
					: undefined,
				"Hi",
			)
		}
		assert.equal(events.filter((event) => event.type === "response.completed").length, 1)
	}),
)

it.effect("assembles tool-call fragments and reports token-limited responses as incomplete", () =>
	Effect.gen(function* () {
		const toolStream = [
			frame(
				chunk({
					tool_calls: [
						{
							id: "call_1",
							index: 0,
							function: { name: "lookup", arguments: '{"city":' },
						},
					],
				}),
			),
			frame(
				chunk({
					tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }],
				}),
			),
			frame(chunk({}, "tool_calls")),
			usage,
			done,
		].join("")
		const toolProcess = yield* OpenAIChat.makeService(config, client(toolStream)).generate(
			request,
		)
		const toolResponse = yield* toolProcess.response
		const call = toolResponse.output[0]
		assert.equal(call?.type, "function_call")
		assert.equal(
			call?.type === "function_call" ? call.arguments : undefined,
			'{"city":"Paris"}',
		)
		assert.equal(call?.type === "function_call" ? call.name : undefined, "lookup")
		const limited = yield* OpenAIChat.makeService(
			config,
			client(
				[frame(chunk({ content: "Partial" })), frame(chunk({}, "length")), done].join(""),
			),
		).generate(request)
		const limitedResponse = yield* limited.response
		assert.equal(limitedResponse.status, "incomplete")
		assert.equal(limitedResponse.incomplete_details?.reason, "length")
	}),
)

it.effect("associates interleaved tool continuation fragments by their indexes", () =>
	Effect.gen(function* () {
		const interleaved = [
			frame(
				chunk({
					tool_calls: [
						{ id: "call_1", index: 0, function: { name: "one", arguments: "{" } },
						{ id: "call_2", index: 1, function: { name: "two", arguments: "[" } },
					],
				}),
			),
			frame(
				chunk({
					tool_calls: [
						{ index: 1, function: { arguments: "2]" } },
						{ index: 0, function: { arguments: '"x":1}' } },
					],
				}),
			),
			frame(chunk({}, "tool_calls")),
			usage,
			done,
		].join("")
		const process = yield* OpenAIChat.makeService(config, client(interleaved)).generate(request)
		const response = yield* process.response
		assert.deepEqual(
			response.output.map((item) =>
				item.type === "function_call"
					? { call_id: item.call_id, name: item.name, arguments: item.arguments }
					: item,
			),
			[
				{ call_id: "call_1", name: "one", arguments: '{"x":1}' },
				{ call_id: "call_2", name: "two", arguments: "[2]" },
			],
		)
	}),
)

it.effect("accepts EOF after a finish reason when the optional DONE marker is omitted", () =>
	Effect.gen(function* () {
		const process = yield* OpenAIChat.makeService(
			config,
			client([frame(chunk({ content: "Hi" })), frame(chunk({}, "stop")), usage].join("")),
		).generate(request)
		const response = yield* process.response
		assert.equal(response.status, "completed")
		assert.equal(response.usage?.total_tokens, 3)
	}),
)

it.effect("preserves nested Schema paths for malformed Chat chunks", () =>
	Effect.gen(function* () {
		const process = yield* OpenAIChat.makeService(
			config,
			client(
				frame({
					...chunk({}),
					choices: [{ delta: { content: 42 } }],
				}),
			),
		).generate(request)
		const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
		assert.ok(Schema.isSchemaError(error.cause))
		const issues = SchemaIssue.makeFormatterStandardSchemaV1()(error.cause.issue).issues
		assert.deepEqual(
			issues.map((issue) => issue.path),
			[["choices", 0, "delta", "content"]],
		)
	}),
)

it.effect("decodes role-only chunks, nullable usage and cached/reasoning token details", () =>
	Effect.gen(function* () {
		const body = [
			frame({ ...chunk({ role: "assistant", content: "" }), usage: null }),
			frame(chunk({ content: "Hi" })),
			frame(chunk({}, "stop")),
			frame({
				id: "chatcmpl_1",
				created: 1,
				model: "gpt-test",
				choices: [],
				usage: {
					prompt_tokens: 5,
					completion_tokens: 3,
					total_tokens: 8,
					prompt_tokens_details: { cached_tokens: 2 },
					completion_tokens_details: { reasoning_tokens: 1 },
				},
			}),
			done,
		].join("")
		const process = yield* OpenAIChat.makeService(config, client(body)).generate(request)
		const response = yield* process.response
		assert.equal(response.status, "completed")
		assert.equal(response.usage?.total_tokens, 8)
		assert.equal(response.usage?.input_tokens_details.cached_tokens, 2)
		assert.equal(response.usage?.output_tokens_details.reasoning_tokens, 1)
		const output = response.output[0]
		assert.equal(
			output?.type === "message" && output.content[0]?.type === "output_text"
				? output.content[0].text
				: undefined,
			"Hi",
		)
	}),
)

it.effect("keeps empty tool argument fragments and resolves continuations by index", () =>
	Effect.gen(function* () {
		const body = [
			frame(
				chunk({
					tool_calls: [
						{ index: 0, id: "__proto__", function: { name: "lookup", arguments: "" } },
					],
				}),
			),
			frame(chunk({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] })),
			frame(chunk({}, "tool_calls")),
			done,
		].join("")
		const process = yield* OpenAIChat.makeService(config, client(body)).generate(request)
		const events = yield* Stream.runCollect(process.events)
		assert.ok(
			events.some(
				(event) =>
					event.type === "response.function_call_arguments.delta" && event.delta === "",
			),
		)
		const terminal = events.at(-1)
		assert.ok(terminal?.type === "response.completed")
		const call = terminal.response.output[0]
		assert.equal(call?.type, "function_call")
		assert.equal(call?.type === "function_call" ? call.call_id : undefined, "__proto__")
		assert.equal(call?.type === "function_call" ? call.name : undefined, "lookup")
		assert.equal(call?.type === "function_call" ? call.arguments : undefined, "{}")
	}),
)

it.effect("keeps complete nested paths for malformed tool fragments and token counts", () =>
	Effect.forEach(
		[
			{
				value: chunk({
					tool_calls: [{ index: "wrong", id: "call_1", function: { name: "lookup" } }],
				}),
				path: ["choices", 0, "delta", "tool_calls", 0, "index"],
			},
			{
				value: chunk({
					tool_calls: [{ index: -1, id: "call_1", function: { name: "lookup" } }],
				}),
				path: ["choices", 0, "delta", "tool_calls", 0, "index"],
			},
			{
				value: chunk({
					tool_calls: [{ index: 0.5, id: "call_1", function: { name: "lookup" } }],
				}),
				path: ["choices", 0, "delta", "tool_calls", 0, "index"],
			},
			{
				value: chunk({ tool_calls: [{ index: 0, id: 42, function: { name: "lookup" } }] }),
				path: ["choices", 0, "delta", "tool_calls", 0, "id"],
			},
			{
				value: chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: 42 } }] }),
				path: ["choices", 0, "delta", "tool_calls", 0, "function", "name"],
			},
			{
				value: chunk({
					tool_calls: [
						{ index: 0, id: "call_1", function: { name: "lookup", arguments: {} } },
					],
				}),
				path: ["choices", 0, "delta", "tool_calls", 0, "function", "arguments"],
			},
			{
				value: chunk({ tool_calls: [{ id: "call_1", function: { name: "lookup" } }] }),
				path: ["choices", 0, "delta", "tool_calls", 0, "index"],
			},
			{
				value: {
					...chunk({}),
					usage: { prompt_tokens: "2", completion_tokens: 1, total_tokens: 3 },
				},
				path: ["usage", "prompt_tokens"],
			},
			{
				value: {
					...chunk({}),
					usage: { prompt_tokens: 2, completion_tokens: -1, total_tokens: 1 },
				},
				path: ["usage", "completion_tokens"],
			},
			{
				value: {
					...chunk({}),
					usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3.5 },
				},
				path: ["usage", "total_tokens"],
			},
			{
				value: { ...chunk({}), usage: { prompt_tokens: 2, completion_tokens: 1 } },
				path: ["usage", "total_tokens"],
			},
			{
				value: {
					...chunk({}),
					usage: {
						prompt_tokens: 2,
						completion_tokens: 1,
						total_tokens: 3,
						prompt_tokens_details: { cached_tokens: "wrong" },
					},
				},
				path: ["usage", "prompt_tokens_details", "cached_tokens"],
			},
			{
				value: {
					...chunk({}),
					usage: {
						prompt_tokens: 2,
						completion_tokens: 1,
						total_tokens: 3,
						completion_tokens_details: { reasoning_tokens: -1 },
					},
				},
				path: ["usage", "completion_tokens_details", "reasoning_tokens"],
			},
			{ value: chunk({ role: "user" }), path: ["choices", 0, "delta", "role"] },
			{ value: chunk({}, "unknown"), path: ["choices", 0, "finish_reason"] },
			{ value: { ...chunk({}), id: "" }, path: ["id"] },
			{ value: { ...chunk({}), model: "" }, path: ["model"] },
		] as const,
		(test) => expectStreamFailure(frame(test.value), test.path),
	),
)

it.effect("rejects nonfinite response timestamps before projecting any native output", () =>
	expectStreamFailure(frame(chunk({})).replace('"created":1', '"created":1e400'), ["created"]),
)

it.effect("refuses identity changes on output and final usage chunks", () =>
	Effect.forEach(
		[
			{ value: { ...chunk({ content: "other" }), id: "chatcmpl_2" }, path: ["id"] },
			{ value: { ...chunk({ content: "other" }), model: "gpt-other" }, path: ["model"] },
			{ value: { ...chunk({ content: "other" }), created: 2 }, path: ["created"] },
			{
				value: {
					id: "chatcmpl_2",
					created: 1,
					model: "gpt-test",
					choices: [],
					usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
				},
				path: ["id"],
			},
			{
				value: {
					id: "chatcmpl_1",
					created: 1,
					model: "gpt-other",
					choices: [],
					usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
				},
				path: ["model"],
			},
			{
				value: {
					id: "chatcmpl_1",
					created: 2,
					model: "gpt-test",
					choices: [],
					usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
				},
				path: ["created"],
			},
		] as const,
		(test) =>
			expectStreamFailure(
				[
					frame(chunk({ content: "Hi" })),
					frame(chunk({}, "stop")),
					frame(test.value),
					done,
				].join(""),
				test.path,
			),
	),
)

it.effect("rejects unsupported choices and semantic deltas without silently dropping output", () =>
	Effect.forEach(
		[
			{
				value: {
					...chunk({}),
					choices: [{ delta: { content: "one" } }, { delta: { content: "two" } }],
				},
				path: ["choices"],
			},
			{
				value: { ...chunk({}), choices: [{ index: 1, delta: { content: "Hi" } }] },
				path: ["choices", 0, "index"],
			},
			{ value: chunk({ refusal: "No" }), path: ["choices", 0, "delta", "refusal"] },
			{
				value: chunk({ function_call: { name: "lookup", arguments: "{}" } }),
				path: ["choices", 0, "delta", "function_call"],
			},
			{
				value: { ...chunk({}), choices: [{ delta: {}, logprobs: { content: [] } }] },
				path: ["choices", 0, "logprobs"],
			},
		] as const,
		(test) => expectStreamFailure(frame(test.value), test.path, "unsupported"),
	),
)

it.effect("rejects initial tool identity omissions and conflicting continuations", () =>
	Effect.forEach(
		[
			{
				fragments: [{ index: 0, function: { name: "lookup", arguments: "{}" } }],
				path: ["choices", 0, "delta", "tool_calls", 0, "id"],
			},
			{
				fragments: [{ index: 0, id: "call_1", function: { arguments: "{}" } }],
				path: ["choices", 0, "delta", "tool_calls", 0, "function", "name"],
			},
			{
				fragments: [
					{ index: 0, id: "call_1", function: { name: "lookup" } },
					{ index: 1, function: { arguments: "{}" } },
				],
				path: ["choices", 0, "delta", "tool_calls", 0, "id"],
			},
			{
				fragments: [
					{ index: 0, id: "call_1", function: { name: "lookup" } },
					{ index: 0, id: "call_2", function: { arguments: "{}" } },
				],
				path: ["choices", 0, "delta", "tool_calls", 0, "id"],
			},
			{
				fragments: [
					{ index: 0, id: "call_1", function: { name: "lookup" } },
					{ index: 1, id: "call_1", function: { arguments: "{}" } },
				],
				path: ["choices", 0, "delta", "tool_calls", 0, "index"],
			},
			{
				fragments: [
					{ index: 0, id: "call_1", function: { name: "lookup" } },
					{ index: 0, function: { name: "other" } },
				],
				path: ["choices", 0, "delta", "tool_calls", 0, "function", "name"],
			},
		] as const,
		(test) =>
			expectStreamFailure(
				[
					...test.fragments.map((tool) => frame(chunk({ tool_calls: [tool] }))),
					frame(chunk({}, "tool_calls")),
					done,
				].join(""),
				test.path,
			),
	),
)

it.effect("allows one final usage-only chunk and refuses all other chunks after finishing", () =>
	Effect.forEach(
		[
			{ body: [frame(chunk({})), usage, done].join(""), path: ["choices"] },
			{
				body: [frame(chunk({}, "stop")), frame(chunk({ content: "late" })), done].join(""),
				path: ["choices"],
			},
			{
				body: [frame(chunk({}, "stop")), frame(chunk({})), done].join(""),
				path: ["choices"],
			},
			{
				body: [frame(chunk({}, "stop")), frame(chunk({}, "length")), done].join(""),
				path: ["choices"],
			},
			{
				body: [
					frame(chunk({}, "stop")),
					frame({
						id: "chatcmpl_1",
						created: 1,
						model: "gpt-test",
						choices: [],
						usage: null,
					}),
					done,
				].join(""),
				path: ["usage"],
			},
			{ body: [frame(chunk({}, "stop")), usage, usage, done].join(""), path: ["usage"] },
		] as const,
		(test) => expectStreamFailure(test.body, test.path),
	),
)

it.effect("keeps semantic assembler sequence and output state local to each subscription", () =>
	Effect.gen(function* () {
		const source = fromNative(
			request,
			Stream.fromArray<NativeChunk>([
				{ type: "start", id: "chatcmpl_1", model: "gpt-test", createdAt: 1 },
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

it.effect("rejects malformed chunks and missing, duplicate or trailing stream terminals", () =>
	Effect.forEach(
		[
			"data: {\n\n",
			frame({ ...chunk({}), choices: [{ delta: { content: 42 } }] }),
			frame(chunk({ content: "Hi" })),
			done,
			[sse, done].join(""),
			[sse, frame(chunk({ content: "late" }))].join(""),
		],
		(body) =>
			Effect.gen(function* () {
				const process = yield* OpenAIChat.makeService(config, client(body)).generate(
					request,
				)
				const error = yield* Stream.runCollect(process.events).pipe(Effect.flip)
				assert.equal(error._tag, "ProviderError")
				assert.equal(error.kind, "unknown")
				assert.equal(error.retryable, false)
			}),
	),
)

it.effect("rejects unportable request semantics before invoking the transport", () =>
	Effect.gen(function* () {
		const upstream = HttpClient.make(() => Effect.die("Transport must not execute"))
		const service = OpenAIChat.makeService(config, upstream)
		const error = yield* service
			.generate(
				Schema.decodeUnknownSync(RequestSchema)({
					...request,
					previous_response_id: "resp_previous",
				}),
			)
			.pipe(Effect.flip)
		assert.equal(error.kind, "unsupported")
		assert.equal(error.retryable, false)
	}),
)

it.effect("classifies status errors and refuses successful non-SSE upstream responses", () =>
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
					const error = yield* OpenAIChat.makeService(
						config,
						client(null, failure.status),
					)
						.generate(request)
						.pipe(Effect.flip)
					assert.equal(error.kind, failure.kind)
					assert.equal(error.retryable, failure.retryable)
				}),
		)
		const error = yield* OpenAIChat.makeService(config, client("{}", 200, "application/json"))
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
			const process = yield* OpenAIChat.makeService(config, upstream).generate(request)
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
				const error = yield* OpenAIChat.makeService(config, upstream)
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

it.effect("cancels an unconsumed Chat process and closes the upstream request Scope", () =>
	Effect.gen(function* () {
		const sent = yield* Deferred.make<AbortSignal>()
		const upstream = HttpClient.make((outgoing, _url, signal) =>
			Deferred.succeed(sent, signal).pipe(
				Effect.as(
					HttpClientResponse.fromWeb(
						outgoing,
						new Response(sse, { headers: { "content-type": "text/event-stream" } }),
					),
				),
			),
		)
		const process = yield* OpenAIChat.makeService(config, upstream).generate(request)
		const signal = yield* Deferred.await(sent).pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, false)
		yield* process.cancel.pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, true)
		yield* process.cancel.pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, true)
	}),
)

it.effect("closes the upstream request Scope after consuming the Chat terminal event", () =>
	Effect.gen(function* () {
		const sent = yield* Deferred.make<AbortSignal>()
		const upstream = HttpClient.make((outgoing, _url, signal) =>
			Deferred.succeed(sent, signal).pipe(
				Effect.as(
					HttpClientResponse.fromWeb(
						outgoing,
						new Response(sse, { headers: { "content-type": "text/event-stream" } }),
					),
				),
			),
		)
		const process = yield* OpenAIChat.makeService(config, upstream).generate(request)
		const signal = yield* Deferred.await(sent).pipe(Effect.timeout("5 seconds"))
		assert.equal(signal.aborted, false)
		const events = yield* Stream.runCollect(process.events).pipe(Effect.timeout("5 seconds"))
		assert.equal(events.at(-1)?.type, "response.completed")
		assert.equal(signal.aborted, true)
	}),
)

it.effect("cancels a suspended Chat transport and finalizes the source stream", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const released = yield* Deferred.make<void>()
		const bytes = Stream.concat(
			Stream.succeed(new TextEncoder().encode(frame(chunk({ content: "Hi" })))),
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
		const process = yield* OpenAIChat.makeService(config, upstream).generate(request)
		const fiber = yield* Stream.runDrain(process.events).pipe(Effect.forkChild)
		yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
		yield* process.cancel
		yield* Fiber.await(fiber).pipe(Effect.timeout("5 seconds"))
		yield* Deferred.await(released).pipe(Effect.timeout("5 seconds"))
		assert.equal(yield* Deferred.isDone(released), true)
	}),
)
