import { Context, Effect, Layer } from "effect"
import { describe, expect, it } from "tstyche"
import * as Capability from "@better-router/core/Capability"
import * as Plugin from "@better-router/core/Plugin"

class RuntimeDependency extends Context.Service<RuntimeDependency, { readonly name: string }>()(
	"BetterRouterPluginTypeDependency",
) {}

const capability = Capability.make({
	id: "typed.plugin.capability",
	version: 1,
	kind: "provider",
	projections: ["generation"],
} as const)

const plugin = Plugin.make({
	id: "typed-plugin",
	capabilities: [capability] as const,
	config: {
		modelRoutes: [
			{
				model: "public-model",
				deployments: ["primary"],
			},
		] as const,
	},
	layer: Layer.succeed(RuntimeDependency, { name: "fixture" }),
	init: () => Effect.succeed({ initialized: true } as const),
})

describe("object plugin declarations", () => {
	it("preserves literal static identity and separates runtime callbacks", () => {
		expect<typeof plugin.id>().type.toBe<"typed-plugin">()
		expect<typeof plugin.capabilities>().type.toBe<readonly [typeof capability]>()
		expect<typeof plugin.config.modelRoutes>().type.toBe<
			readonly [
				{ readonly model: "public-model"; readonly deployments: readonly ["primary"] },
			]
		>()
		expect<typeof plugin.layer>().type.toBe<Layer.Layer<RuntimeDependency, never, never>>()
		expect<Effect.Success<ReturnType<typeof plugin.init>>>().type.toBe<{
			readonly initialized: true
		}>()
	})

	it("does not expose mutable or legacy state declarations", () => {
		type Equal<Left, Right> =
			(<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right
				? 1
				: 2
				? true
				: false
		type WritableKeys<Value> = {
			[Key in keyof Value]-?: Equal<
				Pick<Value, Key>,
				{ -readonly [Property in Key]: Value[Property] }
			> extends true
				? Key
				: never
		}[keyof Value]

		expect<WritableKeys<typeof plugin>>().type.toBe<never>()
		expect<WritableKeys<typeof plugin.config>>().type.toBe<never>()
		expect<WritableKeys<(typeof plugin.config.modelRoutes)[number]>>().type.toBe<never>()
		expect(plugin.config.modelRoutes).type.not.toBeAssignableTo<
			Array<{ model: string; deployments: string[] }>
		>()
		expect<typeof plugin>().type.not.toHaveProperty("state")
		expect<typeof plugin>().type.not.toHaveProperty("contributions")
	})

	it("requires explicit static config and capability declarations", () => {
		expect<{
			readonly id: "missing-config"
			readonly capabilities: readonly []
		}>().type.not.toBeAssignableTo<Plugin.AnyPlugin>()
		expect<{
			readonly id: "missing-capabilities"
			readonly config: {}
		}>().type.not.toBeAssignableTo<Plugin.AnyPlugin>()
	})

	it("requires the external dependency through init when it is used", () => {
		const dependent = Plugin.make({
			id: "dependent-plugin",
			capabilities: [] as const,
			config: {},
			init: () =>
				Effect.gen(function* () {
					const dependency = yield* RuntimeDependency
					return dependency.name
				}),
		})

		expect<Effect.Services<ReturnType<typeof dependent.init>>>().type.toBe<RuntimeDependency>()
	})
})
