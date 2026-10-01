import assert from "node:assert/strict"
import { it as effectTest } from "@effect/vitest"
import { Effect, Result, Schema, Stream } from "effect"
import { OpenApi } from "effect/http-api"
import { it } from "vitest"
import type { GenerationEvent, GenerationOutputItem } from "@better-router/core/Generation"
import { snapshot } from "@better-router/core/GenerationEvents"
import {
	AnthropicMessage,
	AnthropicMessagesHttpError,
	AnthropicOutboundEvent,
	api,
	projection,
	toMessage,
	toNativeRequest,
	toResponseRequest,
} from "@better-router/plugin-anthropic-messages/AnthropicMessagesHttp"

const base = {
	model: "claude",
	max_tokens: 64,
	messages: [{ role: "user", content: "Hi" }],
} as const

it("decodes the native selector and declares all Messages error statuses", () => {
	assert.deepEqual(
		toNativeRequest({ model: "claude", stream: true, trace_id: "trace" }),
		Result.succeed({ model: "claude", stream: true }),
	)
	const invalid = toNativeRequest({ stream: true })
	assert.ok(Result.isFailure(invalid))
	assert.equal(invalid.failure.path, "request.model")
	const responses = OpenApi.fromApi(api).paths["/v1/messages"]!.post!.responses
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
	assert.ok(
		Result.isSuccess(
			Schema.encodeUnknownResult(AnthropicMessagesHttpError)({
				type: "error",
				error: { type: "api_error", message: "bad" },
			}),
		),
	)
})

it("projects tool, image, system, choice and JSON Schema options", () => {
	const value = {
		...base,
		system: "Be concise",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "Find" },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
					},
				],
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "A" } }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call_1",
						content: [{ type: "text", text: "Found" }],
					},
				],
			},
		],
		tools: [{ name: "lookup", description: "Find", input_schema: { type: "object" } }],
		tool_choice: { type: "any", disable_parallel_tool_use: true },
		output_config: { format: { type: "json_schema", schema: { type: "object" } } },
		temperature: 0.3,
		top_p: 0.8,
		stream: true,
	}
	const before = structuredClone(value)
	const result = toResponseRequest(value)
	assert.ok(Result.isSuccess(result))
	assert.deepEqual(result.success, {
		model: "claude",
		input: [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "Find" },
					{
						type: "input_image",
						image_url: "data:image/png;base64,aGVsbG8=",
						detail: "auto",
					},
				],
			},
			{ type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"A"}' },
			{
				type: "function_call_output",
				call_id: "call_1",
				output: [{ type: "input_text", text: "Found" }],
			},
		],
		instructions: "Be concise",
		max_output_tokens: 64,
		tools: [
			{
				type: "function",
				name: "lookup",
				description: "Find",
				parameters: { type: "object" },
			},
		],
		tool_choice: "required",
		parallel_tool_calls: false,
		text: {
			format: {
				type: "json_schema",
				name: "anthropic_output",
				schema: { type: "object" },
				strict: true,
			},
		},
		temperature: 0.3,
		top_p: 0.8,
		stream: true,
	})
	assert.deepEqual(value, before)
})

it("reports unsupported and malformed Messages fields at their nested paths", () => {
	const cases = [
		[{ ...base, max_tokens: 8 }, "request.max_tokens", "unsupported"],
		[{ ...base, system: [{ type: "text", text: "bad" }] }, "request.system", "unsupported"],
		[
			{
				...base,
				messages: [
					{ role: "system", content: "one" },
					{ role: "system", content: "two" },
				],
			},
			"request.messages[0].role",
			"unsupported",
		],
		[
			{
				...base,
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", source: { type: "url", url: "javascript:bad" } },
						],
					},
				],
			},
			"request.messages[0].content[0].source.url",
			"unsupported",
		],
		[
			{
				...base,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "call",
								is_error: true,
								content: "bad",
							},
						],
					},
				],
			},
			"request.messages[0].content[0].is_error",
			"unsupported",
		],
		[
			{ ...base, tools: [{ name: "lookup", input_schema: {}, strict: true }] },
			"request.tools[0].strict",
			"unsupported",
		],
		[
			{ ...base, tool_choice: { type: "allowed_tools", tools: [] } },
			"request.tool_choice.tools",
			"unsupported",
		],
		[
			{ ...base, output_config: { format: { type: "json_object" } } },
			"request.output_config.format.type",
			"unsupported",
		],
	] as const
	assert.deepEqual(
		cases.map(([value]) => {
			const result = toResponseRequest(value)
			return Result.isFailure(result) && [result.failure.path, result.failure.reason]
		}),
		cases.map(([, path, reason]) => [path, reason]),
	)
})

const output = (
	items: readonly GenerationOutputItem[] = [
		{
			type: "message",
			id: "msg_1",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text: "Hello", annotations: [] }],
		},
	],
	extras: Partial<ReturnType<typeof snapshot>> = {},
) => ({
	...snapshot(
		{ model: "private" },
		"resp_1",
		1,
		"private",
		items,
		"completed",
		{
			input_tokens: 3,
			output_tokens: 2,
			total_tokens: 5,
			input_tokens_details: { cached_tokens: 1 },
			output_tokens_details: { reasoning_tokens: 0 },
		},
		2,
	),
	...extras,
})

it("projects text, tool calls and incomplete stop reasons into Anthropic Messages", () => {
	const result = toMessage(
		output([
			{
				type: "message",
				id: "msg_1",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "Hello", annotations: [] }],
			},
			{
				type: "function_call",
				id: "fc_1",
				status: "completed",
				call_id: "call_1",
				name: "lookup",
				arguments: '{"q":"A"}',
			},
		]),
		"public",
	)
	assert.ok(Result.isSuccess(result))
	assert.deepEqual(result.success.content, [
		{ type: "text", text: "Hello" },
		{ type: "tool_use", id: "call_1", name: "lookup", input: { q: "A" } },
	])
	assert.equal(result.success.stop_reason, "tool_use")
	assert.equal(result.success.model, "public")
	assert.ok(Result.isSuccess(Schema.encodeUnknownResult(AnthropicMessage)(result.success)))
	const maxTokens = toMessage(
		output([], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
		"public",
	)
	assert.ok(Result.isSuccess(maxTokens))
	assert.equal(maxTokens.success.stop_reason, "max_tokens")
	const refusal = toMessage(
		output([], { status: "incomplete", incomplete_details: { reason: "content_filter" } }),
		"public",
	)
	assert.ok(Result.isSuccess(refusal))
	assert.equal(refusal.success.stop_reason, "refusal")
})

it("rejects unprojectable terminal responses and preserves Schema issue paths", () => {
	const noUsage = toMessage(output([], { usage: null }), "public")
	assert.ok(Result.isFailure(noUsage))
	assert.equal(noUsage.failure.path, "response.usage")
	const invalidArguments = toMessage(
		output([
			{
				type: "function_call",
				id: "fc",
				status: "completed",
				call_id: "call",
				name: "lookup",
				arguments: "[]",
			},
		]),
		"public",
	)
	assert.ok(Result.isFailure(invalidArguments))
	assert.equal(invalidArguments.failure.path, "response.output[0].arguments")
	const unsupported = toMessage(output([{ type: "reasoning", id: "rs", summary: [] }]), "public")
	assert.ok(Result.isFailure(unsupported))
	assert.equal(unsupported.failure.reason, "unsupported")
	const failed = toMessage(output([], { status: "failed" }), "public")
	assert.ok(Result.isFailure(failed))
	assert.equal(failed.failure.path, "response.status")
})

const eventStream = (): readonly GenerationEvent[] => {
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
				{
					input_tokens: 1,
					output_tokens: 2,
					total_tokens: 3,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
				2,
			),
		},
	] as const
}

effectTest.effect("encodes Messages SSE state and emits message_stop only after a terminal", () =>
	Effect.gen(function* () {
		const output = yield* Stream.runCollect(
			projection.encodeEvents!(Stream.fromIterable(eventStream()), { model: "public" }),
		)
		const text = Array.from(output).join("")
		assert.match(text, /event: message_start/)
		assert.match(text, /event: content_block_delta/)
		assert.match(text, /event: message_delta/)
		assert.match(text, /event: message_stop/)
		assert.match(text, /"model":"public"/)
		const failed = yield* Stream.runCollect(
			projection.encodeEvents!(
				Stream.fromIterable([
					{ ...eventStream()[0]!, sequence_number: 1 },
					{ ...eventStream()[0]!, sequence_number: 2 },
				] as GenerationEvent[]),
				{ model: "public" },
			),
		)
		assert.match(Array.from(failed).join(""), /duplicate response.created/)
		assert.doesNotMatch(Array.from(failed).join(""), /message_stop/)
	}),
)

effectTest.effect("projects tool-use blocks and incomplete terminal responses", () =>
	Effect.gen(function* () {
		const item = {
			type: "function_call" as const,
			id: "fc_1",
			status: "completed",
			call_id: "call_1",
			name: "lookup",
			arguments: '{"q":1}',
		}
		const output = yield* Stream.runCollect(
			projection.encodeEvents!(
				Stream.fromIterable([
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
					{
						type: "response.output_item.added",
						sequence_number: 1,
						output_index: 0,
						item,
					},
					{
						type: "response.function_call_arguments.delta",
						sequence_number: 2,
						output_index: 0,
						item_id: "fc_1",
						delta: '{"q":1}',
					},
					{
						type: "response.incomplete",
						sequence_number: 3,
						response: snapshot(
							{ model: "private" },
							"resp_tool",
							1,
							"private",
							[item],
							"incomplete",
							{
								input_tokens: 1,
								output_tokens: 2,
								total_tokens: 3,
								input_tokens_details: { cached_tokens: 0 },
								output_tokens_details: { reasoning_tokens: 0 },
							},
							2,
						),
					},
				] as GenerationEvent[]),
				{ model: "public" },
			),
		)
		const text = Array.from(output).join("")
		assert.match(text, /content_block_start/)
		assert.match(text, /tool_use/)
		assert.match(text, /input_json_delta/)
		assert.match(text, /max_tokens|refusal|message_delta/)
	}),
)

it("schema-encodes outbound event variants", () => {
	assert.ok(
		Result.isSuccess(
			Schema.encodeUnknownResult(AnthropicOutboundEvent)({ type: "message_stop" }),
		),
	)
	assert.ok(
		Result.isFailure(
			Schema.decodeUnknownResult(AnthropicOutboundEvent)({
				type: "message_delta",
				delta: {},
			}),
		),
	)
})
