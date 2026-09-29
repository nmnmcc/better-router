import assert from "node:assert/strict"
import { it } from "vitest"
import { Result, Schema } from "effect"
import { ConversionError, at, fromSchema, requireThat } from "@better-router/core/Conversion"

it("formats conversion errors with a stable path and reason", () => {
	const error = at("request.input[0].content[1]", "unsupported", "audio is not portable")
	const encoded = Schema.encodeSync(ConversionError)(error)
	assert.deepEqual(encoded, {
		_tag: "ConversionError",
		path: "request.input[0].content[1]",
		reason: "unsupported",
		message: "request.input[0].content[1]: audio is not portable",
	})
	assert.equal(error.message, encoded.message)
})

it("retains nested array and property paths from Schema issues", () => {
	const schema = Schema.Struct({
		input: Schema.Array(
			Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
		),
	})
	const decoded = Schema.decodeUnknownResult(schema)({
		input: [{ content: [{ text: "ok" }, { text: 42 }] }],
	})
	assert.equal(Result.isFailure(decoded), true)
	if (Result.isSuccess(decoded)) return
	const error = fromSchema(decoded.failure, "request")
	assert.equal(error.path, "request.input[0].content[1].text")
	assert.equal(error.reason, "invalid")
})

it("turns semantic predicates into Result values", () => {
	const check = requireThat(
		false,
		"request.tools[0].type",
		"unsupported",
		"only functions are portable",
	)
	assert.equal(Result.isFailure(check), true)
	if (Result.isSuccess(check)) return
	assert.equal(check.failure.path, "request.tools[0].type")
	assert.equal(Result.isSuccess(requireThat(true, "request.model", "invalid", "required")), true)
})
