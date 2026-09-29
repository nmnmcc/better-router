import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Redacted, Ref, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { snapshot } from "@better-router/core/GenerationEvents"
import {
	make,
	OpenAIResponsesInvalidDeploymentUrl,
} from "@better-router/plugin-openai-responses/OpenAIResponses"
import { toResponseRequest } from "@better-router/plugin-openai-responses/OpenAIResponsesHttp"

const executor = () => {
	const result = make({ id: "openai", model: "gpt-test", apiKey: Redacted.make("secret") })
	if (Result.isFailure(result)) return assert.fail(result.failure.message)
	return result.success.execute.http
}

it("invalid deployment URLs produce schema-backed errors", () => {
	const result = make({
		id: "bad",
		model: "private",
		apiKey: Redacted.make("secret"),
		url: new URL("ftp://example.com"),
	})
	if (Result.isSuccess(result)) return assert.fail("Expected invalid deployment")
	assert.equal(result.failure instanceof Error, true)
	assert.deepEqual(Schema.encodeSync(OpenAIResponsesInvalidDeploymentUrl)(result.failure), {
		_tag: "OpenAIResponsesInvalidDeploymentUrl",
		message: "Responses URL must use HTTP(S)",
	})
})

it("accepts portable instructions, tool calls, tool results, and response controls", () => {
	const input = {
		model: "private",
		instructions: "Be concise",
		input: [
			{
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: "Checking", annotations: [] }],
			},
			{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
			{ type: "function_call_output", call_id: "call_1", output: "Done" },
		],
		tools: [
			{
				type: "function",
				name: "lookup",
				description: "Look up a value",
				parameters: { type: "object" },
				strict: true,
			},
		],
		tool_choice: { type: "function", name: "lookup" },
		text: { format: { type: "json_schema", name: "result", schema: { type: "object" } } },
		max_output_tokens: 32,
		temperature: 0.2,
		top_p: 0.7,
		presence_penalty: 0.1,
		frequency_penalty: -0.1,
		parallel_tool_calls: false,
		store: false,
		metadata: { trace: "yes" },
	}
	const before = structuredClone(input)
	const result = toResponseRequest(input)
	assert.ok(Result.isSuccess(result))
	assert.deepEqual(result.success, input)
	assert.deepEqual(input, before)
})

it.effect("rejects nonportable extensions before making a request", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const client = HttpClient.make((request) => {
			return Ref.update(calls, (count) => count + 1).pipe(
				Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
			)
		})
		const execute = executor()
		const extension = yield* execute({
			model: "gpt-test",
			input: [{ type: "acme:receipt", id: "receipt_1", status: "completed" }],
		}).pipe(Effect.flip, Effect.provideService(HttpClient.HttpClient, client))
		assert.equal(extension.kind, "unsupported")
		const background = yield* execute({ model: "gpt-test", background: true }).pipe(
			Effect.flip,
			Effect.provideService(HttpClient.HttpClient, client),
		)
		assert.equal(background.kind, "unsupported")
		const reasoning = yield* execute({ model: "gpt-test", reasoning: { effort: "high" } }).pipe(
			Effect.flip,
			Effect.provideService(HttpClient.HttpClient, client),
		)
		assert.equal(reasoning.kind, "unsupported")
		const builtIn = yield* execute({
			model: "gpt-test",
			tools: [{ type: "web_search" } as never],
		}).pipe(Effect.flip, Effect.provideService(HttpClient.HttpClient, client))
		assert.equal(builtIn.kind, "invalid_request")
		assert.equal(yield* Ref.get(calls), 0)
	}),
)

it.effect("classifies upstream status failures before returning a stream", () =>
	Effect.gen(function* () {
		yield* Effect.forEach(
			[
				[429, "rate_limited", true],
				[401, "unauthorized", false],
				[403, "unauthorized", false],
				[408, "timeout", false],
				[504, "timeout", false],
				[503, "unavailable", false],
				[400, "invalid_request", false],
			] as const,
			([status, kind, retryable]) =>
				Effect.gen(function* () {
					const client = HttpClient.make((request) =>
						Effect.succeed(
							HttpClientResponse.fromWeb(request, new Response(null, { status })),
						),
					)
					const error = yield* executor()({ model: "gpt-test" }).pipe(
						Effect.flip,
						Effect.provideService(HttpClient.HttpClient, client),
					)
					assert.equal(error.kind, kind)
					assert.equal(error.retryable, retryable)
				}),
		)
	}),
)

it.effect("executes native protocol requests and preserves the upstream SSE envelope", () =>
	Effect.gen(function* () {
		const created = {
			type: "response.created",
			sequence_number: 0,
			response: snapshot(
				{ model: "private" },
				"resp_direct",
				1,
				"private",
				[],
				"in_progress",
				null,
				null,
			),
		}
		const completed = {
			type: "response.completed",
			sequence_number: 1,
			response: snapshot(
				{ model: "private" },
				"resp_direct",
				1,
				"private",
				[],
				"completed",
				null,
				2,
			),
		}
		const body = [
			`event: response.created\ndata: ${JSON.stringify(created)}\n\n`,
			`event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
			"data: [DONE]\n\n",
		].join("")
		const client = HttpClient.make((request) =>
			Effect.succeed(
				HttpClientResponse.fromWeb(
					request,
					new Response(body, { headers: { "content-type": "text/event-stream" } }),
				),
			),
		)
		const result = make({
			id: "openai",
			model: "private",
			apiKey: Redacted.make("secret"),
			organization: "org_test",
		})
		assert.ok(Result.isSuccess(result))
		const response = yield* result.success.execute.direct!({
			protocol: "openai.responses",
			model: "public",
			targetModel: "private",
			body: { input: "Hi" },
			headers: {},
		}).pipe(Effect.provideService(HttpClient.HttpClient, client))
		assert.equal(response.status, 200)
		const bytes = yield* Stream.runCollect(response.body)
		assert.match(
			new TextDecoder().decode(Uint8Array.from(bytes.flatMap((value) => [...value]))),
			/response.completed/,
		)
		const invalid = yield* result.success.execute.direct!({
			protocol: "openai.responses",
			model: "public",
			targetModel: "private",
			body: "not-an-object",
			headers: {},
		}).pipe(Effect.flip, Effect.provideService(HttpClient.HttpClient, client))
		assert.equal(invalid.kind, "invalid_request")
	}),
)

it.effect("rejects malformed, unterminated, and trailing SSE frames", () =>
	Effect.gen(function* () {
		const final = JSON.stringify({
			type: "response.completed",
			sequence_number: 0,
			response: snapshot(
				{ model: "gpt-test" },
				"resp_1",
				1,
				"gpt-test",
				[],
				"completed",
				null,
				2,
			),
		})
		yield* Effect.forEach(
			[
				["data: {invalid}\n\n", "Invalid upstream SSE JSON"],
				[
					"data: " + final.replace('"completed"', '"failed"') + "\n\n",
					"Invalid terminal response snapshot",
				],
				[
					"data: " + final + "\n\ndata: " + final + "\n\n",
					"Events followed the terminal response",
				],
				[
					`data: ${JSON.stringify({ type: "response.created", sequence_number: 0, response: snapshot({ model: "gpt-test" }, "resp_1", 1, "gpt-test", [], "in_progress", null, null) })}\n\n`,
					"Upstream stream ended without a terminal response",
				],
			] as const,
			([body, message]) =>
				Effect.gen(function* () {
					const client = HttpClient.make((request) =>
						Effect.succeed(
							HttpClientResponse.fromWeb(
								request,
								new Response(body, {
									headers: { "content-type": "text/event-stream" },
								}),
							),
						),
					)
					const error = yield* Effect.gen(function* () {
						const events = yield* executor()({ model: "gpt-test" })
						return yield* Stream.runCollect(events).pipe(Effect.flip)
					}).pipe(Effect.provideService(HttpClient.HttpClient, client))
					assert.equal(error.message, message)
				}),
		)
	}),
)

it.effect("rejects mismatched event names and an upstream stream without [DONE]", () =>
	Effect.gen(function* () {
		const created = JSON.stringify({
			type: "response.created",
			sequence_number: 0,
			response: snapshot(
				{ model: "gpt-test" },
				"resp_1",
				1,
				"gpt-test",
				[],
				"in_progress",
				null,
				null,
			),
		})
		yield* Effect.forEach(
			[
				[
					`event: response.completed\ndata: ${created}\n\n`,
					"Upstream SSE event type mismatch",
				],
				[
					`data: ${created}\n\ndata: [DONE]\n\n`,
					"Upstream ended before a terminal response",
				],
			] as const,
			([body, message]) =>
				Effect.gen(function* () {
					const client = HttpClient.make((request) =>
						Effect.succeed(
							HttpClientResponse.fromWeb(
								request,
								new Response(body, {
									headers: { "content-type": "text/event-stream" },
								}),
							),
						),
					)
					const error = yield* Effect.gen(function* () {
						const stream = yield* executor()({ model: "gpt-test" })
						return yield* Stream.runCollect(stream).pipe(Effect.flip)
					}).pipe(Effect.provideService(HttpClient.HttpClient, client))
					assert.equal(error.message, message)
				}),
		)
	}),
)
