import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Result, Stream } from "effect"
import type * as Generation from "@better-router/core/Generation"
import { encodeResponse, encodeStream } from "@better-router/protocol-anthropic-messages/Convert"

const response: Generation.GenerationResponse = {
	id: "response_1",
	object: "response",
	created_at: 1,
	completed_at: 2,
	status: "completed",
	incomplete_details: null,
	model: "public",
	previous_response_id: null,
	instructions: null,
	output: [],
	error: null,
	tools: [],
	tool_choice: "auto",
	truncation: "disabled",
	parallel_tool_calls: true,
	text: { format: { type: "text" } },
	top_p: 1,
	presence_penalty: 0,
	frequency_penalty: 0,
	top_logprobs: 0,
	temperature: 1,
	reasoning: null,
	usage: {
		input_tokens: 4,
		output_tokens: 2,
		total_tokens: 6,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens_details: { reasoning_tokens: 0 },
	},
	max_output_tokens: null,
	max_tool_calls: null,
	store: false,
	background: false,
	service_tier: "default",
	metadata: null,
	safety_identifier: null,
	prompt_cache_key: null,
}

const message = (text = "Hello"): Generation.GenerationOutputItem => ({
	type: "message",
	id: "message_1",
	status: "completed",
	role: "assistant",
	content: [{ type: "output_text", text, annotations: [] }],
})

const tool = (
	argumentsValue = '{"city":"Paris"}',
): Extract<Generation.GenerationOutputItem, { readonly type: "function_call" }> => ({
	type: "function_call",
	id: "call_item_1",
	call_id: "call_1",
	name: "weather",
	arguments: argumentsValue,
	status: "completed",
})

const completed = (
	output: readonly Generation.GenerationOutputItem[] = [message()],
): Generation.GenerationEvent => ({
	type: "response.completed",
	sequence_number: 99,
	response: { ...response, output },
})

const created: Generation.GenerationEvent = {
	type: "response.created",
	sequence_number: 0,
	response: { ...response, status: "in_progress", completed_at: null, output: [], usage: null },
}

const inProgress: Generation.GenerationEvent = {
	type: "response.in_progress",
	sequence_number: 1,
	response: { ...response, status: "in_progress", completed_at: null, output: [], usage: null },
}

const textAdded = (sequence_number: number, content_index = 0): Generation.GenerationEvent => ({
	type: "response.content_part.added",
	sequence_number,
	item_id: "message_1",
	output_index: 0,
	content_index,
	part: { type: "output_text", text: "", annotations: [] },
})

const textDelta = (
	sequence_number: number,
	delta: string,
	content_index = 0,
): Generation.GenerationEvent => ({
	type: "response.output_text.delta",
	sequence_number,
	item_id: "message_1",
	output_index: 0,
	content_index,
	delta,
})

const toolAdded: Generation.GenerationEvent = {
	type: "response.output_item.added",
	sequence_number: 10,
	output_index: 1,
	item: tool(""),
}

const toolDelta = (sequence_number: number, delta: string): Generation.GenerationEvent => ({
	type: "response.function_call_arguments.delta",
	sequence_number,
	item_id: "call_item_1",
	output_index: 1,
	delta,
})

const outputTypes = (events: readonly Readonly<Record<string, unknown>>[]): readonly unknown[] =>
	events.map((event) => event.type)

const eventStream = (
	...events: readonly Generation.GenerationEvent[]
): Stream.Stream<Generation.GenerationEvent> => Stream.make(...events)

it.effect("assembles text and tool blocks with deterministic flattened indices", () =>
	Effect.gen(function* () {
		const events = eventStream(
			created,
			inProgress,
			{
				type: "response.output_item.added",
				sequence_number: 2,
				output_index: 0,
				item: message(""),
			},
			textAdded(3),
			textDelta(4, "Hello"),
			{
				type: "response.output_text.done",
				sequence_number: 5,
				item_id: "message_1",
				output_index: 0,
				content_index: 0,
				text: "Hello",
			},
			{
				type: "response.content_part.done",
				sequence_number: 6,
				item_id: "message_1",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "Hello", annotations: [] },
			},
			{
				type: "response.output_item.done",
				sequence_number: 7,
				output_index: 0,
				item: message(),
			},
			toolAdded,
			toolDelta(11, '{"city":'),
			toolDelta(12, '"Paris"}'),
			{
				type: "response.function_call_arguments.done",
				sequence_number: 13,
				item_id: "call_item_1",
				output_index: 1,
				arguments: '{"city":"Paris"}',
			},
			{
				type: "response.output_item.done",
				sequence_number: 14,
				output_index: 1,
				item: tool(),
			},
			completed([message(), tool()]),
		)
		const output = [...(yield* Stream.runCollect(encodeStream(events)))]
		assert.deepEqual(outputTypes(output), [
			"message_start",
			"content_block_start",
			"content_block_delta",
			"content_block_stop",
			"content_block_start",
			"content_block_delta",
			"content_block_delta",
			"content_block_stop",
			"message_delta",
		])
		assert.deepEqual(output[1], {
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})
		assert.deepEqual(output[2], {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		})
		assert.deepEqual(output[4], {
			type: "content_block_start",
			index: 1,
			content_block: { type: "tool_use", id: "call_1", name: "weather", input: {} },
		})
		assert.deepEqual(output[5], {
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: '{"city":' },
		})
		assert.deepEqual(output[6], {
			type: "content_block_delta",
			index: 1,
			delta: { type: "input_json_delta", partial_json: '"Paris"}' },
		})
		assert.deepEqual(output[0]?.message, {
			id: "response_1",
			type: "message",
			role: "assistant",
			model: "public",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 0, output_tokens: 0 },
		})
		assert.deepEqual(output.at(-1), {
			type: "message_delta",
			delta: { stop_reason: "tool_use", stop_sequence: null },
			usage: { output_tokens: 2 },
		})
		assert.equal(
			output.some((event) => event.type === "message_stop"),
			false,
		)
	}),
)

it.effect("maps refusal deltas to text blocks and emits a refusal terminal reason", () =>
	Effect.gen(function* () {
		const refusalResponse: Generation.GenerationResponse = {
			...response,
			output: [
				{
					type: "message",
					id: "message_1",
					status: "completed",
					role: "assistant",
					content: [{ type: "refusal", refusal: "I cannot help with that" }],
				},
			],
		}
		const output = [
			...(yield* Stream.runCollect(
				encodeStream(
					Stream.make(
						created,
						{
							type: "response.refusal.delta",
							sequence_number: 1,
							item_id: "message_1",
							output_index: 0,
							content_index: 0,
							delta: "I cannot help with that",
						},
						{
							type: "response.refusal.done",
							sequence_number: 2,
							item_id: "message_1",
							output_index: 0,
							content_index: 0,
							refusal: "I cannot help with that",
						},
						{
							type: "response.content_part.done",
							sequence_number: 3,
							item_id: "message_1",
							output_index: 0,
							content_index: 0,
							part: { type: "refusal", refusal: "I cannot help with that" },
						},
						completed(refusalResponse.output),
					),
				),
			)),
		]
		assert.deepEqual(output[2], {
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "I cannot help with that" },
		})
		assert.deepEqual(output.at(-1), {
			type: "message_delta",
			delta: { stop_reason: "refusal", stop_sequence: null },
			usage: { output_tokens: 2 },
		})
	}),
)

it.effect("reuses a built stream with independent block numbering for each subscription", () =>
	Effect.gen(function* () {
		const projected = encodeStream(Stream.make(created, textDelta(1, "Hello"), completed()))
		const first = [...(yield* Stream.runCollect(projected))]
		const second = [...(yield* Stream.runCollect(projected))]
		assert.deepEqual(first, second)
		assert.deepEqual(
			first
				.filter((event) => event.type === "content_block_start")
				.map((event) => event.index),
			[0],
		)
	}),
)

it.effect("emits only the missing suffix when a terminal snapshot completes text", () =>
	Effect.gen(function* () {
		const output = [
			...(yield* Stream.runCollect(
				encodeStream(
					Stream.make(
						created,
						textDelta(1, "Hello"),
						completed([message("Hello world")]),
					),
				),
			)),
		]
		assert.deepEqual(
			output
				.filter((event) => event.type === "content_block_delta")
				.map((event) => event.delta),
			[
				{ type: "text_delta", text: "Hello" },
				{ type: "text_delta", text: " world" },
			],
		)
	}),
)

it.effect("allocates consecutive Anthropic block indices across content parts", () =>
	Effect.gen(function* () {
		const twoPartMessage: Generation.GenerationOutputItem = {
			type: "message",
			id: "message_1",
			status: "completed",
			role: "assistant",
			content: [
				{ type: "output_text", text: "one", annotations: [] },
				{ type: "output_text", text: "two", annotations: [] },
			],
		}
		const output = [
			...(yield* Stream.runCollect(
				encodeStream(
					Stream.make(
						created,
						textAdded(1, 0),
						textDelta(2, "one", 0),
						{
							type: "response.content_part.done",
							sequence_number: 3,
							item_id: "message_1",
							output_index: 0,
							content_index: 0,
							part: { type: "output_text", text: "one", annotations: [] },
						},
						textAdded(4, 1),
						textDelta(5, "two", 1),
						{
							type: "response.content_part.done",
							sequence_number: 6,
							item_id: "message_1",
							output_index: 0,
							content_index: 1,
							part: { type: "output_text", text: "two", annotations: [] },
						},
						toolAdded,
						toolDelta(11, '{"city":"Paris"}'),
						{
							type: "response.output_item.done",
							sequence_number: 12,
							output_index: 1,
							item: tool(),
						},
						completed([twoPartMessage, tool()]),
					),
				),
			)),
		]
		assert.deepEqual(
			output
				.filter((event) => event.type === "content_block_start")
				.map((event) => event.index),
			[0, 1, 2],
		)
		assert.deepEqual(
			output
				.filter((event) => event.type === "content_block_delta")
				.map((event) => event.index),
			[0, 1, 2],
		)
	}),
)

it.effect("preserves nested Schema paths while decoding malformed stream events", () =>
	Effect.gen(function* () {
		const malformed = {
			...created,
			response: {
				...created.response,
				usage: {
					...response.usage,
					input_tokens_details: { cached_tokens: "bad" },
				},
			},
		} as unknown as Generation.GenerationEvent
		const failure = yield* Effect.flip(Stream.runCollect(encodeStream(Stream.make(malformed))))
		assert.equal(failure._tag, "ConversionError")
		assert.equal(failure.reason, "invalid")
		assert.equal(failure.path, "event.response.usage.input_tokens_details.cached_tokens")
	}),
)

it.effect("rejects missing, duplicate, and post-terminal stream events", () =>
	Effect.forEach(
		[
			Stream.make(created),
			Stream.make(created, completed(), completed()),
			Stream.make(created, completed(), textDelta(3, "late")),
		],
		(events) =>
			Effect.gen(function* () {
				const failure = yield* Effect.flip(Stream.runCollect(encodeStream(events)))
				assert.equal(failure._tag, "ConversionError")
				assert.equal(failure.reason, "invalid")
				assert.equal(failure.path, "event.type")
			}),
	),
)

it.effect("rejects unsupported reasoning parts and output items with their event paths", () =>
	Effect.forEach(
		[
			{
				events: eventStream(created, {
					type: "response.reasoning_summary_part.added",
					sequence_number: 1,
					item_id: "reasoning_1",
					output_index: 0,
					summary_index: 0,
					part: { type: "summary_text", text: "hidden" },
				}),
				path: "event.type",
			},
			{
				events: eventStream(created, {
					type: "response.content_part.added",
					sequence_number: 1,
					item_id: "message_1",
					output_index: 0,
					content_index: 0,
					part: { type: "reasoning_text", text: "hidden" },
				}),
				path: "event.part",
			},
			{
				events: eventStream(created, {
					type: "response.output_item.added",
					sequence_number: 1,
					output_index: 0,
					item: {
						type: "reasoning",
						id: "reasoning_1",
						summary: [],
					},
				}),
				path: "event.item",
			},
		],
		({ events, path }) =>
			Effect.gen(function* () {
				const failure = yield* Effect.flip(Stream.runCollect(encodeStream(events)))
				assert.equal(failure._tag, "ConversionError")
				assert.equal(failure.reason, "unsupported")
				assert.equal(failure.path, path)
			}),
	),
)

it.effect("rejects an array tool argument in a stream done event at event.arguments", () =>
	Effect.gen(function* () {
		const failure = yield* Effect.flip(
			Stream.runCollect(
				encodeStream(
					eventStream(created, toolAdded, {
						type: "response.function_call_arguments.done",
						sequence_number: 11,
						item_id: "call_item_1",
						output_index: 1,
						arguments: "[]",
					}),
				),
			),
		)
		assert.equal(failure._tag, "ConversionError")
		assert.equal(failure.reason, "invalid")
		assert.equal(failure.path, "event.arguments")
	}),
)

it.effect("keeps truncated tool JSON portable through an incomplete terminal", () =>
	Effect.gen(function* () {
		const partial = '{"city":'
		const incompleteTool = { ...tool(partial), status: "incomplete" }
		const incomplete: Generation.GenerationEvent = {
			type: "response.incomplete",
			sequence_number: 5,
			response: {
				...response,
				status: "incomplete",
				incomplete_details: { reason: "max_output_tokens" },
				output: [incompleteTool],
			},
		}
		const output = yield* Stream.runCollect(
			encodeStream(
				Stream.make(
					created,
					{
						type: "response.output_item.added",
						sequence_number: 1,
						output_index: 0,
						item: tool(""),
					},
					{
						type: "response.function_call_arguments.delta",
						sequence_number: 2,
						item_id: "call_item_1",
						output_index: 0,
						delta: partial,
					},
					{
						type: "response.function_call_arguments.done",
						sequence_number: 3,
						item_id: "call_item_1",
						output_index: 0,
						arguments: partial,
					},
					{
						type: "response.output_item.done",
						sequence_number: 4,
						output_index: 0,
						item: incompleteTool,
					},
					incomplete,
				),
			),
		)
		assert.deepEqual(
			output.map((event) => event.type),
			[
				"message_start",
				"content_block_start",
				"content_block_delta",
				"content_block_stop",
				"message_delta",
			],
		)
		assert.deepEqual(output.at(-1), {
			type: "message_delta",
			delta: { stop_reason: "max_tokens", stop_sequence: null },
			usage: { output_tokens: 2 },
		})
	}),
)

it.effect("normalizes empty tool arguments to an empty JSON object", () =>
	Effect.gen(function* () {
		const emptyTool = tool("")
		const output = yield* Stream.runCollect(
			encodeStream(
				Stream.make(
					created,
					{
						type: "response.output_item.added",
						sequence_number: 1,
						output_index: 0,
						item: emptyTool,
					},
					{
						type: "response.function_call_arguments.done",
						sequence_number: 2,
						item_id: "call_item_1",
						output_index: 0,
						arguments: "",
					},
					{
						type: "response.output_item.done",
						sequence_number: 3,
						output_index: 0,
						item: emptyTool,
					},
					{
						type: "response.completed",
						sequence_number: 4,
						response: { ...response, output: [emptyTool] },
					},
				),
			),
		)
		assert.deepEqual(
			output.map((event) => event.type),
			["message_start", "content_block_start", "content_block_stop", "message_delta"],
		)
		assert.deepEqual(output.at(1), {
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "call_1", name: "weather", input: {} },
		})
		assert.equal(output.at(-1)?.type, "message_delta")
	}),
)

it.effect("rejects partial tool JSON at a completed terminal arguments path", () =>
	Effect.gen(function* () {
		const partial = '{"city":'
		const failure = yield* Effect.flip(
			Stream.runCollect(
				encodeStream(
					eventStream(
						created,
						{
							type: "response.output_item.added",
							sequence_number: 1,
							output_index: 0,
							item: tool(""),
						},
						{
							type: "response.function_call_arguments.delta",
							sequence_number: 2,
							item_id: "call_item_1",
							output_index: 0,
							delta: partial,
						},
						{
							type: "response.function_call_arguments.done",
							sequence_number: 3,
							item_id: "call_item_1",
							output_index: 0,
							arguments: partial,
						},
						{
							type: "response.output_item.done",
							sequence_number: 4,
							output_index: 0,
							item: tool(partial),
						},
						completed([tool(partial)]),
					),
				),
			),
		)
		assert.equal(failure._tag, "ConversionError")
		assert.equal(failure.reason, "invalid")
		assert.equal(failure.path, "event.response.output[0].arguments")
	}),
)

it.effect("rejects terminal event types that disagree with the response status", () =>
	Effect.forEach(
		[
			{
				type: "response.completed",
				sequence_number: 1,
				response: {
					...response,
					status: "incomplete",
					incomplete_details: { reason: "max_output_tokens" },
				},
			},
			{
				type: "response.incomplete",
				sequence_number: 1,
				response,
			},
		] satisfies readonly Generation.GenerationEvent[],
		(terminalEvent) =>
			Effect.gen(function* () {
				const failure = yield* Effect.flip(
					Stream.runCollect(encodeStream(Stream.make(created, terminalEvent))),
				)
				assert.equal(failure._tag, "ConversionError")
				assert.equal(failure.reason, "invalid")
				assert.equal(failure.path, "event.response.status")
			}),
	),
)

it.effect("rejects a terminal snapshot that omits a previously stopped block", () =>
	Effect.gen(function* () {
		const failure = yield* Effect.flip(
			Stream.runCollect(
				encodeStream(
					eventStream(
						created,
						textDelta(1, "Hello"),
						{
							type: "response.content_part.done",
							sequence_number: 2,
							item_id: "message_1",
							output_index: 0,
							content_index: 0,
							part: { type: "output_text", text: "Hello", annotations: [] },
						},
						completed([]),
					),
				),
			),
		)
		assert.equal(failure._tag, "ConversionError")
		assert.equal(failure.reason, "invalid")
		assert.equal(failure.path, "event.response.output")
	}),
)

it.effect("rejects duplicate tool call ids and output item ids", () =>
	Effect.forEach(
		[
			{
				item: { ...tool(""), id: "call_item_2" },
				path: "event.item.call_id",
			},
			{
				item: { ...tool(""), call_id: "call_2" },
				path: "event.item.id",
			},
		],
		({ item, path }) =>
			Effect.gen(function* () {
				const failure = yield* Effect.flip(
					Stream.runCollect(
						encodeStream(
							eventStream(
								created,
								{
									type: "response.output_item.added",
									sequence_number: 1,
									output_index: 0,
									item: tool(""),
								},
								{
									type: "response.output_item.added",
									sequence_number: 2,
									output_index: 1,
									item,
								},
							),
						),
					),
				)
				assert.equal(failure._tag, "ConversionError")
				assert.equal(failure.reason, "invalid")
				assert.equal(failure.path, path)
			}),
	),
)

it("normalizes empty response tool arguments to an empty input object", () => {
	const result = encodeResponse({ ...response, output: [tool("")] })
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	assert.deepEqual(result.success.content, [
		{ type: "tool_use", id: "call_1", name: "weather", input: {} },
	])
})

it("encodes text and tool output content, parsing tool arguments as a JSON object", () => {
	const input = { ...response, output: [message(), tool()] }
	const snapshot = JSON.stringify(input)
	const result = encodeResponse(input)
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	assert.equal(JSON.stringify(input), snapshot)
	assert.deepEqual(result.success.content, [
		{ type: "text", text: "Hello" },
		{ type: "tool_use", id: "call_1", name: "weather", input: { city: "Paris" } },
	])
	assert.equal(result.success.stop_reason, "tool_use")
})

it("maps response refusal content to Anthropic text blocks", () => {
	const result = encodeResponse({
		...response,
		output: [
			{
				type: "message",
				id: "message_1",
				status: "completed",
				role: "assistant",
				content: [
					{ type: "output_text", text: "Hello", annotations: [] },
					{ type: "refusal", refusal: "No" },
				],
			},
		],
	})
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	assert.deepEqual(result.success.content, [
		{ type: "text", text: "Hello" },
		{ type: "text", text: "No" },
	])
	assert.equal(result.success.stop_reason, "refusal")
})

it("rejects invalid and array tool arguments with the nested arguments path", () => {
	const assertInvalidArguments = (argumentsValue: string) => {
		const result = encodeResponse({ ...response, output: [message(), tool(argumentsValue)] })
		assert.equal(Result.isFailure(result), true)
		if (Result.isSuccess(result)) return
		assert.equal(result.failure.path, "response.output[1].arguments")
	}
	assertInvalidArguments("not json")
	assertInvalidArguments("[]")
})
