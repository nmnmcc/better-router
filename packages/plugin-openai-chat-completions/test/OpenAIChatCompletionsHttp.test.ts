import assert from "node:assert/strict"
import { it as effectTest } from "@effect/vitest"
import { Effect, Result, Schema, Stream } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { it } from "vitest"
import type { GenerationResponse } from "@better-router/core/Generation"
import type { GenerationOutputItem } from "@better-router/core/Generation"
import type { GenerationEvent } from "@better-router/core/Generation"
import { snapshot } from "@better-router/core/GenerationEvents"
import {
	OpenAIChatCompletionsHttpError,
	api,
	toChatCompletion,
	OpenAIChatCompletionsUpstreamResponseError,
	projection,
} from "@better-router/plugin-openai-chat-completions/OpenAIChatCompletionsHttp"

const textItem = {
	type: "message",
	role: "assistant",
	id: "msg_1",
	status: "completed",
	content: [{ type: "output_text", text: "Hello", annotations: [] }],
} as const
const response = (
	output: readonly GenerationOutputItem[] = [textItem],
	extras: Partial<GenerationResponse> = {},
): GenerationResponse => ({
	...snapshot(
		{ model: "gpt-test" },
		"resp_1",
		1234,
		"gpt-test",
		output,
		"completed",
		{
			input_tokens: 3,
			output_tokens: 2,
			total_tokens: 5,
			input_tokens_details: { cached_tokens: 1 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
		1235,
	),
	...extras,
})
const completion = (value: unknown, model?: string) => {
	const result = toChatCompletion(value, model)
	if (Result.isFailure(result)) return assert.fail(result.failure.message)
	return result.success
}

it("HTTP API declares the schema-backed error statuses", () => {
	const responses = OpenApi.fromApi(api).paths["/v1/chat/completions"]!.post!.responses
	assert.deepEqual(Object.keys(responses), [
		"200",
		"400",
		"401",
		"404",
		"413",
		"415",
		"422",
		"429",
		"500",
		"502",
		"503",
		"504",
	])
	assert.equal(responses[401]!.content?.["application/json"]?.schema?.type, "object")
})

it("upstream projection errors encode with their Schema", () => {
	const error = OpenAIChatCompletionsUpstreamResponseError.make({ message: "Invalid response" })
	assert.equal(error instanceof Error, true)
	const encoded = Schema.encodeSync(OpenAIChatCompletionsUpstreamResponseError)(error)
	assert.deepEqual(encoded, {
		_tag: "OpenAIChatCompletionsUpstreamResponseError",
		message: "Invalid response",
	})
	assert.equal(
		Schema.decodeUnknownSync(OpenAIChatCompletionsUpstreamResponseError)(encoded).message,
		error.message,
	)
	assert.throws(() =>
		Schema.decodeUnknownSync(OpenAIChatCompletionsHttpError)({
			error: { message: "bad", type: "unknown" },
		}),
	)
})

it("projects multi-item text, function calls, refusals, and usage", () => {
	const result = completion(
		response([
			{ ...textItem, content: [{ type: "output_text", text: "Checking", annotations: [] }] },
			{
				type: "function_call",
				id: "fc_1",
				status: "completed",
				call_id: "call_1",
				name: "lookup",
				arguments: "{}",
			},
			{
				type: "function_call",
				id: "fc_2",
				status: "completed",
				call_id: "call_2",
				name: "log",
				arguments: "{}",
			},
		]),
		"chat",
	)
	assert.equal(result.id, "chatcmpl-resp_1")
	assert.equal(result.model, "chat")
	assert.equal(result.choices[0]?.finish_reason, "tool_calls")
	assert.equal(result.choices[0]?.message.content, "Checking")
	assert.deepEqual(
		result.choices[0]?.message.tool_calls?.map((call) => call.id),
		["call_1", "call_2"],
	)
	assert.equal(result.usage?.prompt_tokens_details?.cached_tokens, 1)
	assert.equal(
		completion(response([{ ...textItem, content: [{ type: "refusal", refusal: "No" }] }]))
			.choices[0]?.message.refusal,
		"No",
	)
	assert.equal(
		completion(
			response([], {
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
			}),
		).choices[0]?.finish_reason,
		"length",
	)
	assert.equal(
		Result.isFailure(
			toChatCompletion(
				response([
					{
						...textItem,
						content: [
							{
								type: "output_text",
								text: "x",
								annotations: [
									{
										type: "url_citation",
										url: "https://example.com",
										title: "Source",
										start_index: 0,
										end_index: 1,
									},
								],
							},
						],
					},
				]),
			),
		),
		true,
	)
	assert.equal(Result.isFailure(toChatCompletion(response([], { status: "failed" }))), true)
	assert.equal(
		Result.isFailure(
			toChatCompletion(
				response([
					{
						type: "reasoning",
						id: "rs_1",
						summary: [{ type: "summary_text", text: "Considered alternatives" }],
					},
				]),
			),
		),
		true,
	)
	assert.equal(
		completion(
			response([], {
				status: "incomplete",
				incomplete_details: { reason: "content_filter" },
			}),
		).choices[0]?.finish_reason,
		"content_filter",
	)
	assert.equal(
		Result.isFailure(
			toChatCompletion({
				status: "completed",
				id: "bad",
				object: "response",
				created_at: 1,
				completed_at: 2,
				model: "gpt",
				output: [],
			}),
		),
		true,
	)
})

const streamEvents = (): readonly GenerationEvent[] => {
	const item = {
		type: "message" as const,
		id: "msg_1",
		status: "completed",
		role: "assistant" as const,
		content: [{ type: "output_text" as const, text: "Hello", annotations: [] }],
	}
	return [
		{
			type: "response.created",
			sequence_number: 0,
			response: snapshot(
				{ model: "private" },
				"resp_1",
				1,
				"private",
				[],
				"in_progress",
				null,
				null,
			),
		},
		{ type: "response.output_item.added", sequence_number: 1, output_index: 0, item },
		{
			type: "response.output_text.delta",
			sequence_number: 2,
			output_index: 0,
			item_id: "msg_1",
			content_index: 0,
			delta: "Hello",
		},
		{
			type: "response.completed",
			sequence_number: 3,
			response: snapshot(
				{ model: "private" },
				"resp_1",
				1,
				"private",
				[item],
				"completed",
				null,
				2,
			),
		},
	] as const
}

effectTest.effect("encodes Chat SSE text and usage frames and terminates with [DONE]", () =>
	Effect.gen(function* () {
		const output = yield* Stream.runCollect(
			projection.encodeEvents!(Stream.fromIterable(streamEvents()), {
				model: "public",
				includeUsage: true,
			}),
		)
		const text = Array.from(output).join("")
		assert.match(text, /"role":"assistant"/)
		assert.match(text, /"content":"Hello"/)
		assert.match(text, /"finish_reason":"stop"/)
		assert.match(text, /"usage"/)
		assert.match(text, /data: \[DONE\]/)
		const noUsage = yield* Stream.runCollect(
			projection.encodeEvents!(Stream.fromIterable(streamEvents()), { model: "public" }),
		)
		assert.doesNotMatch(Array.from(noUsage).join(""), /"usage"/)
	}),
)

effectTest.effect("projects function calls, refusal deltas, and incomplete responses", () =>
	Effect.gen(function* () {
		const item = {
			type: "function_call" as const,
			id: "fc_1",
			status: "completed",
			call_id: "call_1",
			name: "lookup",
			arguments: '{"q":1}',
		}
		const source = [
			{
				type: "response.created",
				sequence_number: 0,
				response: snapshot(
					{ model: "private" },
					"resp_tool",
					1,
					"private",
					[],
					"in_progress",
					null,
					null,
				),
			},
			{ type: "response.output_item.added", sequence_number: 1, output_index: 0, item },
			{
				type: "response.function_call_arguments.delta",
				sequence_number: 2,
				output_index: 0,
				item_id: "fc_1",
				delta: '{"q":1}',
			},
			{
				type: "response.completed",
				sequence_number: 3,
				response: snapshot(
					{ model: "private" },
					"resp_tool",
					1,
					"private",
					[item],
					"completed",
					null,
					2,
				),
			},
		] as GenerationEvent[]
		const output = yield* Stream.runCollect(
			projection.encodeEvents!(Stream.fromIterable(source), { model: "public" }),
		)
		const text = Array.from(output).join("")
		assert.match(text, /"tool_calls"/)
		assert.match(text, /"name":"lookup"/)
		assert.match(text, /"arguments"/)
		const refusal = yield* Stream.runCollect(
			projection.encodeEvents!(
				Stream.fromIterable([
					...streamEvents().slice(0, 2),
					{
						type: "response.refusal.delta",
						sequence_number: 2,
						output_index: 0,
						item_id: "msg_1",
						content_index: 0,
						delta: "No",
					},
				] as GenerationEvent[]),
				{ model: "public" },
			),
		)
		assert.match(Array.from(refusal).join(""), /refusal/)
	}),
)

effectTest.effect("reports Chat projection state violations as an error frame", () =>
	Effect.gen(function* () {
		const created = streamEvents()[0]!
		const output = yield* Stream.runCollect(
			projection.encodeEvents!(
				Stream.fromIterable([
					{ ...created, sequence_number: 1 },
					{ ...created, sequence_number: 2 },
				] as GenerationEvent[]),
				{ model: "public" },
			),
		)
		const text = Array.from(output).join("")
		assert.match(text, /"error"/)
		assert.match(text, /Duplicate response.created event/)
		assert.doesNotMatch(text, /data: \[DONE\]/)
		const missing = yield* Stream.runCollect(
			projection.encodeEvents!(Stream.fromIterable([]), { model: "public" }),
		)
		assert.match(
			Array.from(missing).join(""),
			/Missing response.created event|ended without a terminal response/,
		)
	}),
)
