import assert from "node:assert/strict"
import { HashMap, Result, Stream } from "effect"
import { it } from "vitest"
import { ConversionError } from "@better-router/core/Conversion"
import { toGeneration, view } from "@better-router/core/Projection"
import type { Command, ProtocolDefinition } from "@better-router/core/Projection"

const request = { model: "public", input: [] } as const
const definition: ProtocolDefinition<string, string> = {
	id: "test.protocol",
	protocol: "test.protocol",
	capability: "generation",
	decode: (value) =>
		typeof value === "string"
			? Result.succeed({
					model: "public",
					input: [{ type: "message", role: "user", content: value }],
				})
			: Result.fail(
					ConversionError.make({
						path: "request.body",
						reason: "invalid",
						message: "request.body: expected string",
					}),
				),
	encodeEvent: (event) => Result.succeed(JSON.stringify(event)),
	encodeResponse: (response) => Result.succeed(JSON.stringify(response)),
	encodeEvents: (events) => Stream.map(events, (event) => JSON.stringify(event)),
}

const definitions = HashMap.make([definition.protocol, definition] as const)

it("keeps generation commands as generation views", () => {
	const command: Command = { type: "generation", request }
	assert.deepEqual(view(command), { type: "generation", request })
	assert.deepEqual(toGeneration(command, definitions), Result.succeed(request))
})

it("decodes registered protocol commands and keeps opaque views on failure", () => {
	const command: Command = {
		type: "protocol",
		request: { protocol: "test.protocol", model: "public", body: "hello", headers: {} },
	}
	const converted = toGeneration(command, definitions)
	assert.equal(Result.isSuccess(converted), true)
	assert.deepEqual(view(command, definitions), {
		type: "generation",
		request: { model: "public", input: [{ type: "message", role: "user", content: "hello" }] },
	})

	const invalid = { ...command, request: { ...command.request, body: 42 } }
	assert.equal(Result.isFailure(toGeneration(invalid, definitions)), true)
	assert.deepEqual(view(invalid, definitions), {
		type: "opaque",
		protocol: "test.protocol",
		model: "public",
	})
})

it("reports missing projection catalogs as unsupported conversion data", () => {
	const command: Command = {
		type: "protocol",
		request: { protocol: "missing.protocol", model: "public", body: {}, headers: {} },
	}
	const converted = toGeneration(command, HashMap.empty())
	assert.equal(Result.isFailure(converted), true)
	if (Result.isSuccess(converted)) return
	assert.equal(converted.failure._tag, "ConversionError")
	assert.equal(converted.failure.path, "request.protocol")
	assert.equal(converted.failure.reason, "unsupported")
	assert.equal(converted.failure.message, "No projection is registered for missing.protocol")
	assert.deepEqual(view(command), {
		type: "opaque",
		protocol: "missing.protocol",
		model: "public",
	})
})
