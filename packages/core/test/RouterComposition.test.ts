import assert from "node:assert/strict"
import { it } from "vitest"
import { Effect, Layer, Result } from "effect"
import * as Capability from "@better-router/core/Capability"
import * as Plugin from "@better-router/core/Plugin"
import * as ProviderContract from "@better-router/core/ProviderContract"
import * as Router from "@better-router/core/Router"

const capability = Capability.make({
	id: "composition.fixture",
	version: 1,
	kind: "provider",
	projections: ["generation"],
} as const)

const plugin = Plugin.make({
	id: "composition.fixture",
	capabilities: [capability] as const,
	config: {},
})

it("performs static preflight without evaluating Layers or init callbacks", () => {
	const unavailable = Plugin.make({
		id: "composition.unavailable",
		capabilities: [] as const,
		config: {},
		layer: Layer.effectDiscard(Effect.fail("the Layer must not be built during preflight")),
		init: () => Effect.fail("the init callback must not run during preflight"),
	})

	const result = Router.make({ plugins: [unavailable] as const })

	assert.equal(Result.isSuccess(result), true)
})

it("builds an immutable declaration snapshot and rejects duplicate identifiers", () => {
	const result = Router.make({ plugins: [plugin] as const })

	assert.equal(Result.isSuccess(result), true)
	if (Result.isSuccess(result)) {
		assert.deepEqual(
			result.success.registry.plugins.map(({ id }) => id),
			["composition.fixture"],
		)
		assert.deepEqual(
			result.success.registry.capabilities.map(({ id }) => id),
			["generation", "composition.fixture"],
		)
	}

	const duplicatePlugin = Router.make({ plugins: [plugin, plugin] as const })
	assert.equal(Result.isFailure(duplicatePlugin), true)
	if (Result.isFailure(duplicatePlugin)) {
		assert.equal(duplicatePlugin.failure._tag, "RouterDuplicateId")
		assert.equal(duplicatePlugin.failure.kind, "plugin")
	}

	const duplicateCapability = Router.make({
		plugins: [
			plugin,
			Plugin.make({
				id: "composition.other",
				capabilities: [capability] as const,
				config: {},
			}),
		] as const,
	})
	assert.equal(Result.isFailure(duplicateCapability), true)
	if (Result.isFailure(duplicateCapability)) {
		assert.equal(duplicateCapability.failure._tag, "RouterDuplicateId")
		assert.equal(duplicateCapability.failure.kind, "capability")
	}

	const firstProvider = ProviderContract.make({
		id: "composition.provider",
		endpoints: [{ id: "generation", parameters: [], streaming: true }],
	})
	const secondProvider = ProviderContract.make({
		id: "composition.provider",
		endpoints: [{ id: "generation", parameters: [], streaming: true }],
	})
	const duplicateProvider = Router.make({
		plugins: [
			Plugin.make({
				id: "composition.provider.first",
				capabilities: [] as const,
				config: { providers: [firstProvider] as const },
			}),
			Plugin.make({
				id: "composition.provider.second",
				capabilities: [] as const,
				config: { providers: [secondProvider] as const },
			}),
		] as const,
	})
	assert.equal(Result.isFailure(duplicateProvider), true)
	if (Result.isFailure(duplicateProvider)) {
		assert.equal(duplicateProvider.failure._tag, "RouterDuplicateId")
		assert.equal(duplicateProvider.failure.kind, "provider")
	}
})

it("turns malformed plugin declarations into typed setup failures", () => {
	const malformed = Router.make({ plugins: [null as never] as const })

	assert.equal(Result.isFailure(malformed), true)
	if (Result.isFailure(malformed)) {
		assert.equal(malformed.failure._tag, "RouterInvalidPlugin")
		assert.equal(malformed.failure.id, "unknown")
	}

	const malformedConfig = Router.make({
		plugins: [
			{
				id: "malformed-config",
				capabilities: [],
				config: { deployments: "expected an array" },
			} as never,
		] as const,
	})

	assert.equal(Result.isFailure(malformedConfig), true)
	if (Result.isFailure(malformedConfig)) {
		assert.equal(malformedConfig.failure._tag, "RouterInvalidPlugin")
		assert.match(malformedConfig.failure.message, /deployments/)
		assert.equal(
			malformedConfig.failure.issues?.some(
				(issue) => issue.path.join(".") === "config.deployments",
			),
			true,
		)
	}

	const malformedProvider = Router.make({
		plugins: [
			Plugin.make({
				id: "malformed-provider",
				capabilities: [] as const,
				config: {
					providers: [
						{
							id: "malformed-provider-contract",
							endpoints: [{ id: "generation", parameters: [1], streaming: true }],
						} as never,
					] as const,
				},
			}),
		] as const,
	})

	assert.equal(Result.isFailure(malformedProvider), true)
	if (Result.isFailure(malformedProvider)) {
		assert.equal(malformedProvider.failure._tag, "RouterInvalidPlugin")
		assert.equal(
			malformedProvider.failure.issues?.some(
				(issue) => issue.path.join(".") === "config.providers.0.endpoints.0.parameters.0",
			),
			true,
		)
	}
})
