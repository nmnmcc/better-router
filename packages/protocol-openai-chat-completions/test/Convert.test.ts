import assert from "node:assert/strict"
import { Result } from "effect"
import { it } from "vitest"
import { decodeRequest } from "@better-router/protocol-openai-chat-completions/Convert"

it("rejects stream options without a streaming request", () => {
	const result = decodeRequest({
		model: "public",
		messages: [{ role: "user", content: "Hi" }],
		stream_options: { include_usage: true },
	})
	assert.equal(Result.isFailure(result), true)
	if (Result.isSuccess(result)) return
	assert.equal(result.failure.path, "request.stream_options")
})

it("rejects unknown top-level request parameters with a nested path", () => {
	const result = decodeRequest({
		model: "public",
		messages: [{ role: "user", content: "Hi" }],
		unsupported_parameter: true,
	})
	assert.equal(Result.isFailure(result), true)
	if (Result.isSuccess(result)) return
	assert.equal(result.failure.reason, "unsupported")
	assert.equal(result.failure.path, "request.unsupported_parameter")
})

const assertFailurePath = (value: unknown, path: string) => {
	const result = decodeRequest(value)
	assert.equal(Result.isFailure(result), true)
	if (Result.isSuccess(result)) return
	assert.equal(result.failure.path, path)
}

it("rejects unknown nested message fields with their full path", () => {
	assertFailurePath(
		{
			model: "public",
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Hi", unsupported_part: true }],
				},
			],
		},
		"request.messages[0].content[0].unsupported_part",
	)
})

it("rejects unknown nested tool fields with their full path", () => {
	assertFailurePath(
		{
			model: "public",
			messages: [
				{
					role: "assistant",
					content: null,
					tool_calls: [
						{
							id: "call_1",
							type: "function",
							function: {
								name: "weather",
								arguments: "{}",
								unsupported_function_field: true,
							},
						},
					],
				},
			],
		},
		"request.messages[0].tool_calls[0].function.unsupported_function_field",
	)
})

it("rejects unknown response and stream option fields with their full paths", () => {
	assertFailurePath(
		{
			model: "public",
			messages: [{ role: "user", content: "Hi" }],
			response_format: {
				type: "json_schema",
				json_schema: { name: "answer", unsupported_schema_field: true },
			},
		},
		"request.response_format.json_schema.unsupported_schema_field",
	)
	assertFailurePath(
		{
			model: "public",
			messages: [{ role: "user", content: "Hi" }],
			stream: true,
			stream_options: { include_usage: true, unsupported_stream_field: true },
		},
		"request.stream_options.unsupported_stream_field",
	)
})

it("rejects unsupported obfuscation even when disabled", () => {
	assertFailurePath(
		{
			model: "public",
			messages: [{ role: "user", content: "Hi" }],
			stream: true,
			stream_options: { include_obfuscation: false },
		},
		"request.stream_options.include_obfuscation",
	)
})

it("projects function calls and preserves nested content paths", () => {
	const result = decodeRequest({
		model: "public",
		messages: [
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "weather", arguments: "{}" },
					},
				],
			},
		],
	})
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	const call = Array.isArray(result.success.input)
		? result.success.input.find((item) => item.type === "function_call")
		: undefined
	assert.equal(call?.type, "function_call")
})
