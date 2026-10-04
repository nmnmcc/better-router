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
