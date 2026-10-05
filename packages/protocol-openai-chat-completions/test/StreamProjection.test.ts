import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Ref, Result, Schema, Stream } from "effect"
import type {
	FunctionCallOutputItem,
	GenerationEvent,
	GenerationOutputItem,
	GenerationResponse,
	MessageOutput,
} from "@better-router/core/Generation"
import { ConversionError } from "@better-router/core/Convert"
import {
	decodeStreamOptions,
	encodeResponse,
	encodeStream,
} from "@better-router/protocol-openai-chat-completions/Convert"
import type { StreamOptions } from "@better-router/protocol-openai-chat-completions/Convert"

const response = (
	status: "in_progress" | "completed" | "incomplete" = "in_progress",
	output: readonly GenerationOutputItem[] = [],
): GenerationResponse => ({
	id: "resp_1",
	object: "response",
	created_at: 42,
	completed_at: status === "in_progress" ? null : 43,
	status,
	incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
	model: "public",
	previous_response_id: null,
	instructions: null,
	output,
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
	usage:
		status === "in_progress"
			? null
			: {
					input_tokens: 3,
					output_tokens: 5,
					total_tokens: 8,
					input_tokens_details: { cached_tokens: 1 },
					output_tokens_details: { reasoning_tokens: 2 },
				},
	max_output_tokens: null,
	max_tool_calls: null,
	store: false,
	background: false,
	service_tier: "default",
	metadata: null,
	safety_identifier: null,
	prompt_cache_key: null,
})

const created: GenerationEvent = {
	type: "response.created",
	sequence_number: 0,
	response: response(),
}

const message: MessageOutput = {
	type: "message",
	id: "message_1",
	status: "completed",
	role: "assistant",
	content: [{ type: "output_text", text: "Hello", annotations: [] }],
}

const tool = (
	call_id: string,
	name: string,
	args: string,
	status: "in_progress" | "completed" = "completed",
): FunctionCallOutputItem => ({
	type: "function_call",
	id: `item_${call_id}`,
	status,
	call_id,
	name,
	arguments: args,
})

const event = (value: object, sequence_number: number): GenerationEvent =>
	({ ...value, sequence_number }) as GenerationEvent

const textEvents: readonly GenerationEvent[] = [
	created,
	event({ type: "response.in_progress", response: response() }, 1),
	event(
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...message, status: "in_progress", content: [] },
		},
		2,
	),
	event(
		{
			type: "response.content_part.added",
			item_id: message.id,
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		3,
	),
	event(
		{
			type: "response.output_text.delta",
			item_id: message.id,
			output_index: 0,
			content_index: 0,
			delta: "Hello",
		},
		4,
	),
	event(
		{
			type: "response.output_text.done",
			item_id: message.id,
			output_index: 0,
			content_index: 0,
			text: "Hello",
		},
		5,
	),
	event(
		{
			type: "response.content_part.done",
			item_id: message.id,
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "Hello", annotations: [] },
		},
		6,
	),
	event({ type: "response.output_item.done", output_index: 0, item: message }, 7),
	event({ type: "response.completed", response: response("completed", [message]) }, 8),
]

const toolEvents: readonly GenerationEvent[] = [
	...textEvents.slice(0, -1),
	event(
		{
			type: "response.output_item.added",
			output_index: 1,
			item: { ...tool("call_1", "weather", "", "in_progress") },
		},
		1,
	),
	event(
		{
			type: "response.output_item.added",
			output_index: 2,
			item: { ...tool("call_2", "time", "", "in_progress") },
		},
		2,
	),
	event(
		{
			type: "response.function_call_arguments.delta",
			item_id: "item_call_1",
			output_index: 1,
			delta: '{"city":"Paris"}',
		},
		3,
	),
	event(
		{
			type: "response.function_call_arguments.delta",
			item_id: "item_call_2",
			output_index: 2,
			delta: "{}",
		},
		4,
	),
	event(
		{
			type: "response.function_call_arguments.done",
			item_id: "item_call_1",
			output_index: 1,
			arguments: '{"city":"Paris"}',
		},
		5,
	),
	event(
		{
			type: "response.function_call_arguments.done",
			item_id: "item_call_2",
			output_index: 2,
			arguments: "{}",
		},
		6,
	),
	event(
		{
			type: "response.output_item.done",
			output_index: 1,
			item: tool("call_1", "weather", '{"city":"Paris"}'),
		},
		7,
	),
	event(
		{
			type: "response.output_item.done",
			output_index: 2,
			item: tool("call_2", "time", "{}"),
		},
		8,
	),
	event(
		{
			type: "response.completed",
			response: response("completed", [
				message,
				tool("call_1", "weather", '{"city":"Paris"}'),
				tool("call_2", "time", "{}"),
			]),
		},
		9,
	),
].map((event, sequence_number) => ({ ...event, sequence_number }))

type Chunk = Readonly<{
	id: string
	model: string
	created: number
	choices: readonly Readonly<{
		index: number
		delta: Readonly<{
			role?: string
			content?: string
			refusal?: string
			tool_calls?: readonly Readonly<{
				index: number
				id?: string
				function: Readonly<{ name?: string; arguments: string }>
			}>[]
		}>
		finish_reason: string | null
	}>[]
	usage?: unknown
}>

const asChunk = (value: Readonly<Record<string, unknown>>): Chunk => value as unknown as Chunk

const collect = (events: readonly GenerationEvent[], options?: StreamOptions) =>
	Stream.runCollect(encodeStream(Stream.fromIterable(events), options))

it.effect("filters structural events and keeps identity across text chunks", () =>
	Effect.gen(function* () {
		const values = yield* collect(textEvents, { includeUsage: true })
		const chunks = values.map(asChunk)
		assert.equal(chunks.length, 4)
		assert.deepEqual(
			chunks.map((value) => [value.id, value.model, value.created]),
			chunks.map(() => ["resp_1", "public", 42]),
		)
		assert.ok(chunks.slice(0, 3).every((value) => value.choices[0]?.index === 0))
		assert.deepEqual(chunks[3]?.choices, [])
		assert.equal(chunks[0]?.choices[0]?.delta.role, "assistant")
		assert.equal(chunks[1]?.choices[0]?.delta.content, "Hello")
		assert.equal(chunks[2]?.choices[0]?.finish_reason, "stop")
		assert.deepEqual(chunks[3]?.usage, {
			prompt_tokens: 3,
			completion_tokens: 5,
			total_tokens: 8,
			prompt_tokens_details: { cached_tokens: 1 },
			completion_tokens_details: { reasoning_tokens: 2 },
		})
	}),
)

it.effect("maps tool output indices to contiguous Chat Completions indices per subscription", () =>
	Effect.gen(function* () {
		const projected = encodeStream(Stream.fromIterable(toolEvents))
		const first = (yield* Stream.runCollect(projected)).map(asChunk)
		const second = (yield* Stream.runCollect(projected)).map(asChunk)
		const calls = first.flatMap((value) => value.choices[0]?.delta.tool_calls ?? [])
		assert.deepEqual(
			calls.map((value) => value.index),
			[0, 1, 0, 1],
		)
		assert.deepEqual(
			calls.slice(0, 2).map((value) => [value.id, value.function.name]),
			[
				["call_1", "weather"],
				["call_2", "time"],
			],
		)
		assert.equal(first.at(-1)?.choices[0]?.finish_reason, "tool_calls")
		assert.deepEqual(first, second)
	}),
)

it.effect("decodes each event, rejects unsupported output, and requires a terminal", () =>
	Effect.gen(function* () {
		const malformed = {
			...created,
			response: {
				...created.response,
				output: [
					{ ...message, content: [{ type: "output_text", text: 1, annotations: [] }] },
				],
			},
		} as unknown as GenerationEvent
		const malformedError = yield* Effect.flip(collect([malformed]))
		assert.equal(Schema.is(ConversionError)(malformedError), true)
		assert.equal(malformedError.path, "event.response.output[0].content[0].text")

		const extension = event({ type: "acme:unknown" }, 1)
		const unsupportedError = yield* Effect.flip(collect([created, extension]))
		assert.equal(unsupportedError.path, "event.type")
		assert.equal(unsupportedError.reason, "unsupported")

		const missingError = yield* Effect.flip(collect([created]))
		assert.equal(missingError.path, "event.type")
		assert.equal(missingError.reason, "invalid")
	}),
)

it.effect("projects refusal deltas and preserves incomplete finish reasons", () =>
	Effect.forEach(
		[
			{ reason: "max_output_tokens", finish: "length" },
			{ reason: "content_filter", finish: "content_filter" },
		] as const,
		({ reason, finish }) =>
			Effect.gen(function* () {
				const refused: MessageOutput = {
					...message,
					content: [{ type: "refusal", refusal: "Cannot comply" }],
				}
				const values = (yield* collect([
					created,
					event(
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { ...refused, content: [] },
						},
						1,
					),
					event(
						{
							type: "response.content_part.added",
							output_index: 0,
							item_id: refused.id,
							content_index: 0,
							part: { type: "refusal", refusal: "" },
						},
						2,
					),
					event(
						{
							type: "response.refusal.delta",
							output_index: 0,
							item_id: refused.id,
							content_index: 0,
							delta: "Cannot comply",
						},
						3,
					),
					event(
						{
							type: "response.refusal.done",
							output_index: 0,
							item_id: refused.id,
							content_index: 0,
							refusal: "Cannot comply",
						},
						4,
					),
					event(
						{
							type: "response.content_part.done",
							output_index: 0,
							item_id: refused.id,
							content_index: 0,
							part: { type: "refusal", refusal: "Cannot comply" },
						},
						5,
					),
					event({ type: "response.output_item.done", output_index: 0, item: refused }, 6),
					event(
						{
							type: "response.incomplete",
							response: {
								...response("incomplete", [refused]),
								incomplete_details: { reason },
							},
						},
						7,
					),
				])).map(asChunk)
				assert.equal(values.length, 3)
				assert.equal(values[1]?.choices[0]?.delta.refusal, "Cannot comply")
				assert.equal(values[2]?.choices[0]?.finish_reason, finish)
			}),
	),
)

it.effect("rejects duplicate terminals, events after terminal and failed responses", () =>
	Effect.forEach(
		[
			{
				events: [...textEvents, textEvents[textEvents.length - 1]!],
				path: "event.type",
				reason: "invalid",
			},
			{
				events: [
					...textEvents,
					event({ type: "response.in_progress", response: response() }, 10),
				],
				path: "event.type",
				reason: "invalid",
			},
			{
				events: [
					created,
					event(
						{
							type: "response.failed",
							response: {
								...response(),
								status: "failed",
								error: { code: "upstream_error", message: "provider failed" },
							},
						},
						1,
					),
				],
				path: "event.response.error",
				reason: "invalid",
			},
			{
				events: [
					created,
					event(
						{
							type: "response.content_part.added",
							output_index: 0,
							item_id: message.id,
							content_index: 0,
							part: {
								type: "input_image",
								image_url: "https://example.com/image.png",
							},
						},
						1,
					),
				],
				path: "event.part.type",
				reason: "unsupported",
			},
			{
				events: [
					created,
					event(
						{
							type: "response.completed",
							response: { ...response("completed"), id: "changed" },
						},
						1,
					),
				],
				path: "event.response.id",
				reason: "invalid",
			},
		] as const,
		({ events, path, reason }) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(collect(events))
				assert.equal(error.path, path)
				assert.equal(error.reason, reason)
			}),
	),
)

it.effect("preserves upstream failure and releases a suspended source on cancellation", () =>
	Effect.gen(function* () {
		const upstream = { _tag: "UpstreamError" } as const
		const error = yield* Effect.flip(
			Stream.runCollect(
				encodeStream(Stream.concat(Stream.succeed(created), Stream.fail(upstream))),
			),
		)
		assert.equal(error, upstream)
		const released = yield* Ref.make(0)
		const suspended = yield* Deferred.make<void>()
		const source = Stream.concat(
			Stream.succeed(created),
			Stream.fromEffect(
				Deferred.succeed(suspended, undefined).pipe(Effect.andThen(Effect.never)),
			),
		).pipe(Stream.ensuring(Ref.update(released, (count) => count + 1)))
		const fiber = yield* Stream.runCollect(encodeStream(source)).pipe(Effect.forkScoped)
		yield* Deferred.await(suspended)
		yield* Fiber.interrupt(fiber)
		assert.equal(yield* Ref.get(released), 1)
	}),
)

it("uses tool finish reasons and detailed usage for JSON responses", () => {
	const input = response("completed", [tool("call_1", "weather", "{}")])
	const before = JSON.stringify(input)
	const result = encodeResponse(input)
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	const value = result.success
	assert.equal(
		(value.choices as readonly { finish_reason: string }[])[0]?.finish_reason,
		"tool_calls",
	)
	assert.deepEqual(value.usage, {
		prompt_tokens: 3,
		completion_tokens: 5,
		total_tokens: 8,
		prompt_tokens_details: { cached_tokens: 1 },
		completion_tokens_details: { reasoning_tokens: 2 },
	})
	assert.equal(JSON.stringify(input), before)
})

it("decodes stream usage options with full nested error paths", () => {
	const request = {
		model: "public",
		messages: [{ role: "user", content: "Hi" }],
		stream: true,
		stream_options: { include_usage: true },
	}
	const result = decodeStreamOptions(request)
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	assert.deepEqual(result.success, { includeUsage: true })
	const malformed = decodeStreamOptions({ ...request, stream_options: { include_usage: 1 } })
	assert.equal(Result.isFailure(malformed), true)
	if (Result.isSuccess(malformed)) return
	assert.equal(malformed.failure.path, "request.stream_options.include_usage")
})

it.effect("rejects final output that differs from emitted deltas", () =>
	Effect.forEach(
		[
			{
				events: [
					created,
					event(
						{ type: "response.completed", response: response("completed", [message]) },
						1,
					),
				],
				path: "event.response.output[0].content",
			},
			{
				events: [
					created,
					event(
						{
							type: "response.output_text.delta",
							item_id: message.id,
							output_index: 0,
							content_index: 0,
							delta: "He",
						},
						1,
					),
					event(
						{
							type: "response.output_text.done",
							item_id: message.id,
							output_index: 0,
							content_index: 0,
							text: "Hello",
						},
						2,
					),
				],
				path: "event.text",
			},
			{
				events: [
					created,
					event(
						{
							type: "response.output_item.added",
							output_index: 0,
							item: tool("call_1", "weather", "", "in_progress"),
						},
						1,
					),
					event(
						{
							type: "response.function_call_arguments.done",
							output_index: 0,
							item_id: "item_call_1",
							arguments: "{}",
						},
						2,
					),
				],
				path: "event.arguments",
			},
		] as const,
		({ events, path }) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(collect(events))
				assert.equal(error.path, path)
				assert.equal(error.reason, "invalid")
			}),
	),
)
