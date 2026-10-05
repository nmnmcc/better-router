import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Result, Schema } from "effect"
import * as Capability from "@better-router/core/Capability"

it("decodes endpoint capability declarations and keeps their shape", () => {
	const decoded = Capability.decode({
		id: "provider.openai",
		version: 1,
		kind: "provider",
		projections: ["responses"],
		endpoints: [
			{
				id: "responses",
				parameters: ["temperature", "tools"],
				streaming: true,
				capabilities: ["generation", "tool-calling"],
			},
		],
	})

	assert.equal(decoded._tag, "Success")
	if (Result.isSuccess(decoded)) {
		assert.equal(decoded.success.id, "provider.openai")
		assert.deepEqual(decoded.success.endpoints?.[0]?.parameters, ["temperature", "tools"])
		assert.deepEqual(decoded.success.endpoints?.[0]?.capabilities, [
			"generation",
			"tool-calling",
		])
	}
})

it("retains nested Schema issue paths for malformed endpoint values", () => {
	const decoded = Capability.decode({
		id: "provider.openai",
		version: 1,
		kind: "provider",
		projections: ["responses"],
		endpoints: [
			{
				id: "responses",
				parameters: ["temperature", 42],
				streaming: true,
			},
		],
	})

	assert.equal(decoded._tag, "Failure")
	if (Result.isFailure(decoded)) {
		assert.equal(decoded.failure._tag, "CapabilityError")
		assert.equal(decoded.failure.id, "unknown")
		assert.equal(
			decoded.failure.issues?.some(
				(issue) =>
					issue.message.length > 0 && issue.path.join(".") === "endpoints.0.parameters.1",
			),
			true,
		)
	}
})

it("clones trusted declaration arrays when making a capability", () => {
	const projections = ["responses"] as const
	const parameters = ["temperature"] as const
	const capabilities = ["generation"] as const
	const capability = Capability.make({
		id: "provider.openai",
		version: 1,
		kind: "provider",
		projections,
		endpoints: [{ id: "responses", parameters, streaming: true, capabilities }],
	})

	assert.notEqual(capability.projections, projections)
	assert.notEqual(capability.endpoints, undefined)
	assert.notEqual(capability.endpoints?.[0]?.parameters, parameters)
	assert.notEqual(capability.endpoints?.[0]?.capabilities, capabilities)
	assert.deepEqual(capability.projections, ["responses"])
	assert.deepEqual(capability.endpoints?.[0]?.parameters, ["temperature"])
	assert.deepEqual(capability.endpoints?.[0]?.capabilities, ["generation"])
})

it("retains endpoint-local capability issue paths", () => {
	const decoded = Capability.decode({
		id: "provider.openai",
		version: 1,
		kind: "provider",
		projections: [],
		endpoints: [
			{
				id: "responses",
				parameters: [],
				streaming: true,
				capabilities: ["generation", 42],
			},
		],
	})
	assert.equal(decoded._tag, "Failure")
	if (Result.isFailure(decoded)) {
		assert.equal(
			decoded.failure.issues?.some(
				(issue) => issue.path.join(".") === "endpoints.0.capabilities.1",
			),
			true,
		)
	}
})

it("encodes endpoint-local declarations without adding runtime identity", () => {
	const input = {
		id: "provider.openai",
		version: 1,
		kind: "provider",
		projections: [],
		endpoints: [{ id: "responses", parameters: [], streaming: true, capabilities: [] }],
	} as const
	const decoded = Capability.decode(input)
	assert.equal(decoded._tag, "Success")
	if (Result.isSuccess(decoded)) {
		assert.deepEqual(Schema.encodeSync(Capability.SchemaDefinition)(decoded.success), input)
		assert.notEqual(decoded.success.projections, input.projections)
		assert.notEqual(decoded.success.endpoints, input.endpoints)
		assert.notEqual(decoded.success.endpoints?.[0]?.parameters, input.endpoints[0].parameters)
		assert.notEqual(
			decoded.success.endpoints?.[0]?.capabilities,
			input.endpoints[0].capabilities,
		)
	}
})
