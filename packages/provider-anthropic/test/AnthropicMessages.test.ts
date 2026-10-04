import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Anthropic from "@better-router/provider-anthropic/AnthropicMessages"

const sse = [
	'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-test"}}\n\n',
	'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"lookup"}}\n\n',
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}}\n\n',
	'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","usage":{"output_tokens":2}},"usage":{"input_tokens":3,"output_tokens":2}}\n\n',
	'data: {"type":"message_stop"}\n\n',
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

it.effect("assembles Anthropic tool input deltas and usage", () =>
	Effect.gen(function* () {
		const service = yield* Anthropic.AnthropicMessages
		const process = yield* service.generate({
			model: "public",
			input: "Use the lookup tool",
			tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
		})
		const events = yield* Stream.runCollect(process.events)
		const terminal = events.at(-1)
		assert.equal(terminal?.type, "response.completed")
		const response = terminal?.type === "response.completed" ? terminal.response : undefined
		assert.equal(response?.usage?.input_tokens, 3)
		assert.equal(response?.output[0]?.type, "function_call")
		assert.equal(
			response?.output[0]?.type === "function_call"
				? response.output[0].arguments
				: undefined,
			'{"city":"Paris"}',
		)
	}).pipe(
		Effect.provide(
			Anthropic.layer({
				model: "claude-test",
				apiKey: Redacted.make("secret"),
				defaultMaxTokens: 256,
			}).pipe(Layer.provide(client)),
		),
	),
)

it.effect("rejects malformed tool arguments as a typed provider error", () =>
	Effect.gen(function* () {
		const service = yield* Anthropic.AnthropicMessages
		const error = yield* Effect.flip(
			service.generate({
				model: "public",
				input: [
					{
						type: "function_call",
						call_id: "call_1",
						name: "lookup",
						arguments: "not-json",
					},
				],
			}),
		)
		assert.equal(error.kind, "invalid_request")
	}).pipe(
		Effect.provide(
			Anthropic.layer({
				model: "claude-test",
				apiKey: Redacted.make("secret"),
				defaultMaxTokens: 256,
			}).pipe(Layer.provide(client)),
		),
	),
)
