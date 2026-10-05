import assert from "node:assert/strict"
import { Result } from "effect"
import { it } from "vitest"
import { decodeRequest } from "@better-router/protocol-anthropic-messages/Convert"

it("projects Anthropic tool choices and structured output into Generation", () => {
	const result = decodeRequest({
		model: "public",
		messages: [{ role: "user", content: "Find the weather" }],
		max_tokens: 128,
		tools: [{ name: "weather", input_schema: { type: "object" } }],
		tool_choice: { type: "tool", name: "weather" },
		output_config: { format: { type: "json_schema", schema: { type: "object" } } },
	})
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	assert.equal(result.success.model, "public")
	assert.deepEqual(result.success.tool_choice, { type: "function", name: "weather" })
	assert.deepEqual(result.success.text?.format, {
		type: "json_schema",
		name: "response",
		schema: { type: "object" },
	})
})

it("keeps conversion issue paths for unsupported system blocks", () => {
	const result = decodeRequest({
		model: "public",
		messages: [{ role: "user", content: "Hi" }],
		max_tokens: 128,
		system: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
	})
	assert.equal(Result.isFailure(result), true)
	if (Result.isSuccess(result)) return
	assert.equal(result.failure.path, "request.system[0]")
})

it("rejects unknown top-level request parameters with a nested path", () => {
	const result = decodeRequest({
		model: "public",
		messages: [{ role: "user", content: "Hi" }],
		max_tokens: 128,
		unsupported_parameter: true,
	})
	assert.equal(Result.isFailure(result), true)
	if (Result.isSuccess(result)) return
	assert.equal(result.failure.reason, "unsupported")
	assert.equal(result.failure.path, "request.unsupported_parameter")
})
