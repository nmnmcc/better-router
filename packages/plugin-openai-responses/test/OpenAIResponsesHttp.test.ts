import assert from "node:assert/strict"
import { it as effectTest } from "@effect/vitest"
import { Effect, Result, Schema, Stream } from "effect"
import { OpenApi } from "effect/http-api"
import { it } from "vitest"
import type { GenerationEvent } from "@better-router/core/Generation"
import { snapshot } from "@better-router/core/GenerationEvents"
import {
	OpenAIResponsesHttpError,
	api,
	projection,
	toNativeRequest,
	toResponseRequest,
} from "@better-router/plugin-openai-responses/OpenAIResponsesHttp"

it("normalizes supported input parts without changing their source form", () => {
	const input = {
		model: "private",
		input: [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "Hi" },
					{ type: "input_image", image_url: "https://example.com/a.png", detail: "auto" },
				],
			},
		],
		tools: [],
	} as const
	const before = structuredClone(input)
	const result = toResponseRequest(input)
	assert.ok(Result.isSuccess(result))
	assert.deepEqual(result.success, {
		model: "private",
		input: [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "Hi" },
					{ type: "input_image", image_url: "https://example.com/a.png", detail: "auto" },
				],
			},
		],
		tools: [],
	})
	assert.deepEqual(input, before)
})

it("reports item semantics before nested image facts", () => {
	const result = toResponseRequest({
		model: "private",
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_image", image_url: "not-a-url" }],
			},
			{ type: "reasoning", summary: [] },
		],
	})
	assert.ok(Result.isFailure(result))
	assert.equal(result.failure.path, "request.input[1].type")
	assert.equal(result.failure.reason, "unsupported")
})

it("reports the first unsupported part before invalid image data", () => {
	const result = toResponseRequest({
		model: "private",
		input: [
			{
				type: "message",
				role: "user",
				content: [
					{ type: "input_text", text: "Hi", cache_control: { type: "ephemeral" } },
					{ type: "input_image", image_url: "not-a-url" },
				],
			},
		],
	})
	assert.ok(Result.isFailure(result))
	assert.equal(result.failure.path, "request.input[0].content[0].cache_control")
	assert.equal(result.failure.reason, "unsupported")
})

it("decodes the native request selector and preserves extension fields in the wire schema", () => {
	assert.deepEqual(
		toNativeRequest({ model: "private", stream: true, trace_id: "trace" }),
		Result.succeed({ model: "private", stream: true }),
	)
	const missing = toNativeRequest({ stream: true })
	assert.ok(Result.isFailure(missing))
	assert.equal(missing.failure.path, "request.model")
	const encoded = Schema.encodeSync(OpenAIResponsesHttpError)({
		error: { message: "bad", type: "invalid_request_error" },
	})
	assert.deepEqual(encoded, {
		error: { message: "bad", type: "invalid_request_error" },
	})
	assert.ok(
		Result.isFailure(
			Schema.decodeUnknownResult(OpenAIResponsesHttpError)({
				error: { message: "bad" },
			}),
		),
	)
})

it("rejects semantic fields with stable issue paths after wire decoding", () => {
	const cases = [
		[{ model: "private", input: "Hi", unsupported: true }, "request.unsupported"],
		[
			{
				model: "private",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_image", image_url: "javascript:alert(1)" }],
					},
				],
			},
			"request.input[0].content[0].image_url",
		],
		[
			{
				model: "private",
				input: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "Hi", extra: true }],
					},
				],
			},
			"request.input[0].content[0].extra",
		],
		[
			{ model: "private", input: [{ type: "reasoning", summary: [] }] },
			"request.input[0].type",
		],
		[{ model: "private", tools: [{ type: "acme:web_search" }] }, "request.tools[0].type"],
	] as const
	assert.deepEqual(
		cases.map(([value]) => {
			const result = toResponseRequest(value)
			return Result.isFailure(result) && [result.failure.path, result.failure.reason]
		}),
		cases.map(([, path]) => [path, "unsupported"]),
	)
	const invalid = toResponseRequest({ model: "", input: "Hi" })
	assert.ok(Result.isFailure(invalid))
	assert.equal(invalid.failure.path, "request.model")
	assert.equal(invalid.failure.reason, "invalid")
})

const events = (status: "completed" | "incomplete" = "completed"): readonly GenerationEvent[] =>
	[
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
		{
			type: status === "completed" ? "response.completed" : "response.incomplete",
			sequence_number: 1,
			response: snapshot({ model: "private" }, "resp_1", 1, "private", [], status, null, 2),
		},
	] as const

const completedResponse = snapshot(
	{ model: "private" },
	"resp_1",
	1,
	"private",
	[],
	"completed",
	null,
	2,
)

effectTest.effect("encodes responses events with monotonic sequence numbers and [DONE]", () =>
	Effect.gen(function* () {
		const output = yield* Stream.runCollect(
			projection.encodeEvents!(Stream.fromIterable(events()), { model: "public" }),
		)
		const text = Array.from(output).join("")
		assert.match(text, /event: response.created/)
		assert.match(text, /"sequence_number":0/)
		assert.match(text, /"sequence_number":1/)
		assert.match(text, /"model":"public"/)
		assert.match(text, /data: \[DONE\]/)
		const incomplete = yield* Stream.runCollect(
			projection.encodeEvents!(Stream.fromIterable(events("incomplete")), {
				model: "public",
			}),
		)
		assert.match(Array.from(incomplete).join(""), /response.incomplete/)
	}),
)

effectTest.effect("turns projection failures into an SSE error without claiming completion", () =>
	Effect.gen(function* () {
		const output = yield* Stream.runCollect(
			projection.encodeEvents!(
				Stream.fromIterable([
					...events(),
					{ type: "response.completed", sequence_number: 2, response: completedResponse },
				] as GenerationEvent[]),
				{ model: "public" },
			),
		)
		const text = Array.from(output).join("")
		assert.match(text, /event: error/)
		assert.match(text, /Events followed the terminal response/)
		assert.doesNotMatch(text, /data: \[DONE\]/)
		assert.ok(Result.isSuccess(projection.encodeEvent!(events()[0]!)))
		assert.ok(Result.isSuccess(projection.encodeResponse!(completedResponse)))
	}),
)

it("declares all gateway error statuses", () => {
	const responses = OpenApi.fromApi(api).paths["/v1/responses"]!.post!.responses
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
})
