import assert from "node:assert/strict"
import { it } from "vitest"
import { HashMap, Result } from "effect"
import * as Registry from "@better-router/core/Registry"
import { plugin } from "@better-router/plugin-anthropic-messages"
import * as Provider from "@better-router/provider-anthropic"

it("declares Messages ingress and credential references without secrets", () => {
	const value = plugin({
		deployments: [
			{
				id: "anthropic-primary",
				provider: "anthropic",
				model: "claude-3-7-sonnet",
				protocol: "messages",
				credentialRef: "secret.anthropic",
				defaultMaxTokens: 2_048,
				version: "2023-06-01",
				pricing: { inputPerToken: 0.000003, outputPerToken: 0.000015, currency: "USD" },
				limits: { maxConcurrent: 3, maxTokens: 2_048 },
			},
		],
	})
	assert.equal(value.config?.http?.[0]?.id, "anthropic-messages")
	assert.equal(value.config?.deployments?.[0]?.credentialRef, "secret.anthropic")
	assert.equal(value.config?.deployments?.[0]?.defaultMaxTokens, 2_048)
	assert.equal(value.config?.deployments?.[0]?.version, "2023-06-01")
	assert.deepEqual(value.config?.deployments?.[0]?.pricing, {
		inputPerToken: 0.000003,
		outputPerToken: 0.000015,
		currency: "USD",
	})
	assert.deepEqual(value.config?.deployments?.[0]?.limits, {
		maxConcurrent: 3,
		maxTokens: 2_048,
	})
	assert.equal(value.config?.providers?.[0], Provider.Deployment.contract)
	assert.equal(Object.prototype.hasOwnProperty.call(value, "state"), false)
	assert.equal(Object.prototype.hasOwnProperty.call(value.config, "layers"), false)
})

it("composes immutable Messages declarations into a registry", () => {
	const value = plugin({
		deployments: [
			{
				id: "anthropic-primary",
				provider: "anthropic",
				model: "claude-3-7-sonnet",
				protocol: "messages",
				credentialRef: "secret.anthropic",
			},
		],
		modelRoutes: [{ model: "public", deployments: ["anthropic-primary"] }],
	})
	const result = Registry.fromPlugins([value])
	assert.equal(Result.isSuccess(result), true)
	if (Result.isFailure(result)) return
	assert.equal(result.success.providerContracts[0]?.id, Provider.Deployment.contract.id)
	assert.equal(HashMap.has(result.success.deploymentIndex, "anthropic-primary"), true)
	assert.equal(HashMap.has(result.success.modelRouteIndex, "public"), true)
})
