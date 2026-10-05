import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Ref, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { Request as GenerationRequest } from "@better-router/core/GenerationSchema"
import { gateway, readText, request, upstream } from "../../test/Host.js"
import { anthropicStream, openAiResponse, openAiStream } from "../../test/Fixtures.js"

const jsonResponse = Schema.fromJsonString(
	Schema.Struct({
		model: Schema.String,
		choices: Schema.Array(
			Schema.Struct({
				message: Schema.Struct({
					role: Schema.Literal("assistant"),
					content: Schema.String,
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
const jsonError = Schema.fromJsonString(
	Schema.Struct({
		error: Schema.Struct({ type: Schema.String, message: Schema.String }),
	}),
)
const chatChunk = Schema.fromJsonString(
	Schema.Struct({
		object: Schema.Literal("chat.completion.chunk"),
		model: Schema.String,
		choices: Schema.Array(
			Schema.Struct({
				delta: Schema.Struct({
					role: Schema.optional(Schema.String),
					content: Schema.optional(Schema.String),
				}),
				finish_reason: Schema.NullOr(Schema.String),
			}),
		),
	}),
)
const anthropicRequest = Schema.fromJsonString(
	Schema.Struct({
		model: Schema.String,
		stream: Schema.Boolean,
		max_tokens: Schema.Number,
		messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
	}),
)
const anthropicEvent = Schema.Union([
	Schema.Struct({
		type: Schema.Literal("message_start"),
		message: Schema.Struct({ model: Schema.String }),
	}),
	Schema.Struct({
		type: Schema.Literal("content_block_start"),
		content_block: Schema.Struct({ type: Schema.Literal("text") }),
	}),
	Schema.Struct({
		type: Schema.Literal("content_block_delta"),
		delta: Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
	}),
	Schema.Struct({ type: Schema.Literal("content_block_stop"), index: Schema.Number }),
	Schema.Struct({
		type: Schema.Literal("message_delta"),
		delta: Schema.Struct({ stop_reason: Schema.String }),
	}),
	Schema.Struct({ type: Schema.Literal("message_stop") }),
])
const settings = (openAiUrl: string, anthropicUrl: string) => ({
	GATEWAY_API_KEY: "client",
	GATEWAY_MODEL: "reliable",
	OPENAI_API_KEY: "openai-secret",
	OPENAI_MODEL: "gpt-primary",
	OPENAI_RESPONSES_URL: `${openAiUrl}/v1/responses`,
	ANTHROPIC_API_KEY: "anthropic-secret",
	ANTHROPIC_MODEL: "claude-fallback",
	ANTHROPIC_MESSAGES_URL: `${anthropicUrl}/v1/messages`,
	ANTHROPIC_MAX_TOKENS: "256",
})
const clientHeaders = { authorization: "Bearer client", "content-type": "application/json" }
const chatBody = (stream: boolean) => ({
	model: "reliable",
	messages: [{ role: "user", content: "Try the fallback" }],
	stream,
})

it.live(
	"falls back before the first semantic event with separate credentials and model transforms",
	() =>
		Effect.gen(function* () {
			const openAi = yield* upstream((_seen, response) => {
				response.writeHead(503, { "content-type": "application/json" })
				response.end(JSON.stringify({ error: { message: "primary unavailable" } }))
			})
			const anthropic = yield* upstream((_seen, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" })
				response.end(anthropicStream("claude-fallback", "fallback response"))
			})
			const process = yield* gateway("failover", settings(openAi.url, anthropic.url))

			const response = yield* request(`${process.url}/v1/chat/completions`, {
				method: "POST",
				headers: clientHeaders,
				body: JSON.stringify(chatBody(false)),
			})
			const text = yield* readText(response)
			assert.equal(response.status, 200, text)
			const body = yield* Schema.decodeUnknownEffect(jsonResponse)(text)
			assert.equal(body.model, "reliable")
			assert.equal(body.choices[0]?.message.content, "fallback response")
			assert.equal(body.choices[0]?.finish_reason, "stop")
			assert.deepEqual(body.usage, {
				prompt_tokens: 3,
				completion_tokens: 2,
				total_tokens: 5,
			})

			const stream = yield* request(`${process.url}/v1/messages`, {
				method: "POST",
				headers: { "x-api-key": "client", "content-type": "application/json" },
				body: JSON.stringify({
					model: "reliable",
					messages: [{ role: "user", content: "Try the fallback" }],
					max_tokens: 32,
					stream: true,
				}),
			})
			assert.equal(stream.status, 200)
			const streamBody = yield* readText(stream)
			const frames = yield* Stream.succeed(streamBody).pipe(
				Stream.pipeThroughChannel(Sse.decodeDataSchema(anthropicEvent)),
				Stream.runCollect,
			)
			assert.equal(frames[0]?.data.type, "message_start")
			const started = frames
				.map((frame) => frame.data)
				.find((event) => event.type === "message_start")
			assert.equal(started?.message.model, "reliable")
			const delta = frames
				.map((frame) => frame.data)
				.find((event) => event.type === "content_block_delta")
			assert.equal(delta?.delta.text, "fallback response")
			assert.equal(frames.at(-1)?.data.type, "message_stop")
			assert.equal(frames.filter((frame) => frame.data.type === "message_stop").length, 1)

			const primaryRequests = yield* Ref.get(openAi.requests)
			const fallbackRequests = yield* Ref.get(anthropic.requests)
			assert.equal(primaryRequests.length, 2)
			assert.equal(fallbackRequests.length, 2)
			assert.equal(
				primaryRequests.every(
					({ headers }) => headers.authorization === "Bearer openai-secret",
				),
				true,
			)
			assert.equal(
				fallbackRequests.every(
					({ headers }) =>
						headers["x-api-key"] === "anthropic-secret" &&
						headers.authorization === undefined,
				),
				true,
			)
			assert.equal(
				fallbackRequests.every(
					({ headers, path }) =>
						headers["anthropic-version"] === "2023-06-01" && path === "/v1/messages",
				),
				true,
			)
			const primaryBodies = yield* Effect.forEach(primaryRequests, ({ body }) =>
				Schema.decodeUnknownEffect(Schema.fromJsonString(GenerationRequest))(body),
			)
			assert.equal(
				primaryBodies.every(
					({ model, stream }) => model === "gpt-primary" && stream === true,
				),
				true,
			)
			const fallbackBodies = yield* Effect.forEach(fallbackRequests, ({ body }) =>
				Schema.decodeUnknownEffect(anthropicRequest)(body),
			)
			assert.deepEqual(
				fallbackBodies.map(({ model, stream, max_tokens }) => ({
					model,
					stream,
					max_tokens,
				})),
				[
					{ model: "claude-fallback", stream: true, max_tokens: 256 },
					{ model: "claude-fallback", stream: true, max_tokens: 32 },
				],
			)
			assert.equal(
				fallbackBodies.every(({ messages }) => messages[0]?.content === "Try the fallback"),
				true,
			)
		}),
)

it.live("reports a post-output failure without replaying the request to Anthropic", () =>
	Effect.gen(function* () {
		const response = openAiResponse("gpt-primary", "partial primary output")
		const firstEvents =
			openAiStream("gpt-primary", "partial primary output")
				.split("\n\n")
				.slice(0, 2)
				.join("\n\n") + "\n\n"
		const failed = {
			type: "response.failed",
			sequence_number: 2,
			response: {
				...response,
				status: "failed",
				error: { code: "server_error", message: "primary stopped" },
			},
		}
		const openAi = yield* upstream((_seen, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" })
			response.end(firstEvents + `data: ${JSON.stringify(failed)}\n\n`)
		})
		const anthropic = yield* upstream((_seen, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" })
			response.end(anthropicStream("claude-fallback", "must not replay"))
		})
		const process = yield* gateway("failover", settings(openAi.url, anthropic.url))
		const result = yield* request(`${process.url}/v1/chat/completions`, {
			method: "POST",
			headers: clientHeaders,
			body: JSON.stringify(chatBody(true)),
		})
		assert.equal(result.status, 200)
		const body = yield* readText(result)
		const frames = yield* Stream.succeed(body).pipe(
			Stream.pipeThroughChannel(Sse.decode()),
			Stream.runCollect,
		)
		assert.equal(
			frames.some((frame) => frame.data === "[DONE]"),
			false,
		)
		assert.equal(frames.at(-1)?.event, "error")
		const errors = yield* Effect.forEach(
			frames.filter((frame) => frame.event === "error"),
			(frame) => Schema.decodeUnknownEffect(jsonError)(frame.data),
		)
		assert.equal(errors.length, 1)
		assert.equal(errors[0]?.error.type, "upstream_error")
		const chunks = yield* Effect.forEach(
			frames.filter((frame) => frame.event !== "error"),
			(frame) => Schema.decodeUnknownEffect(chatChunk)(frame.data),
		)
		assert.equal(
			chunks.every((chunk) => chunk.model === "reliable"),
			true,
		)
		assert.equal(
			chunks
				.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? ""))
				.join(""),
			"partial primary output",
		)
		assert.equal((yield* Ref.get(openAi.requests)).length, 1)
		assert.deepEqual(yield* Ref.get(anthropic.requests), [])
	}),
)

it.live("keeps nonretryable upstream failures on the primary deployment", () =>
	Effect.gen(function* () {
		const openAi = yield* upstream((_seen, response) => {
			response.writeHead(400, { "content-type": "application/json" })
			response.end(JSON.stringify({ error: { message: "invalid request" } }))
		})
		const anthropic = yield* upstream((_seen, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" })
			response.end(anthropicStream("claude-fallback", "must not retry"))
		})
		const process = yield* gateway("failover", settings(openAi.url, anthropic.url))
		const response = yield* request(`${process.url}/v1/chat/completions`, {
			method: "POST",
			headers: clientHeaders,
			body: JSON.stringify(chatBody(false)),
		})
		const text = yield* readText(response)
		assert.equal(response.status, 400, text)
		const error = yield* Schema.decodeUnknownEffect(jsonError)(text)
		assert.equal(error.error.type, "invalid_request_error")
		assert.equal(error.error.message, "OpenAI rejected the request (400)")
		assert.equal((yield* Ref.get(openAi.requests)).length, 1)
		assert.deepEqual(yield* Ref.get(anthropic.requests), [])
	}),
)
