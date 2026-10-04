import assert from "node:assert/strict"
import { it } from "vitest"
import { plugin } from "@better-router/plugin-openai-responses"
import { plugin as chatPlugin } from "@better-router/plugin-openai-chat-completions"
import * as Registry from "@better-router/core/Registry"
import { HashMap, Result } from "effect"
import * as Provider from "@better-router/provider-openai"

it("separates static Responses deployments from HTTP declarations", () => {
	const value = plugin({
		deployments: [
			{
				id: "openai-responses-primary",
				provider: "openai",
				model: "gpt-4.1",
				protocol: "responses",
				credentialRef: "secret.openai",
				pricing: { inputPerToken: 0.000001, outputPerToken: 0.000002, currency: "USD" },
				limits: { maxConcurrent: 4, rpm: 60, tpm: 10_000, maxTokens: 4_096 },
				tags: ["primary", "openai"],
			},
		],
		routes: [
			{
				model: "public",
				deployments: ["openai-responses-primary"],
			},
		],
	})
	assert.equal(value.config?.http?.[0]?.id, "openai-responses")
	assert.equal(value.config?.deployments?.[0]?.credentialRef, "secret.openai")
	assert.deepEqual(value.config?.deployments?.[0]?.pricing, {
		inputPerToken: 0.000001,
		outputPerToken: 0.000002,
		currency: "USD",
	})
	assert.deepEqual(value.config?.deployments?.[0]?.limits, {
		maxConcurrent: 4,
		rpm: 60,
		tpm: 10_000,
		maxTokens: 4_096,
	})
	assert.deepEqual(value.config?.deployments?.[0]?.tags, ["primary", "openai"])
	assert.equal(value.config?.routes?.[0]?.model, "public")
	assert.equal(value.config?.providers?.[0], Provider.Deployment.contract)
	assert.equal(Object.prototype.hasOwnProperty.call(value, "state"), false)
	assert.equal(Object.prototype.hasOwnProperty.call(value.config, "layers"), false)
})

it("declares the shared OpenAI contract even without deployments", () => {
	const value = plugin()
	assert.equal(value.config.providers[0], Provider.Deployment.contract)
	assert.deepEqual(value.config.deployments, [])
})

it("composes its immutable declarations into a registry", () => {
	const value = plugin({
		deployments: [
			{
				id: "responses-primary",
				provider: "openai",
				model: "gpt-4.1",
				protocol: "responses",
				credentialRef: "secret.openai",
			},
		],
		routes: [{ model: "public", deployments: ["responses-primary"] }],
	})
	const result = Registry.fromPlugins([value])
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	assert.equal(result.success.providerContracts[0]?.id, Provider.Deployment.contract.id)
	assert.equal(HashMap.has(result.success.deploymentIndex, "responses-primary"), true)
	assert.equal(HashMap.has(result.success.routeIndex, "public"), true)
})

it("shares one provider contract across Responses and Chat Completions", () => {
	const responses = plugin({
		deployments: [
			{
				id: "responses-primary",
				provider: "openai",
				model: "gpt-4.1",
				protocol: "responses",
				credentialRef: "secret.openai",
			},
		],
		routes: [{ model: "responses", deployments: ["responses-primary"] }],
	})
	const chat = chatPlugin({
		deployments: [
			{
				id: "chat-primary",
				provider: "openai",
				model: "gpt-4.1-mini",
				protocol: "chat-completions",
				credentialRef: "secret.openai",
			},
		],
		routes: [{ model: "chat", deployments: ["chat-primary"] }],
	})
	assert.equal(responses.config.providers[0], chat.config.providers[0])
	const result = Registry.fromPlugins([responses, chat])
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	assert.equal(result.success.providerContracts.length, 1)
	assert.equal(result.success.http.length, 2)
	assert.equal(result.success.deployments.length, 2)
	assert.deepEqual(
		result.success.routes.map((route) => route.model),
		["responses", "chat"],
	)
})

it("preserves caller input when forwarding full static deployments and fallback aliases", () => {
	const options = {
		deployments: [
			{
				id: "responses-primary",
				provider: "openai",
				model: "gpt-4.1",
				protocol: "responses",
				credentialRef: "primary-key",
				baseUrl: "https://primary.example/v1/responses",
				weight: 2,
				pricing: { inputPerToken: 0.000001, outputPerToken: 0.000002 },
				limits: { maxConcurrent: 4, rpm: 60 },
				tags: ["primary"],
			},
			{
				id: "responses-fallback",
				provider: "openai",
				model: "gpt-4.1-mini",
				protocol: "responses",
				credentialRef: "fallback-key",
			},
		],
		routes: [
			{
				model: "public",
				deployments: ["responses-primary"],
				fallback: ["responses-fallback"],
			},
		],
	} as const
	const before = JSON.stringify(options)
	const value = plugin(options)
	assert.deepEqual(value.config.deployments, options.deployments)
	assert.deepEqual(value.config.routes, options.routes)
	assert.equal(JSON.stringify(options), before)
})
