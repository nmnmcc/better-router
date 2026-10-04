import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as OpenAIChat from "@better-router/provider-openai/OpenAIChatCompletions"

const sse = [
	'data: {"id":"chatcmpl_1","created":1,"model":"gpt-test","choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
	'data: {"id":"chatcmpl_1","created":1,"model":"gpt-test","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
	'data: {"id":"chatcmpl_1","created":1,"model":"gpt-test","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
	"data: [DONE]\n\n",
].join("")

const client = Layer.succeed(
	HttpClient.HttpClient,
	HttpClient.make((request) =>
		Effect.succeed(
			HttpClientResponse.fromWeb(
				request,
				new Response(sse, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			),
		),
	),
)

it.effect("assembles Chat Completions SSE usage and terminal events", () =>
	Effect.gen(function* () {
		const service = yield* OpenAIChat.OpenAIChatCompletions
		const process = yield* service.generate({ model: "public", input: "Hello" })
		const events = yield* Stream.runCollect(process.events)
		const terminal = events.at(-1)
		assert.equal(terminal?.type, "response.completed")
		const response = terminal?.type === "response.completed" ? terminal.response : undefined
		assert.equal(response?.usage?.total_tokens, 3)
		assert.equal(response?.output[0]?.type, "message")
	}).pipe(
		Effect.provide(
			OpenAIChat.layer({
				model: "gpt-test",
				apiKey: Redacted.make("secret"),
			}).pipe(Layer.provide(client)),
		),
	),
)
