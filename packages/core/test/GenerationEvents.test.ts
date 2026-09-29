import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { TestClock } from "effect/testing"
import { fromNative } from "@better-router/core/GenerationEvents"
import type { NativeChunk } from "@better-router/core/GenerationEvents"
import type { GenerationRequest } from "@better-router/core/Generation"

const request: GenerationRequest = { model: "public", input: [] }

it.effect("assembles text and tool deltas into ordered terminal events", () =>
	Effect.gen(function* () {
		yield* TestClock.adjust(1_234_000)
		const events = yield* Stream.runCollect(
			fromNative(
				request,
				Stream.make(
					{ type: "start" as const, id: "response_1", createdAt: 100, model: "private" },
					{ type: "text" as const, value: "Hello" },
					{ type: "tool_start" as const, id: "call_1", name: "lookup" },
					{ type: "tool_delta" as const, id: "call_1", value: '{"q":"A"}' },
					{ type: "finish" as const, reason: "length" as const },
				),
			),
		)
		assert.deepEqual(
			events.map((event) => event.type),
			[
				"response.created",
				"response.output_item.added",
				"response.content_part.added",
				"response.output_text.delta",
				"response.output_item.added",
				"response.function_call_arguments.delta",
				"response.output_text.done",
				"response.content_part.done",
				"response.output_item.done",
				"response.function_call_arguments.done",
				"response.output_item.done",
				"response.incomplete",
			],
		)
		assert.deepEqual(
			events.map((event) => event.sequence_number),
			events.map((_, index) => index),
		)
		const terminal = events.at(-1)
		assert.equal(terminal?.type, "response.incomplete")
		if (terminal?.type === "response.incomplete")
			assert.equal(terminal.response.incomplete_details?.reason, "max_output_tokens")
	}),
)

it.effect("rejects output before identity and streams independently per subscription", () =>
	Effect.gen(function* () {
		const invalid = yield* Effect.flip(
			Stream.runCollect(
				fromNative(request, Stream.succeed({ type: "text" as const, value: "late" })),
			),
		)
		assert.equal(invalid.kind, "unknown")

		const source = fromNative(
			request,
			Stream.make(
				{ type: "start" as const, id: "response_2", createdAt: 100, model: "private" },
				{ type: "text" as const, value: "Hi" },
				{ type: "finish" as const, reason: "stop" as const },
			),
		)
		const first = yield* Stream.runCollect(source)
		const second = yield* Stream.runCollect(source)
		assert.deepEqual(first, second)
	}),
)

it.effect("rejects invalid native state transitions and preserves content-filter terminals", () =>
	Effect.gen(function* () {
		const invalid: readonly (readonly NativeChunk[])[] = [
			[{ type: "start", id: "", createdAt: 1, model: "private" }],
			[{ type: "start", id: "response", createdAt: Number.NaN, model: "private" }],
			[
				{ type: "start", id: "response", createdAt: 1, model: "private" },
				{ type: "start", id: "response-2", createdAt: 2, model: "private" },
			],
			[
				{ type: "start", id: "response", createdAt: 1, model: "private" },
				{ type: "tool_delta", id: "missing", value: "{}" },
			],
			[
				{ type: "start", id: "response", createdAt: 1, model: "private" },
				{ type: "tool_start", id: "call", name: "lookup" },
				{ type: "tool_start", id: "call", name: "lookup" },
			],
			[
				{ type: "start", id: "response", createdAt: 1, model: "private" },
				{ type: "text", value: "unfinished" },
			],
			[
				{ type: "start", id: "response", createdAt: 1, model: "private" },
				{ type: "finish", reason: "stop" },
				{ type: "text", value: "late" },
			],
		]
		yield* Effect.forEach(invalid, (chunks) =>
			Effect.gen(function* () {
				const error = yield* Effect.flip(
					Stream.runCollect(fromNative(request, Stream.fromIterable(chunks))),
				)
				assert.equal(error.kind, "unknown")
			}),
		)
		const events = yield* Stream.runCollect(
			fromNative(
				request,
				Stream.make(
					{
						type: "start" as const,
						id: "response_filter",
						createdAt: 1,
						model: "private",
					},
					{ type: "text" as const, value: "blocked" },
					{ type: "finish" as const, reason: "content_filter" as const },
				),
			),
		)
		const terminal = events.at(-1)
		if (terminal?.type !== "response.incomplete") assert.fail("Expected incomplete response")
		assert.equal(terminal.response.incomplete_details?.reason, "content_filter")
	}),
)
