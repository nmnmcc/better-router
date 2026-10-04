import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Context, Effect, Layer, Result, Stream } from "effect"
import * as Capability from "@better-router/core/Capability"
import * as Generation from "@better-router/core/Generation"
import * as Plugin from "@better-router/core/Plugin"
import * as Registry from "@better-router/core/Registry"
import * as Route from "@better-router/core/Route"
import * as Router from "@better-router/core/Router"

class ProviderFixture extends Context.Service<ProviderFixture, { readonly id: string }>()(
	"BetterRouterPluginProviderFixture",
) {}

const providerCapability = Capability.make({
	id: "test.provider",
	version: 1,
	kind: "provider",
	projections: ["generation"],
} as const)

const routePlugin = Route.plugin({
	chat: (_request: Route.Request<"chat">) =>
		Effect.gen(function* () {
			const provider = yield* ProviderFixture
			return yield* Generation.Process.make(
				Stream.succeed({
					type: "response.completed" as const,
					sequence_number: 0,
					response: { id: provider.id, status: "completed" } as never,
				}),
			)
		}),
})

const providerPlugin = Plugin.make({
	id: "test-provider",
	capabilities: [providerCapability] as const,
	state: {
		providers: [Layer.succeed(ProviderFixture, { id: "plugin-provider" })] as const,
	},
})

it.effect("assembles route and provider state from object plugins", () =>
	Effect.gen(function* () {
		const router = yield* Router.make({
			plugins: [routePlugin, providerPlugin] as const,
		})
		const process = yield* router.generate({ model: "chat", input: [] })
		const response = yield* process.response
		assert.equal(response.id, "plugin-provider")
		assert.deepEqual(
			router.registry.capabilities.map((capability) => capability.id),
			["generation", "routing.models", "test.provider"],
		)
	}),
)

it("rejects duplicate plugin and capability identifiers before acquisition", () => {
	const first = Plugin.make({
		id: "duplicate",
		capabilities: [
			Capability.make({
				id: "duplicate.capability",
				version: 1,
				kind: "routing",
			}),
		] as const,
	})
	const duplicatePlugin = Registry.fromPlugins([first, first])
	assert.equal(duplicatePlugin._tag, "Failure")

	const second = Plugin.make({
		id: "different",
		capabilities: [
			Capability.make({
				id: "duplicate.capability",
				version: 1,
				kind: "routing",
			}),
		] as const,
	})
	const duplicateCapability = Registry.fromPlugins([first, second])
	assert.equal(duplicateCapability._tag, "Failure")
	if (Result.isFailure(duplicateCapability))
		assert.equal(duplicateCapability.failure._tag, "RouterDuplicateId")

	const invalid = Plugin.make({ id: "" })
	const invalidPlugin = Registry.fromPlugins([invalid])
	assert.equal(invalidPlugin._tag, "Failure")
	if (Result.isFailure(invalidPlugin))
		assert.equal(invalidPlugin.failure._tag, "RouterInvalidPlugin")
})
