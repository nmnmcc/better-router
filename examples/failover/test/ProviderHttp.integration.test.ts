import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Deferred, Effect, Redacted, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { Sse } from "effect/encoding"
import {
	HttpClient,
	HttpClientResponse,
	HttpRouter,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http"
import type { GenerationRequest } from "@better-router/core/Generation"
import type { Process } from "@better-router/core/GenerationProcess"
import { Request as GenerationRequestSchema } from "@better-router/core/GenerationSchema"
import type { ProviderError } from "@better-router/core/Provider"
import { InvalidRequest } from "@better-router/core/Route"
import type { Service as RouteService } from "@better-router/core/Route"
import * as Anthropic from "@better-router/provider-anthropic/AnthropicMessages"
import * as OpenAIChat from "@better-router/provider-openai/OpenAIChatCompletions"
import * as AnthropicHttp from "@better-router/protocol-anthropic-messages"
import * as ChatHttp from "@better-router/protocol-openai-chat-completions"

const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`

const fragmented = (value: string): Stream.Stream<Uint8Array> => {
	const bytes = new TextEncoder().encode(value)
	return Stream.fromArray(
		Array.from({ length: Math.ceil(bytes.length / 11) }, (_, index) =>
			bytes.slice(index * 11, (index + 1) * 11),
		),
	)
}

const chatStream = [
	frame({
		id: "chat_http_1",
		created: 1,
		model: "gpt-http",
		choices: [{ delta: { content: "Hello " }, finish_reason: null }],
	}),
	frame({
		id: "chat_http_1",
		created: 1,
		model: "gpt-http",
		choices: [
			{
				delta: {
					tool_calls: [
						{
							id: "call_weather",
							index: 0,
							function: { name: "weather", arguments: '{"city":' },
						},
					],
				},
				finish_reason: null,
			},
		],
	}),
	frame({
		id: "chat_http_1",
		created: 1,
		model: "gpt-http",
		choices: [
			{
				delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] },
				finish_reason: null,
			},
		],
	}),
	frame({
		id: "chat_http_1",
		created: 1,
		model: "gpt-http",
		choices: [
			{
				delta: {
					tool_calls: [
						{
							id: "call_clock",
							index: 1,
							function: { name: "clock", arguments: '{"zone":"UTC"}' },
						},
					],
				},
				finish_reason: null,
			},
		],
	}),
	frame({
		id: "chat_http_1",
		created: 1,
		model: "gpt-http",
		choices: [{ delta: {}, finish_reason: "tool_calls" }],
	}),
	frame({
		id: "chat_http_1",
		created: 1,
		model: "gpt-http",
		choices: [],
		usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
	}),
	"data: [DONE]\n\n",
].join("")

const anthropicStream = [
	frame({
		type: "message_start",
		message: {
			id: "msg_http_1",
			type: "message",
			role: "assistant",
			model: "claude-http",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 4, output_tokens: 0 },
		},
	}),
	frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	frame({
		type: "content_block_delta",
		index: 0,
		delta: { type: "text_delta", text: "Hello " },
	}),
	frame({ type: "content_block_stop", index: 0 }),
	frame({
		type: "content_block_start",
		index: 1,
		content_block: { type: "tool_use", id: "call_weather", name: "weather", input: {} },
	}),
	frame({
		type: "content_block_delta",
		index: 1,
		delta: { type: "input_json_delta", partial_json: '{"city":' },
	}),
	frame({
		type: "content_block_delta",
		index: 1,
		delta: { type: "input_json_delta", partial_json: '"Paris"}' },
	}),
	frame({ type: "content_block_stop", index: 1 }),
	frame({
		type: "content_block_start",
		index: 2,
		content_block: { type: "tool_use", id: "call_clock", name: "clock", input: {} },
	}),
	frame({
		type: "content_block_delta",
		index: 2,
		delta: { type: "input_json_delta", partial_json: '{"zone":"UTC"}' },
	}),
	frame({ type: "content_block_stop", index: 2 }),
	frame({
		type: "message_delta",
		delta: { stop_reason: "tool_use", stop_sequence: null },
		usage: { output_tokens: 8 },
	}),
	frame({ type: "message_stop" }),
].join("")

const request = (path: string, value: unknown): Request =>
	new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	})

const routeFor = (
	generate: (request: GenerationRequest) => Effect.Effect<Process<unknown, never>, ProviderError>,
): RouteService => ({
	generate: (value) =>
		Schema.decodeUnknownEffect(GenerationRequestSchema)(value).pipe(
			Effect.mapError((error) => InvalidRequest.make({ message: error.message })),
			Effect.flatMap(generate),
		),
})

const serve = (
	path: "/v1/chat/completions" | "/v1/messages",
	route: RouteService,
	incoming: Request,
	handle: (
		route: RouteService,
		request: HttpServerRequest.HttpServerRequest,
	) => Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, never>,
): Effect.Effect<HttpServerResponse.HttpServerResponse, unknown, Scope.Scope> =>
	Effect.gen(function* () {
		const handler = yield* HttpRouter.toHttpEffect(
			HttpRouter.add("POST", path, (serverRequest) => handle(route, serverRequest)),
		)
		return yield* Effect.provideService(
			handler,
			HttpServerRequest.HttpServerRequest,
			HttpServerRequest.fromWeb(incoming),
		)
	})

const readText = (response: HttpServerResponse.HttpServerResponse) =>
	Effect.promise(() => HttpServerResponse.toWeb(response).text())

const frames = (body: string) =>
	Stream.succeed(body).pipe(Stream.pipeThroughChannel(Sse.decode()), Stream.runCollect)

const UpstreamRequest = Schema.Struct({ model: Schema.String, stream: Schema.Literal(true) })

const ToolDelta = Schema.Struct({
	index: Schema.Number,
	id: Schema.optional(Schema.String),
	type: Schema.optional(Schema.Literal("function")),
	function: Schema.Struct({
		name: Schema.optional(Schema.String),
		arguments: Schema.optional(Schema.String),
	}),
})

const ChatChunk = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		object: Schema.Literal("chat.completion.chunk"),
		model: Schema.String,
		choices: Schema.Array(
			Schema.Struct({
				index: Schema.Number,
				delta: Schema.Struct({
					role: Schema.optional(Schema.Literal("assistant")),
					content: Schema.optional(Schema.String),
					tool_calls: Schema.optional(Schema.Array(ToolDelta)),
				}),
				finish_reason: Schema.NullOr(Schema.String),
			}),
		),
		usage: Schema.optional(
			Schema.Struct({
				prompt_tokens: Schema.Number,
				completion_tokens: Schema.Number,
				total_tokens: Schema.Number,
			}),
		),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)] as const,
)

const AnthropicEvent = Schema.StructWithRest(
	Schema.Struct({
		type: Schema.String,
		index: Schema.optional(Schema.Number),
		message: Schema.optional(Schema.Struct({ id: Schema.String, model: Schema.String })),
		delta: Schema.optional(
			Schema.Struct({
				type: Schema.optional(Schema.String),
				text: Schema.optional(Schema.String),
				partial_json: Schema.optional(Schema.String),
				stop_reason: Schema.optional(Schema.String),
			}),
		),
		content_block: Schema.optional(
			Schema.Struct({
				type: Schema.String,
				id: Schema.optional(Schema.String),
				name: Schema.optional(Schema.String),
			}),
		),
		usage: Schema.optional(Schema.Struct({ output_tokens: Schema.Number })),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)] as const,
)

it.effect("projects OpenAI Chat provider text and two tool calls through HTTP", () =>
	Effect.gen(function* () {
		const released = yield* Deferred.make<void>()
		const client = HttpClient.make((outgoing) =>
			Effect.gen(function* () {
				assert.equal(outgoing.method, "POST")
				assert.equal(outgoing.url, "https://upstream.example/v1/chat/completions")
				assert.equal(outgoing.headers.authorization, "Bearer openai-secret")
				assert.ok(outgoing.body._tag === "Uint8Array")
				const body = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(UpstreamRequest),
				)(new TextDecoder().decode(outgoing.body.body)).pipe(Effect.orDie)
				assert.equal(body.model, "gpt-http")
				const bytes = yield* Stream.toReadableStreamEffect(
					fragmented(chatStream).pipe(
						Stream.ensuring(Deferred.succeed(released, void 0)),
					),
				)
				return HttpClientResponse.fromWeb(
					outgoing,
					new Response(bytes, {
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					}),
				)
			}),
		)
		const service = OpenAIChat.makeService(
			{
				model: "gpt-http",
				apiKey: Redacted.make("openai-secret"),
				url: new URL("https://upstream.example/v1/chat/completions"),
			},
			client,
		)
		const response = yield* serve(
			"/v1/chat/completions",
			routeFor(service.generate),
			request("/v1/chat/completions", {
				model: "public-chat",
				messages: [{ role: "user", content: "Where is Paris?" }],
				tools: [
					{
						type: "function",
						function: { name: "weather", parameters: { type: "object" } },
					},
					{
						type: "function",
						function: { name: "clock", parameters: { type: "object" } },
					},
				],
				stream: true,
				stream_options: { include_usage: true },
			}),
			(route, serverRequest) => ChatHttp.Http.handle(route, serverRequest, {}),
		)
		const values = yield* frames(yield* readText(response))
		const chunks = yield* Effect.forEach(
			values.filter((value) => value.data !== "[DONE]"),
			(value) => Schema.decodeUnknownEffect(Schema.fromJsonString(ChatChunk))(value.data),
		)
		const text = chunks
			.flatMap((chunk) =>
				chunk.choices.map((choice) =>
					typeof choice.delta.content === "string" ? choice.delta.content : "",
				),
			)
			.join("")
		const toolCalls = chunks.flatMap((chunk) =>
			chunk.choices.flatMap((choice) => choice.delta.tool_calls ?? []),
		)
		assert.equal(response.status, 200)
		assert.match(response.headers["content-type"] ?? "", /text\/event-stream/)
		assert.equal(
			values.some((value) => value.event === "error"),
			false,
		)
		assert.equal(
			chunks.every((chunk) => chunk.id === "chat_http_1" && chunk.model === "gpt-http"),
			true,
		)
		assert.equal(text, "Hello ")
		assert.deepEqual(
			toolCalls
				.filter((call) => typeof call.id === "string")
				.map((call) => ({ index: call.index, id: call.id, name: call.function.name })),
			[
				{ index: 0, id: "call_weather", name: "weather" },
				{ index: 1, id: "call_clock", name: "clock" },
			],
		)
		assert.deepEqual(
			[0, 1].map((index) =>
				toolCalls
					.filter((call) => call.index === index)
					.map((call) => call.function.arguments ?? "")
					.join(""),
			),
			['{"city":"Paris"}', '{"zone":"UTC"}'],
		)
		assert.deepEqual(
			chunks.flatMap((chunk) =>
				chunk.choices.flatMap((choice) =>
					choice.finish_reason === null ? [] : [choice.finish_reason],
				),
			),
			["tool_calls"],
		)
		assert.deepEqual(chunks.at(-1)?.choices, [])
		assert.deepEqual(chunks.at(-1)?.usage, {
			prompt_tokens: 4,
			completion_tokens: 8,
			total_tokens: 12,
		})
		assert.equal(values.filter((value) => value.data === "[DONE]").length, 1)
		assert.equal(values.at(-1)?.data, "[DONE]")
		yield* Deferred.await(released).pipe(Effect.timeout("3 seconds"))
	}),
)

it.effect("projects Anthropic Messages provider text and two tool calls through HTTP", () =>
	Effect.gen(function* () {
		const released = yield* Deferred.make<void>()
		const client = HttpClient.make((outgoing) =>
			Effect.gen(function* () {
				assert.equal(outgoing.method, "POST")
				assert.equal(outgoing.url, "https://upstream.example/v1/messages")
				assert.equal(outgoing.headers["x-api-key"], "anthropic-secret")
				assert.equal(outgoing.headers.authorization, undefined)
				assert.equal(outgoing.headers["anthropic-version"], "2023-06-01")
				assert.ok(outgoing.body._tag === "Uint8Array")
				const body = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(UpstreamRequest),
				)(new TextDecoder().decode(outgoing.body.body)).pipe(Effect.orDie)
				assert.equal(body.model, "claude-http")
				const bytes = yield* Stream.toReadableStreamEffect(
					fragmented(anthropicStream).pipe(
						Stream.ensuring(Deferred.succeed(released, void 0)),
					),
				)
				return HttpClientResponse.fromWeb(
					outgoing,
					new Response(bytes, {
						headers: { "content-type": "text/event-stream; charset=utf-8" },
					}),
				)
			}),
		)
		const service = Anthropic.makeService(
			{
				model: "claude-http",
				apiKey: Redacted.make("anthropic-secret"),
				defaultMaxTokens: 128,
				url: new URL("https://upstream.example/v1/messages"),
			},
			client,
		)
		const response = yield* serve(
			"/v1/messages",
			routeFor(service.generate),
			request("/v1/messages", {
				model: "public-messages",
				messages: [{ role: "user", content: "Where is Paris?" }],
				max_tokens: 128,
				tools: [
					{ name: "weather", input_schema: { type: "object" } },
					{ name: "clock", input_schema: { type: "object" } },
				],
				stream: true,
			}),
			(route, serverRequest) => AnthropicHttp.Http.handle(route, serverRequest, {}),
		)
		const values = yield* frames(yield* readText(response))
		const events = yield* Effect.forEach(values, (value) =>
			Schema.decodeUnknownEffect(Schema.fromJsonString(AnthropicEvent))(value.data),
		)
		const text = events
			.flatMap((event) => {
				const delta = event.delta
				return delta && delta.type === "text_delta" && typeof delta.text === "string"
					? [delta.text]
					: []
			})
			.join("")
		const tools = events.flatMap((event) => {
			const block = event.content_block
			return block && block.type === "tool_use" ? [{ id: block.id, name: block.name }] : []
		})
		assert.equal(text, "Hello ")
		assert.equal(response.status, 200)
		assert.match(response.headers["content-type"] ?? "", /text\/event-stream/)
		assert.equal(
			values.some((value) => value.event === "error"),
			false,
		)
		assert.equal(events[0]?.message?.id, "msg_http_1")
		assert.equal(events[0]?.message?.model, "claude-http")
		assert.deepEqual(tools, [
			{ id: "call_weather", name: "weather" },
			{ id: "call_clock", name: "clock" },
		])
		assert.equal(events.at(-1)?.type, "message_stop")
		assert.equal(events.filter((event) => event.type === "message_delta").length, 1)
		assert.equal(events.filter((event) => event.type === "message_stop").length, 1)
		assert.deepEqual(
			events
				.filter((event) => event.type === "content_block_start")
				.map((event) => event.index),
			[0, 1, 2],
		)
		assert.deepEqual(
			events
				.filter((event) => event.type === "content_block_stop")
				.map((event) => event.index),
			[0, 1, 2],
		)
		assert.deepEqual(
			[1, 2].map((index) =>
				events
					.filter(
						(event) => event.index === index && event.type === "content_block_delta",
					)
					.map((event) => event.delta?.partial_json ?? "")
					.join(""),
			),
			['{"city":"Paris"}', '{"zone":"UTC"}'],
		)
		const terminal = events.find((event) => event.type === "message_delta")
		assert.equal(terminal?.delta?.stop_reason, "tool_use")
		assert.equal(terminal?.usage?.output_tokens, 8)
		yield* Deferred.await(released).pipe(Effect.timeout("3 seconds"))
	}),
)

it.effect("cancels provider-backed HTTP streams and releases each upstream body", () =>
	Effect.forEach(["chat", "anthropic"] as const, (protocol) =>
		Effect.gen(function* () {
			const active = yield* Deferred.make<void>()
			const released = yield* Deferred.make<void>()
			const path = protocol === "chat" ? "/v1/chat/completions" : "/v1/messages"
			const first =
				protocol === "chat"
					? frame({
							id: "chat_cancel",
							created: 1,
							model: "gpt-cancel",
							choices: [{ delta: { content: "pending" }, finish_reason: null }],
						})
					: frame({
							type: "message_start",
							message: { id: "msg_cancel", model: "claude-cancel" },
						})
			const bytes = Stream.concat(
				Stream.succeed(new TextEncoder().encode(first)),
				Stream.fromEffect(Deferred.succeed(active, undefined)).pipe(
					Stream.drain,
					Stream.concat(Stream.never),
				),
			).pipe(Stream.ensuring(Deferred.succeed(released, undefined)))
			const client = HttpClient.make((outgoing) =>
				Effect.gen(function* () {
					const body = yield* Stream.toReadableStreamEffect(bytes)
					return HttpClientResponse.fromWeb(
						outgoing,
						new Response(body, { headers: { "content-type": "text/event-stream" } }),
					)
				}),
			)
			const service =
				protocol === "chat"
					? OpenAIChat.makeService(
							{
								model: "gpt-cancel",
								apiKey: Redacted.make("cancel-secret"),
								url: new URL(`https://upstream.example${path}`),
							},
							client,
						)
					: Anthropic.makeService(
							{
								model: "claude-cancel",
								apiKey: Redacted.make("cancel-secret"),
								defaultMaxTokens: 128,
								url: new URL(`https://upstream.example${path}`),
							},
							client,
						)
			const response = yield* serve(
				path,
				routeFor(service.generate),
				request(path, {
					model: "public-cancel",
					messages: [{ role: "user", content: "Wait" }],
					...(protocol === "anthropic" ? { max_tokens: 128 } : {}),
					stream: true,
				}),
				(route, serverRequest) =>
					protocol === "chat"
						? ChatHttp.Http.handle(route, serverRequest, {})
						: AnthropicHttp.Http.handle(route, serverRequest, {}),
			)
			const body = HttpServerResponse.toWeb(response).body
			assert.ok(body)
			const reader = yield* Effect.acquireRelease(
				Effect.sync(() => body.getReader()),
				(value) => Effect.tryPromise(() => value.cancel()).pipe(Effect.ignore),
			)
			const firstRead = yield* Effect.tryPromise(() => reader.read()).pipe(
				Effect.timeout("3 seconds"),
			)
			assert.equal(firstRead.done, false)
			yield* Deferred.await(active).pipe(Effect.timeout("3 seconds"))
			yield* Effect.tryPromise(() => reader.cancel()).pipe(Effect.timeout("3 seconds"))
			yield* Deferred.await(released).pipe(Effect.timeout("3 seconds"))
			assert.equal(yield* Deferred.isDone(released), true)
		}),
	),
)
