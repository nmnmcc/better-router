import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Result, Schema, SchemaIssue } from "effect"
import * as Deployment from "@better-router/core/Deployment"

const config = {
	id: "openai-primary",
	provider: "openai",
	model: "gpt-5-mini",
	protocol: "responses",
	credentialRef: "secret/openai",
	baseUrl: "https://api.openai.com",
	weight: 2,
	pricing: { inputPerToken: 0.001, outputPerToken: 0.002, currency: "USD" },
	limits: { maxConcurrent: 4, rpm: 60, tpm: 10_000, maxInputTokens: 8_000 },
	tags: ["production", "primary"],
	endpoint: "responses",
	parameters: ["temperature", "tools"],
	streaming: true,
	capabilities: ["provider.openai", "generation.responses"],
} as const

const routingMetadata = {
	id: config.id,
	provider: config.provider,
	model: config.model,
	protocol: config.protocol,
	weight: config.weight,
	pricing: config.pricing,
	limits: config.limits,
	tags: config.tags,
	endpoint: config.endpoint,
	parameters: config.parameters,
	streaming: config.streaming,
	capabilities: config.capabilities,
} as const

const issuePaths = (error: Schema.SchemaError) =>
	SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => issue.path)

it("decodes and encodes the complete static deployment configuration", () => {
	const before = JSON.stringify(config)
	const decoded = Deployment.decodeConfig(config)

	assert.ok(Result.isSuccess(decoded))
	assert.deepEqual(decoded.success, config)
	const encoded = Schema.encodeUnknownResult(Deployment.DeploymentConfigSchema)(decoded.success)

	assert.ok(Result.isSuccess(encoded))
	assert.deepEqual(encoded.success, config)
	assert.deepEqual(Deployment.decodeConfig(encoded.success), decoded)
	assert.equal(JSON.stringify(config), before)
})

it("decodes and encodes the redacted routing metadata", () => {
	const before = JSON.stringify(config)
	const decoded = Deployment.decodeRef(config)

	assert.ok(Result.isSuccess(decoded))
	assert.deepEqual(decoded.success, routingMetadata)
	assert.equal("credentialRef" in decoded.success, false)
	assert.equal("baseUrl" in decoded.success, false)
	const encoded = Schema.encodeUnknownResult(Deployment.DeploymentRefSchema)(decoded.success)

	assert.ok(Result.isSuccess(encoded))
	assert.deepEqual(encoded.success, routingMetadata)
	assert.deepEqual(Deployment.decodeRef(encoded.success), decoded)
	assert.equal(JSON.stringify(config), before)
})

it("makes a deployment without retaining caller-owned arrays or nested metadata", () => {
	const before = JSON.stringify(config)
	const deployment = Deployment.make(config)

	assert.deepEqual(deployment, config)
	assert.notEqual(deployment, config)
	assert.notEqual(deployment.pricing, config.pricing)
	assert.notEqual(deployment.limits, config.limits)
	assert.notEqual(deployment.tags, config.tags)
	assert.notEqual(deployment.parameters, config.parameters)
	assert.notEqual(deployment.capabilities, config.capabilities)
	assert.equal(JSON.stringify(config), before)
})

it("projects all routing metadata while redacting credentials and base URLs", () => {
	const deployment = Deployment.make(config)
	const before = JSON.stringify(deployment)
	const projected = Deployment.ref(deployment)

	assert.deepEqual(projected, routingMetadata)
	assert.equal("credentialRef" in projected, false)
	assert.equal("baseUrl" in projected, false)
	assert.notEqual(projected, deployment)
	assert.notEqual(projected.pricing, deployment.pricing)
	assert.notEqual(projected.limits, deployment.limits)
	assert.notEqual(projected.tags, deployment.tags)
	assert.notEqual(projected.parameters, deployment.parameters)
	assert.notEqual(projected.capabilities, deployment.capabilities)
	assert.equal(JSON.stringify(deployment), before)
})

it("keeps optional routing metadata absent on minimal declarations", () => {
	const minimal = {
		id: "primary",
		provider: "openai",
		model: "gpt-5-mini",
		protocol: "responses",
	} as const

	assert.deepEqual(Deployment.make(minimal), minimal)
	assert.deepEqual(Deployment.ref(minimal), minimal)
	assert.deepEqual(Deployment.decodeConfig(minimal), Result.succeed(minimal))
	assert.deepEqual(Deployment.decodeRef(minimal), Result.succeed(minimal))
})

const malformedMetadata = [
	{
		name: "negative request limits",
		value: { ...config, limits: { rpm: -1 } },
		path: ["limits", "rpm"],
	},
	{
		name: "fractional token limits",
		value: { ...config, limits: { tpm: 1.5 } },
		path: ["limits", "tpm"],
	},
	{
		name: "negative input pricing",
		value: { ...config, pricing: { inputPerToken: -0.001 } },
		path: ["pricing", "inputPerToken"],
	},
	{
		name: "empty pricing currency",
		value: { ...config, pricing: { currency: "" } },
		path: ["pricing", "currency"],
	},
	{
		name: "empty supported parameter",
		value: { ...config, parameters: ["temperature", ""] },
		path: ["parameters", 1],
	},
	{
		name: "non-string supported parameter",
		value: { ...config, parameters: [42] },
		path: ["parameters", 0],
	},
	{
		name: "empty required capability",
		value: { ...config, capabilities: [""] },
		path: ["capabilities", 0],
	},
	{
		name: "non-string tag",
		value: { ...config, tags: ["production", 42] },
		path: ["tags", 1],
	},
	{
		name: "non-boolean streaming demand",
		value: { ...config, streaming: "true" },
		path: ["streaming"],
	},
] as const

const boundaries = [
	{ name: "configuration", decode: Deployment.decodeConfig },
	{ name: "routing ref", decode: Deployment.decodeRef },
] as const

malformedMetadata.forEach(({ name, value, path }) =>
	boundaries.forEach(({ name: boundary, decode }) =>
		it(`keeps the ${boundary} Schema issue path for ${name}`, () => {
			const before = JSON.stringify(value)
			const decoded = decode(value)

			assert.ok(Result.isFailure(decoded))
			assert.ok(Schema.isSchemaError(decoded.failure))
			assert.deepEqual(issuePaths(decoded.failure), [path])
			assert.equal(JSON.stringify(value), before)
		}),
	),
)
