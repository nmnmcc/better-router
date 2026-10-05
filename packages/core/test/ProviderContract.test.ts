import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Result, Schema, SchemaIssue } from "effect"
import * as Deployment from "@better-router/core/Deployment"
import * as ProviderContract from "@better-router/core/ProviderContract"

const responses = ProviderContract.make({
	id: "openai",
	protocols: ["responses"],
	endpoints: [
		{
			id: "responses",
			parameters: ["tools", "temperature"],
			streaming: true,
		},
	],
})

it("accepts a deployment supported by the provider endpoint matrix", () => {
	const deployment = Deployment.make({
		id: "openai-primary",
		provider: "openai",
		model: "gpt-5-mini",
		protocol: "responses",
	})

	assert.equal(ProviderContract.supports(responses, deployment), true)
	assert.equal(ProviderContract.validateDeployment(responses, deployment)._tag, "Success")
})

it("rejects an unsupported deployment before acquiring provider resources", () => {
	const deployment = Deployment.make({
		id: "openai-chat",
		provider: "openai",
		model: "gpt-4",
		protocol: "chat-completions",
	})
	const result = ProviderContract.validateDeployment(responses, deployment)

	assert.equal(result._tag, "Failure")
	if (Result.isFailure(result)) {
		assert.equal(result.failure._tag, "ProviderContractError")
		assert.equal(result.failure.deployment, "openai-chat")
		assert.equal(result.failure.protocol, "chat-completions")
	}
})

it("clones endpoint arrays at the declaration boundary", () => {
	const parameters = ["tools"] as const
	const contract = ProviderContract.make({
		id: "openai",
		endpoints: [{ id: "responses", parameters, streaming: true }],
	})

	assert.notEqual(contract.endpoints, undefined)
	assert.notEqual(contract.endpoints[0]?.parameters, parameters)
	assert.deepEqual(contract.endpoints[0]?.parameters, ["tools"])
})

it("narrows provider capabilities to endpoint-local declarations", () => {
	const contract = ProviderContract.make({
		id: "scoped-provider",
		protocols: ["responses", "chat-completions"],
		capabilities: [{ id: "tools", version: 1 }],
		endpoints: [
			{
				id: "responses",
				parameters: ["input"],
				streaming: true,
				capabilities: ["tools"],
			},
			{
				id: "chat-completions",
				parameters: ["input"],
				streaming: true,
				capabilities: [],
			},
		],
	})
	const responses = Deployment.make({
		id: "responses-deployment",
		provider: contract.id,
		model: "responses-model",
		protocol: "responses",
		capabilities: ["tools"],
	})
	const chat = Deployment.make({
		id: "chat-deployment",
		provider: contract.id,
		model: "chat-model",
		protocol: "chat-completions",
		capabilities: ["tools"],
	})

	assert.deepEqual(ProviderContract.capabilitiesForDeployment(contract, responses), ["tools"])
	assert.deepEqual(ProviderContract.capabilitiesForDeployment(contract, chat), [])
	assert.equal(ProviderContract.supports(contract, responses), true)
	assert.equal(ProviderContract.supports(contract, chat), false)
})

it("does not inherit global capabilities when an endpoint declares an explicit empty set", () => {
	const contract = ProviderContract.make({
		id: "explicit-empty-provider",
		protocols: ["responses"],
		capabilities: [{ id: "global-capability", version: 1 }],
		endpoints: [
			{
				id: "responses",
				parameters: ["input"],
				streaming: true,
				capabilities: [],
			},
		],
	})
	const deployment = Deployment.make({
		id: "deployment",
		provider: contract.id,
		model: "model",
		protocol: "responses",
		capabilities: ["global-capability"],
	})

	assert.deepEqual(ProviderContract.capabilitiesForDeployment(contract, deployment), [])
	const result = ProviderContract.validateDeployment(contract, deployment)
	assert.ok(Result.isFailure(result))
	if (Result.isFailure(result)) {
		assert.equal(result.failure._tag, "ProviderContractError")
		assert.equal(result.failure.provider, contract.id)
		assert.equal(result.failure.deployment, deployment.id)
	}
})

it("decodes and encodes provider endpoint declarations without changing input", () => {
	const descriptor = {
		id: "schema-provider",
		protocols: ["responses"],
		capabilities: [{ id: "generation", version: 1 }],
		endpoints: [
			{
				id: "responses",
				parameters: ["input", "temperature"],
				streaming: true,
				capabilities: ["generation"],
			},
		],
	} as const
	const before = JSON.stringify(descriptor)
	const decoded = ProviderContract.decode(descriptor)
	assert.ok(Result.isSuccess(decoded))
	if (Result.isSuccess(decoded)) {
		const encoded = Schema.encodeUnknownResult(ProviderContract.ProviderContractSchema)(
			decoded.success,
		)
		assert.ok(Result.isSuccess(encoded))
		if (Result.isSuccess(encoded)) {
			assert.deepEqual(encoded.success, descriptor)
			assert.deepEqual(ProviderContract.decode(encoded.success), decoded)
		}
	}
	assert.equal(JSON.stringify(descriptor), before)
})

const malformedDescriptors = [
	{ name: "null provider", value: null, path: [] },
	{ name: "empty endpoint matrix", value: { ...responses, endpoints: [] }, path: ["endpoints"] },
	{
		name: "invalid endpoint streaming flag",
		value: {
			...responses,
			endpoints: [{ id: "responses", parameters: ["input"], streaming: "true" }],
		},
		path: ["endpoints", 0, "streaming"],
	},
	{
		name: "invalid endpoint parameter",
		value: {
			...responses,
			endpoints: [{ id: "responses", parameters: ["input", null], streaming: true }],
		},
		path: ["endpoints", 0, "parameters", 1],
	},
	{
		name: "invalid endpoint capability",
		value: {
			...responses,
			endpoints: [{ id: "responses", parameters: [], streaming: true, capabilities: [1] }],
		},
		path: ["endpoints", 0, "capabilities", 0],
	},
	{
		name: "invalid capability version",
		value: { ...responses, capabilities: [{ id: "generation", version: 0 }] },
		path: ["capabilities", 0, "version"],
	},
	{
		name: "invalid runtime factory",
		value: { ...responses, runtime: {} },
		path: ["runtime"],
	},
] as const

malformedDescriptors.forEach(({ name, value, path }) =>
	it(`keeps nested Schema issue paths for ${name}`, () => {
		const decoded = ProviderContract.decode(value)
		assert.ok(Result.isFailure(decoded))
		if (Result.isFailure(decoded)) {
			const paths = SchemaIssue.makeFormatterStandardSchemaV1()(
				decoded.failure.issue,
			).issues.map((issue) => issue.path)
			assert.ok(
				paths.some(
					(candidate) =>
						(candidate ?? []).length === path.length &&
						(candidate ?? []).every((segment, index) => segment === path[index]),
				),
			)
		}
	}),
)
