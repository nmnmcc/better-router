import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Deferred, Effect, Ref, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import {
	Request as GenerationRequest,
	Response as GenerationResponse,
} from "@better-router/core/GenerationSchema"
import { gateway, readText, request, upstream } from "../../test/Host.js"
import { openAiResponse, openAiStream } from "../../test/Fixtures.js"

const jsonError = Schema.fromJsonString(
	Schema.Struct({
		error: Schema.Struct({
			type: Schema.String,
			message: Schema.String,
			param: Schema.optional(Schema.String),
		}),
	}),
)

const chatResponse = Schema.fromJsonString(
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

const chatChunk = Schema.Struct({
	id: Schema.String,
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
})

const clientHeaders = { authorization: "Bearer client", "content-type": "application/json" }
const chatBody = (stream: boolean) => ({
	model: "quickstart",
	messages: [{ role: "user", content: "Say hello" }],
	stream,
})
const settings = (url: string) => ({
	GATEWAY_API_KEY: "client",
	GATEWAY_MODEL: "quickstart",
	OPENAI_API_KEY: "provider-secret",
	OPENAI_MODEL: "gpt-host",
	OPENAI_RESPONSES_URL: `${url}/v1/responses`,
})

it.live(
	"authenticates before upstream calls and projects JSON and SSE through both ingress APIs",
	() =>
		Effect.gen(function* () {
			const state = yield* upstream((_seen, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" })
				response.end(openAiStream("gpt-host", "quickstart response"))
			})
			const process = yield* gateway("quickstart", settings(state.url))

			const rejected = yield* request(`${process.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "not-json",
			})
			assert.equal(rejected.status, 401)
			const unauthorized = yield* readText(rejected).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(jsonError)),
			)
			assert.equal(unauthorized.error.type, "authentication_error")
			assert.deepEqual(yield* Ref.get(state.requests), [])

			const invalid = yield* request(`${process.url}/v1/chat/completions`, {
				method: "POST",
				headers: clientHeaders,
				body: JSON.stringify({
					model: "quickstart",
					messages: [
						{ role: "user", content: [{ type: "image_url", image_url: { url: 42 } }] },
					],
				}),
			})
			assert.equal(invalid.status, 400)
			const invalidBody = yield* readText(invalid).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(jsonError)),
			)
			assert.equal(invalidBody.error.param, "request.messages[0].content[0].image_url.url")
			assert.deepEqual(yield* Ref.get(state.requests), [])

			const json = yield* request(`${process.url}/v1/chat/completions`, {
				method: "POST",
				headers: {
					...clientHeaders,
					"proxy-authorization": "Bearer private-client-header",
					"x-gateway-private": "must-stay-at-ingress",
				},
				body: JSON.stringify(chatBody(false)),
			})
			const jsonText = yield* readText(json)
			assert.equal(json.status, 200, jsonText)
			assert.match(json.headers.get("content-type") ?? "", /application\/json/)
			const projected = yield* Schema.decodeUnknownEffect(chatResponse)(jsonText)
			assert.equal(projected.model, "quickstart")
			assert.equal(projected.choices[0]?.message.role, "assistant")
			assert.equal(projected.choices[0]?.message.content, "quickstart response")
			assert.equal(projected.choices[0]?.finish_reason, "stop")
			assert.deepEqual(projected.usage, {
				prompt_tokens: 3,
				completion_tokens: 2,
				total_tokens: 5,
			})

			const response = yield* request(`${process.url}/v1/responses`, {
				method: "POST",
				headers: clientHeaders,
				body: JSON.stringify({ model: "quickstart", input: "Say hello" }),
			})
			assert.equal(response.status, 200)
			const semantic = yield* readText(response).pipe(
				Effect.flatMap(
					Schema.decodeUnknownEffect(Schema.fromJsonString(GenerationResponse)),
				),
			)
			assert.equal(semantic.model, "quickstart")
			assert.deepEqual(
				semantic.output,
				openAiResponse("gpt-host", "quickstart response").output,
			)

			const stream = yield* request(`${process.url}/v1/chat/completions`, {
				method: "POST",
				headers: clientHeaders,
				body: JSON.stringify(chatBody(true)),
			})
			assert.equal(stream.status, 200)
			assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/)
			const streamBody = yield* readText(stream)
			const frames = yield* Stream.succeed(streamBody).pipe(
				Stream.pipeThroughChannel(Sse.decode()),
				Stream.runCollect,
			)
			assert.equal(frames.filter((frame) => frame.data === "[DONE]").length, 1)
			assert.equal(frames.at(-1)?.data, "[DONE]")
			const chunks = yield* Effect.forEach(
				frames.filter((frame) => frame.data !== "[DONE]"),
				(frame) => Schema.decodeUnknownEffect(Schema.fromJsonString(chatChunk))(frame.data),
			)
			assert.equal(
				chunks
					.flatMap((chunk) => chunk.choices.map((choice) => choice.delta.content ?? ""))
					.join(""),
				"quickstart response",
			)
			assert.equal(chunks.at(-1)?.choices[0]?.finish_reason, "stop")

			const seen = yield* Ref.get(state.requests)
			assert.equal(seen.length, 3)
			assert.equal(
				seen.every(({ method, path }) => method === "POST" && path === "/v1/responses"),
				true,
			)
			assert.equal(
				seen.every(({ headers }) => headers.authorization === "Bearer provider-secret"),
				true,
			)
			assert.equal(
				seen.every(
					({ headers }) =>
						headers["proxy-authorization"] === undefined &&
						headers["x-gateway-private"] === undefined,
				),
				true,
			)
			const bodies = yield* Effect.forEach(seen, ({ body }) =>
				Schema.decodeUnknownEffect(Schema.fromJsonString(GenerationRequest))(body),
			)
			assert.equal(
				bodies.every(({ model, stream }) => model === "gpt-host" && stream === true),
				true,
			)
		}),
)

it.live("closes the suspended upstream socket when the HTTP client cancels SSE", () =>
	Effect.gen(function* () {
		const released = yield* Deferred.make<void>()
		const state = yield* upstream((_seen, response) => {
			response.once("close", () => Effect.runSync(Deferred.succeed(released, void 0)))
			response.writeHead(200, { "content-type": "text/event-stream" })
			response.write(
				openAiStream("gpt-host", "pending output").split("\n\n").slice(0, 2).join("\n\n") +
					"\n\n",
			)
		})
		const process = yield* gateway("quickstart", settings(state.url))
		yield* Effect.scoped(
			Effect.gen(function* () {
				const response = yield* request(`${process.url}/v1/chat/completions`, {
					method: "POST",
					headers: clientHeaders,
					body: JSON.stringify(chatBody(true)),
				})
				assert.equal(response.status, 200)
				const body = response.body
				assert.ok(body)
				const chunks = yield* Stream.fromReadableStream({
					evaluate: () => body,
					onError: (cause) => cause,
				}).pipe(
					Stream.decodeText(),
					Stream.pipeThroughChannel(Sse.decodeDataSchema(chatChunk)),
					Stream.take(1),
					Stream.runCollect,
					Effect.timeout("3 seconds"),
				)
				assert.equal(chunks.length, 1)
				assert.equal(chunks[0]?.data.object, "chat.completion.chunk")
			}),
		)
		yield* Deferred.await(released).pipe(Effect.timeout("3 seconds"))
		assert.equal((yield* Ref.get(state.requests)).length, 1)
	}),
)
