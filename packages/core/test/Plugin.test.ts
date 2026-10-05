import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Context, Effect, Layer, Result, Schema } from "effect"
import * as Capability from "@better-router/core/Capability"
import * as Deployment from "@better-router/core/Deployment"
import * as Plugin from "@better-router/core/Plugin"
import type { Handler } from "@better-router/core/PluginContributions"
import * as ProviderContract from "@better-router/core/ProviderContract"
import type { RoutingContext } from "@better-router/core/Routing"

class PluginService extends Context.Service<PluginService, { readonly value: string }>()(
	"BetterRouterPluginStaticFixture",
) {}

const providerCapability = Capability.make({
	id: "fixture.provider",
	version: 1,
	kind: "provider",
	projections: ["generation"],
})

const provider = ProviderContract.make({
	id: "fixture-provider",
	endpoints: [{ id: "generation", parameters: ["input"], streaming: true }],
	capabilities: [providerCapability],
})

const deployment = Deployment.make({
	id: "primary",
	provider: provider.id,
	model: "private-model",
	protocol: "responses",
	credentialRef: "secrets/primary",
})

it("keeps static config separate from runtime acquisition in an object plugin", () => {
	const layer = Layer.succeed(PluginService, { value: "provided" })
	const init = (_context: Plugin.PluginInitContext) =>
		Effect.die("Static plugin validation must never execute init")
	const definition = {
		id: "fixture",
		capabilities: [providerCapability],
		config: { providers: [provider], deployments: [deployment] },
		layer,
		init,
	} as const
	const plugin = Plugin.make(definition)
	const validated = Plugin.validate(plugin)

	assert.equal(plugin, definition)
	assert.equal(plugin.layer, layer)
	assert.equal(plugin.init, init)
	assert.ok(Result.isSuccess(validated))
	if (Result.isSuccess(validated)) assert.equal(validated.success, plugin)
	assert.deepEqual(plugin.config.providers, [provider])
	assert.deepEqual(plugin.config.deployments, [deployment])
	assert.equal("state" in plugin, false)
})

it("normalizes omitted declarations into empty immutable collections", () => {
	const plugin = Plugin.make({ id: "empty", capabilities: [], config: {} })
	const contributions = Plugin.contributionsOf(plugin)

	assert.deepEqual(contributions, {
		providers: [],
		deployments: [],
		modelRoutes: [],
		policies: [],
		pipelines: [],
		projections: [],
		middleware: [],
		hooks: [],
		http: [],
		persistence: [],
	})
	assert.deepEqual(plugin.config, {})
})

it("copies declaration collections without acquiring resources or changing input", () => {
	const pipeline = {
		id: "pipeline",
		run: (context: RoutingContext) => Effect.succeed(context),
	}
	const route = { model: "chat", deployments: [deployment.id] } as const
	const http = {
		id: "echo",
		method: "POST",
		path: "/echo",
		input: Schema.String,
		output: Schema.String,
		handler: (value: unknown) => Effect.succeed(value),
	} as const
	const config = {
		providers: [provider],
		deployments: [deployment],
		modelRoutes: [route],
		policies: [{ id: "simple", strategy: "simple" }],
		pipelines: [pipeline],
		projections: [{ id: "responses", protocol: "responses", capability: "generation" }],
		middleware: [{ id: "identity", wrap: <R>(next: Handler<R>) => next }],
		hooks: [{ id: "hook", beforeRequest: () => Effect.void }],
		http: [http],
		persistence: [
			{
				namespace: "fixture",
				schema: Schema.String,
				migrations: [{ id: 1, name: "initial", run: Effect.void }],
			},
		],
	} as const
	const contributions = Plugin.contributionsOf(
		Plugin.make({ id: "fixture", capabilities: [], config }),
	)

	assert.notEqual(contributions.providers, config.providers)
	assert.notEqual(contributions.deployments, config.deployments)
	assert.notEqual(contributions.modelRoutes, config.modelRoutes)
	assert.notEqual(contributions.policies, config.policies)
	assert.notEqual(contributions.pipelines, config.pipelines)
	assert.notEqual(contributions.projections, config.projections)
	assert.notEqual(contributions.middleware, config.middleware)
	assert.notEqual(contributions.hooks, config.hooks)
	assert.notEqual(contributions.http, config.http)
	assert.notEqual(contributions.persistence, config.persistence)
	assert.deepEqual(contributions.providers[0], provider)
	assert.notEqual(contributions.providers[0], config.providers?.[0])
	assert.notEqual(contributions.providers[0]?.endpoints, config.providers?.[0]?.endpoints)
	assert.notEqual(contributions.providers[0]?.capabilities, config.providers?.[0]?.capabilities)
	assert.notEqual(
		contributions.providers[0]?.capabilities?.[0],
		config.providers?.[0]?.capabilities?.[0],
	)
	assert.notEqual(
		contributions.providers[0]?.endpoints[0]?.parameters,
		config.providers?.[0]?.endpoints[0]?.parameters,
	)
	assert.notEqual(contributions.deployments[0], config.deployments?.[0])
	assert.notEqual(contributions.modelRoutes[0], config.modelRoutes?.[0])
	assert.notEqual(contributions.policies[0], config.policies?.[0])
	assert.notEqual(contributions.pipelines[0], config.pipelines?.[0])
	assert.notEqual(contributions.projections[0], config.projections?.[0])
	assert.notEqual(contributions.middleware[0], config.middleware?.[0])
	assert.notEqual(contributions.hooks[0], config.hooks?.[0])
	assert.notEqual(contributions.http[0], config.http?.[0])
	assert.notEqual(contributions.persistence[0], config.persistence?.[0])
	assert.notEqual(contributions.persistence[0]?.migrations, config.persistence[0]?.migrations)
	assert.notEqual(
		contributions.persistence[0]?.migrations?.[0],
		config.persistence[0]?.migrations?.[0],
	)
	assert.equal(contributions.persistence[0]?.schema, Schema.String)
	assert.equal(contributions.persistence[0]?.migrations?.[0]?.run, Effect.void)
	assert.equal(contributions.pipelines[0]?.run, pipeline.run)
	assert.deepEqual(contributions.http[0], http)
	assert.deepEqual(config.modelRoutes, [route])
	assert.deepEqual(config.deployments, [deployment])
	assert.equal("layer" in contributions, false)
	assert.equal("init" in contributions, false)
})

const malformed = [
	{ name: "missing capabilities", value: { id: "fixture", config: {} }, path: ["capabilities"] },
	{ name: "missing config", value: { id: "fixture", capabilities: [] }, path: ["config"] },
	{
		name: "invalid runtime layer",
		value: { id: "fixture", capabilities: [], config: {}, layer: {} },
		path: ["layer"],
	},
	{
		name: "invalid init",
		value: { id: "fixture", capabilities: [], config: {}, init: true },
		path: ["init"],
	},
] as const

malformed.forEach(({ name, value, path }) =>
	it(`rejects ${name} with a Schema issue path`, () => {
		const validated = Plugin.validate(value)
		assert.ok(Result.isFailure(validated))
		if (Result.isFailure(validated)) {
			assert.ok(validated.failure._tag === "RouterInvalidPlugin")
			if (validated.failure._tag === "RouterInvalidPlugin") {
				assert.equal(validated.failure.id, "fixture")
				assert.ok(
					validated.failure.issues?.some(
						(issue) => issue.path.join(".") === path.join("."),
					),
				)
			}
		}
	}),
)

it("decodes setup failures with stable nested Schema issue data", () => {
	const wire = {
		_tag: "RouterInvalidPlugin",
		id: "fixture",
		message: "Invalid deployment",
		issues: [
			{
				path: ["config", "deployments", 0, "limits", "rpm"],
				message: "Expected nonnegative",
			},
		],
	} as const
	const decoded = Schema.decodeUnknownResult(Plugin.SetupError)(wire)

	assert.ok(Result.isSuccess(decoded))
	if (Result.isSuccess(decoded)) {
		assert.ok(decoded.success._tag === "RouterInvalidPlugin")
		if (decoded.success._tag === "RouterInvalidPlugin") {
			assert.deepEqual(decoded.success.issues, wire.issues)
		}
	}
	assert.deepEqual(wire.issues[0].path, ["config", "deployments", 0, "limits", "rpm"])
})
