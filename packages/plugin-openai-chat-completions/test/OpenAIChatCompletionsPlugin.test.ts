import assert from "node:assert/strict"
import { it } from "vitest"
import { HashMap, Result } from "effect"
import * as Registry from "@better-router/core/Registry"
import { plugin } from "@better-router/plugin-openai-chat-completions"
import * as Provider from "@better-router/provider-openai"

it("declares Chat Completions ingress and deployment contract independently", () => {
	const value = plugin({
		deployments: [
			{
				id: "openai-chat-primary",
				provider: "openai",
				model: "gpt-4.1-mini",
				protocol: "chat-completions",
				credentialRef: "secret.openai",
				pricing: { inputPerToken: 0.000001, outputPerToken: 0.000002 },
				limits: { maxConcurrent: 8 },
			},
		],
	})
	assert.equal(value.config?.http?.[0]?.id, "openai-chat-completions")
	assert.equal(value.config?.deployments?.[0]?.protocol, "chat-completions")
	assert.deepEqual(value.config?.deployments?.[0]?.pricing, {
		inputPerToken: 0.000001,
		outputPerToken: 0.000002,
	})
	assert.deepEqual(value.config?.deployments?.[0]?.limits, { maxConcurrent: 8 })
	assert.equal(value.config?.providers?.[0], Provider.Deployment.contract)
	assert.equal(Object.prototype.hasOwnProperty.call(value, "state"), false)
	assert.equal(Object.prototype.hasOwnProperty.call(value.config, "layers"), false)
})

it("composes immutable Chat Completions declarations into a registry", () => {
	const value = plugin({
		deployments: [
			{
				id: "chat-primary",
				provider: "openai",
				model: "gpt-4.1-mini",
				protocol: "chat-completions",
				credentialRef: "secret.openai",
			},
		],
		modelRoutes: [{ model: "public", deployments: ["chat-primary"] }],
	})
	const result = Registry.fromPlugins([value])
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	assert.equal(result.success.providerContracts[0]?.id, Provider.Deployment.contract.id)
	assert.equal(HashMap.has(result.success.deploymentIndex, "chat-primary"), true)
	assert.equal(HashMap.has(result.success.modelRouteIndex, "public"), true)
})
