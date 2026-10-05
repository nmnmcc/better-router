import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, HashMap, Option, Result, Schema, Stream } from "effect"
import * as Capability from "@better-router/core/Capability"
import * as Deployment from "@better-router/core/Deployment"
import * as Generation from "@better-router/core/Generation"
import * as Plugin from "@better-router/core/Plugin"
import type { Handler, HttpHandler, PluginConfig } from "@better-router/core/PluginContributions"
import * as ProviderContract from "@better-router/core/ProviderContract"
import * as Registry from "@better-router/core/Registry"
import type { RoutingContext } from "@better-router/core/Routing"

const endpoint = { id: "generation", parameters: ["input"], streaming: true } as const

const providerCapability = Capability.make({
	id: "fixture.provider",
	version: 1,
	kind: "provider",
	projections: ["generation"],
	endpoints: [endpoint],
})

const runtime = (_deployment: Deployment.DeploymentConfig) =>
	Effect.succeed({
		generate: (_request: Generation.GenerationRequest) => Generation.Process.make(Stream.empty),
	})

const provider = ProviderContract.make({
	id: "fixture-provider",
	endpoints: [{ ...endpoint, capabilities: ["generation"] }],
	protocols: ["responses"],
	capabilities: [{ id: "generation", version: 1 }],
	runtime,
})

const deployment = Deployment.make({
	id: "primary",
	provider: provider.id,
	model: "private-model",
	protocol: "responses",
	credentialRef: "secrets/primary",
	tags: ["production"],
})

const policy = { id: "policy", strategy: "simple" } as const

const middleware: {
	readonly id: string
	readonly wrap: <R>(next: Handler<R>) => Handler<R>
} = {
	id: "middleware",
	wrap: <R>(next: Handler<R>) => next,
}

const hook = {
	id: "hook",
	beforeRequest: () => Effect.void,
} as const

const httpMiddleware = {
	id: "http-middleware",
	wrap: <R>(next: HttpHandler<R>) => next,
} as const

const pipeline = {
	id: "pipeline",
	run: (context: RoutingContext) => Effect.succeed(context),
} as const

const projection = {
	id: "projection",
	protocol: "responses",
	capability: "generation",
} as const

const modelRoute = {
	id: "chat-route",
	model: "chat",
	deployments: [deployment.id],
	policy: policy.id,
	pipelines: [pipeline.id],
	middleware: [middleware.id],
} as const

const httpEndpoint = (id: string, path: string, method = "POST") => ({
	id,
	method,
	path,
	input: Schema.String,
	output: Schema.String,
	handler: (input: string) => Effect.succeed(input),
})

const fromConfig = (config: PluginConfig) =>
	Registry.fromPlugins([Plugin.make({ id: "fixture", capabilities: [], config })])

const failureOf = (plugins: readonly unknown[]): Plugin.SetupError => {
	const result = Registry.fromPlugins(plugins as readonly Plugin.AnyPlugin[])
	assert.ok(Result.isFailure(result), "Expected a typed registry preflight failure")
	if (Result.isFailure(result)) return result.failure
	return assert.fail("Expected a typed registry preflight failure")
}

const configFailure = (config: unknown): Plugin.SetupError =>
	failureOf([{ id: "fixture", capabilities: [], config }])

const assertIssueAt = (error: Plugin.SetupError, path: readonly (string | number)[]) => {
	assert.equal(error._tag, "RouterInvalidPlugin")
	if (error._tag !== "RouterInvalidPlugin") return assert.fail("Expected RouterInvalidPlugin")
	assert.ok(
		error.issues?.some(
			(issue) =>
				issue.path.length === path.length &&
				issue.path.every((segment, index) => segment === path[index]),
		),
		`Expected Schema issue path ${JSON.stringify(path)}`,
	)
}

it("indexes forward-referenced static declarations and preserves caller input", () => {
	const routeInput = {
		...modelRoute,
		deployments: [...modelRoute.deployments],
		pipelines: [...modelRoute.pipelines],
	}
	const deploymentInput = { ...deployment, tags: [...(deployment.tags ?? [])] }
	const original = JSON.stringify({ routeInput, deploymentInput })
	const http = { ...httpEndpoint("custom-http", "/custom"), middleware: [httpMiddleware] }
	const plugins = [
		Plugin.make({
			id: "routes-first",
			capabilities: [providerCapability],
			config: { modelRoutes: [routeInput], middleware: [middleware], http: [http] },
		}),
		Plugin.make({
			id: "definitions-later",
			capabilities: [],
			config: {
				providers: [provider],
				deployments: [deploymentInput],
				policies: [policy],
				pipelines: [pipeline],
				projections: [projection],
				hooks: [hook],
			},
		}),
	] as const
	const result = Registry.fromPlugins(plugins)

	assert.ok(Result.isSuccess(result))
	const snapshot = result.success
	assert.deepEqual(
		snapshot.plugins.map((plugin) => plugin.id),
		["routes-first", "definitions-later"],
	)
	assert.deepEqual(
		snapshot.providerContracts.map((contract) => contract.id),
		[provider.id],
	)
	assert.deepEqual(
		snapshot.deployments.map((item) => item.id),
		[deployment.id],
	)
	assert.deepEqual(
		snapshot.modelRoutes.map((route) => route.model),
		[modelRoute.model],
	)
	assert.deepEqual(
		snapshot.http.map((item) => item.id),
		[http.id],
	)
	assert.deepEqual(
		Option.getOrUndefined(HashMap.get(snapshot.capabilityIndex, "generation")),
		Capability.generation,
	)
	const registeredCapability = snapshot.capabilities.find(
		(value) => value.id === providerCapability.id,
	)
	assert.ok(registeredCapability !== undefined)
	assert.notEqual(registeredCapability, providerCapability)
	assert.notEqual(registeredCapability.projections, providerCapability.projections)
	assert.deepEqual(registeredCapability, providerCapability)
	assert.deepEqual(
		Option.getOrUndefined(HashMap.get(snapshot.providerContractIndex, provider.id)),
		provider,
	)
	const registeredProvider = snapshot.providerContracts[0]
	assert.ok(registeredProvider !== undefined)
	assert.notEqual(registeredProvider, provider)
	assert.notEqual(registeredProvider.endpoints, provider.endpoints)
	assert.notEqual(registeredProvider.endpoints[0], provider.endpoints[0])
	assert.notEqual(registeredProvider.endpoints[0]?.parameters, provider.endpoints[0]?.parameters)
	assert.notEqual(
		registeredProvider.endpoints[0]?.capabilities,
		provider.endpoints[0]?.capabilities,
	)
	assert.notEqual(registeredProvider.capabilities, provider.capabilities)
	assert.notEqual(registeredProvider.capabilities?.[0], provider.capabilities?.[0])
	assert.notEqual(registeredProvider.protocols, provider.protocols)
	assert.deepEqual(
		Option.getOrUndefined(HashMap.get(snapshot.deploymentIndex, deployment.id)),
		deploymentInput,
	)
	assert.notEqual(snapshot.deployments[0], deploymentInput)
	assert.notEqual(snapshot.deployments[0]?.tags, deploymentInput.tags)
	assert.deepEqual(
		Option.getOrUndefined(HashMap.get(snapshot.modelRouteIndex, modelRoute.model)),
		routeInput,
	)
	assert.notEqual(snapshot.modelRoutes[0], routeInput)
	assert.notEqual(snapshot.modelRoutes[0]?.deployments, routeInput.deployments)
	assert.notEqual(snapshot.modelRoutes[0]?.pipelines, routeInput.pipelines)
	assert.notEqual(snapshot.modelRoutes[0]?.middleware, routeInput.middleware)
	assert.deepEqual(Option.getOrUndefined(HashMap.get(snapshot.policyIndex, policy.id)), policy)
	assert.notEqual(snapshot.policies[0], policy)
	assert.deepEqual(
		Option.getOrUndefined(HashMap.get(snapshot.pipelineIndex, pipeline.id)),
		pipeline,
	)
	assert.notEqual(snapshot.pipelines[0], pipeline)
	assert.deepEqual(
		Option.getOrUndefined(HashMap.get(snapshot.projectionIndex, projection.id)),
		projection,
	)
	assert.notEqual(snapshot.projections[0], projection)
	assert.notEqual(snapshot.middleware[0], middleware)
	assert.notEqual(snapshot.hooks[0], hook)
	assert.notEqual(snapshot.http[0], http)
	const registeredHttp = snapshot.http[0]
	assert.ok(registeredHttp !== undefined && "method" in registeredHttp)
	if (registeredHttp !== undefined && "method" in registeredHttp) {
		assert.notEqual(registeredHttp.middleware, http.middleware)
		assert.notEqual(registeredHttp.middleware?.[0], http.middleware[0])
		assert.equal(registeredHttp.middleware?.[0]?.wrap, httpMiddleware.wrap)
	}
	assert.notEqual(snapshot.plugins[0], plugins[0])
	assert.notEqual(snapshot.plugins[0]?.config, plugins[0].config)
	assert.notEqual(snapshot.plugins[0]?.config.modelRoutes, plugins[0].config.modelRoutes)
	assert.notEqual(
		snapshot.plugins[0]?.config.modelRoutes?.[0],
		plugins[0].config.modelRoutes?.[0],
	)
	assert.notEqual(snapshot.plugins[0]?.config.middleware, plugins[0].config.middleware)
	assert.notEqual(snapshot.plugins[0]?.config.middleware?.[0], plugins[0].config.middleware?.[0])
	assert.notEqual(snapshot.plugins[0]?.config.http, plugins[0].config.http)
	assert.notEqual(snapshot.plugins[0]?.config.http?.[0], plugins[0].config.http?.[0])
	assert.notEqual(snapshot.plugins[1]?.config.providers, plugins[1].config.providers)
	assert.notEqual(snapshot.plugins[1]?.config.providers?.[0], plugins[1].config.providers?.[0])
	assert.notEqual(snapshot.plugins[1]?.config.hooks, plugins[1].config.hooks)
	assert.notEqual(snapshot.plugins[1]?.config.hooks?.[0], plugins[1].config.hooks?.[0])
	assert.notEqual(snapshot.plugins, plugins)
	assert.equal(JSON.stringify({ routeInput, deploymentInput }), original)
})

const malformedPlugins = [
	{ name: "null plugin", value: null, path: [] },
	{ name: "numeric plugin id", value: { id: 1, capabilities: [], config: {} }, path: ["id"] },
	{
		name: "null config",
		value: { id: "fixture", capabilities: [], config: null },
		path: ["config"],
	},
	{
		name: "invalid nested capability endpoint",
		value: {
			id: "fixture",
			capabilities: [
				{
					id: "fixture.capability",
					version: 1,
					kind: "provider",
					projections: [],
					endpoints: [{ ...endpoint, streaming: "yes" }],
				},
			],
			config: {},
		},
		path: ["capabilities", 0, "endpoints", 0, "streaming"],
	},
] as const

malformedPlugins.forEach(({ name, value, path }) =>
	it(`returns a typed Schema error for ${name}`, () => {
		assertIssueAt(failureOf([value]), path)
	}),
)

const malformedConfigs = [
	{ name: "non-array provider declarations", config: { providers: {} }, path: ["providers"] },
	{ name: "null provider item", config: { providers: [null] }, path: ["providers", 0] },
	{
		name: "invalid provider endpoint parameter",
		config: { providers: [{ ...provider, endpoints: [{ ...endpoint, parameters: [1] }] }] },
		path: ["providers", 0, "endpoints", 0, "parameters", 0],
	},
	{
		name: "empty provider endpoint matrix",
		config: { providers: [{ ...provider, endpoints: [] }] },
		path: ["providers", 0, "endpoints"],
	},
	{
		name: "invalid deployment limit",
		config: { deployments: [{ ...deployment, limits: { rpm: -1 } }] },
		path: ["deployments", 0, "limits", "rpm"],
	},
	{
		name: "non-array model candidates",
		config: { modelRoutes: [{ model: "chat", deployments: "primary" }] },
		path: ["modelRoutes", 0, "deployments"],
	},
	{
		name: "non-function policy rank",
		config: { policies: [{ id: "policy", rank: 1 }] },
		path: ["policies", 0, "rank"],
	},
	{
		name: "non-function pipeline executor",
		config: { pipelines: [{ id: "pipeline", run: null }] },
		path: ["pipelines", 0, "run"],
	},
	{
		name: "invalid projection capability",
		config: { projections: [{ ...projection, capability: 1 }] },
		path: ["projections", 0, "capability"],
	},
	{
		name: "non-function middleware wrapper",
		config: { middleware: [{ id: "middleware", wrap: false }] },
		path: ["middleware", 0, "wrap"],
	},
	{
		name: "non-function lifecycle hook",
		config: { hooks: [{ id: "hook", beforeRequest: false }] },
		path: ["hooks", 0, "beforeRequest"],
	},
	{
		name: "non-function HTTP handler",
		config: { http: [{ ...httpEndpoint("http", "/custom"), handler: 1 }] },
		path: ["http", 0, "handler"],
	},
	{
		name: "invalid HTTP method",
		config: { http: [{ ...httpEndpoint("http", "/custom"), method: "INVALID" }] },
		path: ["http", 0, "method"],
	},
	{
		name: "invalid HTTP path",
		config: { http: [{ ...httpEndpoint("http", "/custom"), path: "custom" }] },
		path: ["http", 0, "path"],
	},
	{
		name: "non-API HTTP contract",
		config: {
			http: [{ id: "http", api: {}, contract: { api: {}, layer: () => Effect.void } }],
		},
		path: ["http", 0, "api"],
	},
	{
		name: "non-Schema persistence declaration",
		config: { persistence: [{ namespace: "fixture", schema: "not-a-schema" }] },
		path: ["persistence", 0, "schema"],
	},
] as const

malformedConfigs.forEach(({ name, config, path }) =>
	it(`preserves the nested config issue path for ${name}`, () => {
		assertIssueAt(configFailure(config), ["config", ...path])
	}),
)

it("rejects removed state and runtime-layer config aliases", () => {
	const removedShapes = [
		{ id: "fixture", capabilities: [], config: {}, state: {} },
		{ id: "fixture", capabilities: [], config: { layers: [] } },
		{ id: "fixture", capabilities: [], config: { apis: [] } },
		{ id: "fixture", capabilities: [], config: { route: {} } },
		{ id: "fixture", capabilities: [], config: { routes: [] } },
	] as const
	removedShapes.forEach((value) => {
		const failure = failureOf([value])
		assert.equal(failure._tag, "RouterInvalidPlugin")
	})
})

const duplicateConfigs: readonly {
	readonly name: string
	readonly kind:
		| "deployment"
		| "model"
		| "policy"
		| "pipeline"
		| "projection"
		| "middleware"
		| "hook"
		| "persistence"
		| "http_route"
	readonly id: string
	readonly config: PluginConfig
}[] = [
	{
		name: "deployment identifiers",
		kind: "deployment",
		id: deployment.id,
		config: { providers: [provider], deployments: [deployment, deployment] },
	},
	{
		name: "public model aliases",
		kind: "model",
		id: "chat",
		config: {
			providers: [provider],
			deployments: [deployment],
			modelRoutes: [
				{ model: "chat", deployments: [deployment.id] },
				{ model: "chat", deployments: [deployment.id] },
			],
		},
	},
	{
		name: "routing policy identifiers",
		kind: "policy",
		id: policy.id,
		config: { policies: [policy, policy] },
	},
	{
		name: "model route identifiers across aliases",
		kind: "model",
		id: "shared-route",
		config: {
			providers: [provider],
			deployments: [deployment],
			modelRoutes: [
				{ id: "shared-route", model: "chat", deployments: [deployment.id] },
				{ id: "shared-route", model: "other-chat", deployments: [deployment.id] },
			],
		},
	},
	{
		name: "routing pipeline identifiers",
		kind: "pipeline",
		id: pipeline.id,
		config: { pipelines: [pipeline, pipeline] },
	},
	{
		name: "projection identifiers",
		kind: "projection",
		id: projection.id,
		config: { projections: [projection, projection] },
	},
	{
		name: "HTTP contribution identifiers",
		kind: "http_route",
		id: "custom",
		config: { http: [httpEndpoint("custom", "/first"), httpEndpoint("custom", "/second")] },
	},
	{
		name: "middleware identifiers",
		kind: "middleware",
		id: middleware.id,
		config: { middleware: [middleware, middleware] },
	},
	{
		name: "hook identifiers",
		kind: "hook",
		id: hook.id,
		config: { hooks: [hook, hook] },
	},
	{
		name: "persistence namespaces",
		kind: "persistence",
		id: "fixture-state",
		config: {
			persistence: [
				{ namespace: "fixture-state", schema: Schema.String },
				{ namespace: "fixture-state", schema: Schema.String },
			],
		},
	},
]

duplicateConfigs.forEach(({ name, kind, id, config }) =>
	it(`rejects duplicate ${name}`, () => {
		const result = fromConfig(config)
		assert.ok(Result.isFailure(result))
		assert.equal(result.failure._tag, "RouterDuplicateId")
		assert.ok(result.failure._tag === "RouterDuplicateId")
		assert.equal(result.failure.kind, kind)
		assert.equal(result.failure.id, id)
	}),
)

it("rejects duplicate plugin identifiers before running initialization", () => {
	const plugin = Plugin.make({
		id: "duplicate-plugin",
		capabilities: [],
		config: {},
		init: () => Effect.die("Registry preflight must not run init"),
	})
	const error = failureOf([plugin, plugin])
	assert.ok(error._tag === "RouterDuplicateId")
	assert.equal(error.kind, "plugin")
	assert.equal(error.id, plugin.id)
})

it("rejects duplicate capability identifiers across plugins", () => {
	const capability = Capability.make({ id: "fixture.capability", version: 1, kind: "routing" })
	const error = failureOf([
		Plugin.make({ id: "first", capabilities: [capability], config: {} }),
		Plugin.make({ id: "second", capabilities: [capability], config: {} }),
	])
	assert.ok(error._tag === "RouterDuplicateId")
	assert.equal(error.kind, "capability")
	assert.equal(error.id, capability.id)
})

it("reuses the same provider contract object across plugins", () => {
	const result = Registry.fromPlugins([
		Plugin.make({ id: "first", capabilities: [], config: { providers: [provider] } }),
		Plugin.make({
			id: "second",
			capabilities: [],
			config: { providers: [provider], deployments: [deployment] },
		}),
	])
	assert.ok(Result.isSuccess(result))
	assert.equal(result.success.providerContracts.length, 1)
	assert.deepEqual(
		Option.getOrUndefined(HashMap.get(result.success.providerContractIndex, provider.id)),
		provider,
	)
	assert.notEqual(result.success.providerContracts[0], provider)
})

it("rejects different provider contract objects with the same identifier", () => {
	const second = { ...provider }
	const error = failureOf([
		Plugin.make({ id: "first", capabilities: [], config: { providers: [provider] } }),
		Plugin.make({ id: "second", capabilities: [], config: { providers: [second] } }),
	])
	assert.ok(error._tag === "RouterDuplicateId")
	assert.equal(error.kind, "provider")
	assert.equal(error.id, provider.id)
})

it("rejects duplicate HTTP method/path pairs across plugins", () => {
	const error = failureOf([
		Plugin.make({
			id: "first",
			capabilities: [],
			config: {
				http: [httpEndpoint("first-endpoint", "/custom")],
			},
		}),
		Plugin.make({
			id: "second",
			capabilities: [],
			config: {
				http: [httpEndpoint("second-endpoint", "/custom")],
			},
		}),
	])
	assert.ok(error._tag === "RouterDuplicateHttpRoute")
	assert.equal(error.method, "POST")
	assert.equal(error.path, "/custom")
})

it("accepts the same HTTP path when methods differ", () => {
	const result = fromConfig({
		http: [httpEndpoint("get", "/custom", "GET"), httpEndpoint("post", "/custom")],
	})
	assert.ok(Result.isSuccess(result))
	assert.deepEqual(
		result.success.http.map((item) => item.id),
		["get", "post"],
	)
})

const unknownReferences: readonly {
	readonly name: string
	readonly kind: "deployment" | "model" | "projection"
	readonly id: string
	readonly config: PluginConfig
}[] = [
	{
		name: "provider contract",
		kind: "deployment",
		id: deployment.id,
		config: { deployments: [deployment] },
	},
	{
		name: "model candidate deployment",
		kind: "model",
		id: "chat",
		config: { modelRoutes: [{ model: "chat", deployments: ["missing"] }] },
	},
	{
		name: "model fallback deployment",
		kind: "model",
		id: "chat",
		config: {
			providers: [provider],
			deployments: [deployment],
			modelRoutes: [{ model: "chat", deployments: [deployment.id], fallback: ["missing"] }],
		},
	},
	{
		name: "routing policy",
		kind: "model",
		id: "chat",
		config: {
			providers: [provider],
			deployments: [deployment],
			modelRoutes: [{ model: "chat", deployments: [deployment.id], policy: "missing" }],
		},
	},
	{
		name: "routing pipeline",
		kind: "model",
		id: "chat",
		config: {
			providers: [provider],
			deployments: [deployment],
			modelRoutes: [{ model: "chat", deployments: [deployment.id], pipelines: ["missing"] }],
		},
	},
	{
		name: "middleware",
		kind: "model",
		id: "chat",
		config: {
			providers: [provider],
			deployments: [deployment],
			modelRoutes: [{ model: "chat", deployments: [deployment.id], middleware: ["missing"] }],
		},
	},
	{
		name: "projection capability",
		kind: "projection",
		id: projection.id,
		config: { projections: [{ ...projection, capability: "missing" }] },
	},
]

unknownReferences.forEach(({ name, kind, id, config }) =>
	it(`rejects an unknown ${name} reference`, () => {
		const result = fromConfig(config)
		assert.ok(Result.isFailure(result))
		assert.ok(result.failure._tag === "RouterInvalidDeclaration")
		assert.equal(result.failure.kind, kind)
		assert.equal(result.failure.id, id)
	}),
)

it("rejects duplicate model candidates before runtime selection", () => {
	const result = fromConfig({
		providers: [provider],
		deployments: [deployment],
		modelRoutes: [{ model: "chat", deployments: [deployment.id, deployment.id] }],
	})
	assert.ok(Result.isFailure(result))
	assert.ok(result.failure._tag === "RouterInvalidDeclaration")
	assert.equal(result.failure.kind, "model")
	assert.equal(result.failure.id, "chat")
})

it("rejects an unsupported deployment protocol before resource acquisition", () => {
	const unsupported = { ...deployment, protocol: "messages" }
	const result = fromConfig({ providers: [provider], deployments: [unsupported] })
	assert.ok(Result.isFailure(result))
	assert.ok(result.failure._tag === "RouterUnsupportedCombination")
	assert.equal(result.failure.provider, provider.id)
	assert.equal(result.failure.deployment, deployment.id)
	assert.equal(result.failure.protocol, "messages")
})

it("rejects an explicit endpoint demand that is absent from the provider matrix", () => {
	const result = fromConfig({
		providers: [provider],
		deployments: [{ ...deployment, endpoint: "chat-completions" }],
	})
	assert.ok(Result.isFailure(result))
	if (Result.isFailure(result)) {
		assert.ok(result.failure._tag === "RouterUnsupportedCombination")
		if (result.failure._tag === "RouterUnsupportedCombination") {
			assert.equal(result.failure.provider, provider.id)
			assert.equal(result.failure.deployment, deployment.id)
			assert.equal(result.failure.protocol, deployment.protocol)
		}
	}
})

it("rejects deployment parameter demand outside the provider endpoint matrix", () => {
	const result = fromConfig({
		providers: [provider],
		deployments: [{ ...deployment, parameters: ["tools"] }],
	})
	assert.ok(Result.isFailure(result))
	if (Result.isFailure(result)) {
		assert.ok(result.failure._tag === "RouterUnsupportedCombination")
		if (result.failure._tag === "RouterUnsupportedCombination") {
			assert.equal(result.failure.provider, provider.id)
			assert.equal(result.failure.deployment, deployment.id)
		}
	}
})

it("rejects a provider with no generation endpoint", () => {
	const unsupported = ProviderContract.make({
		...provider,
		endpoints: [{ ...endpoint, id: "embeddings" }],
	})
	const result = fromConfig({ providers: [unsupported], deployments: [deployment] })
	assert.ok(Result.isFailure(result))
	assert.ok(result.failure._tag === "RouterUnsupportedCombination")
	assert.equal(result.failure.provider, provider.id)
	assert.equal(result.failure.deployment, deployment.id)
})

it("rejects a deployment streaming demand when its endpoint cannot stream", () => {
	const unsupported = ProviderContract.make({
		...provider,
		endpoints: [{ ...endpoint, streaming: false }],
	})
	const result = fromConfig({
		providers: [unsupported],
		deployments: [{ ...deployment, streaming: true }],
	})
	assert.ok(Result.isFailure(result))
	if (Result.isFailure(result)) {
		assert.ok(result.failure._tag === "RouterUnsupportedCombination")
		if (result.failure._tag === "RouterUnsupportedCombination") {
			assert.equal(result.failure.provider, provider.id)
			assert.equal(result.failure.deployment, deployment.id)
		}
	}
})

it("accepts a non-streaming deployment without a streaming endpoint", () => {
	const nonStreaming = ProviderContract.make({
		...provider,
		endpoints: [{ ...endpoint, streaming: false }],
	})
	const result = fromConfig({
		providers: [nonStreaming],
		deployments: [{ ...deployment, streaming: false }],
	})
	assert.ok(Result.isSuccess(result))
})

it("rejects an unknown strategy on a model route", () => {
	const result = fromConfig({
		providers: [provider],
		deployments: [deployment],
		modelRoutes: [{ model: "chat", deployments: [deployment.id], strategy: "missing" }],
	})
	assert.ok(Result.isFailure(result))
	if (Result.isFailure(result)) {
		assert.ok(result.failure._tag === "RouterInvalidDeclaration")
		if (result.failure._tag === "RouterInvalidDeclaration") {
			assert.equal(result.failure.kind, "model")
			assert.equal(result.failure.id, "chat")
		}
	}
})

it("rejects an unknown strategy on a declared policy", () => {
	const result = fromConfig({ policies: [{ id: "policy", strategy: "missing" }] })
	assert.ok(Result.isFailure(result))
	if (Result.isFailure(result)) {
		assert.ok(result.failure._tag === "RouterInvalidDeclaration")
		if (result.failure._tag === "RouterInvalidDeclaration") {
			assert.equal(result.failure.kind, "policy")
			assert.equal(result.failure.id, "policy")
		}
	}
})

it("rejects a policy with no rank implementation or strategy", () => {
	const result = fromConfig({ policies: [{ id: "empty-policy" }] })
	assert.ok(Result.isFailure(result))
	if (Result.isFailure(result)) {
		assert.ok(result.failure._tag === "RouterInvalidDeclaration")
		if (result.failure._tag === "RouterInvalidDeclaration") {
			assert.equal(result.failure.kind, "policy")
			assert.equal(result.failure.id, "empty-policy")
		}
	}
})

it("rejects an unsatisfied model capability requirement", () => {
	const required = Capability.make({ id: "fixture.tools", version: 1, kind: "generation" })
	const result = Registry.fromPlugins([
		Plugin.make({
			id: "fixture",
			capabilities: [required],
			config: {
				providers: [provider],
				deployments: [deployment],
				modelRoutes: [
					{
						model: "chat",
						deployments: [deployment.id],
						requiredCapabilities: [required.id],
					},
				],
			},
		}),
	])
	assert.ok(Result.isFailure(result))
	assert.ok(result.failure._tag === "RouterUnsupportedCombination")
	assert.equal(result.failure.provider, provider.id)
	assert.equal(result.failure.deployment, deployment.id)
})

it("preflights route capability, parameter and streaming demand on every candidate", () => {
	const result = fromConfig({
		providers: [provider],
		deployments: [deployment, { ...deployment, id: "fallback" }],
		modelRoutes: [
			{
				model: "chat",
				deployments: [deployment.id],
				fallback: ["fallback"],
				requiredCapabilities: ["generation"],
				requiredParameters: ["input"],
				streaming: true,
			},
		],
	})
	assert.ok(Result.isSuccess(result))
	if (Result.isSuccess(result)) {
		assert.deepEqual(result.success.modelRoutes[0]?.requiredCapabilities, ["generation"])
		assert.deepEqual(result.success.modelRoutes[0]?.requiredParameters, ["input"])
		assert.deepEqual(result.success.modelRoutes[0]?.fallback, ["fallback"])
	}
})

it("rejects route parameter demand unsupported by one fallback candidate", () => {
	const fallbackProvider = ProviderContract.make({
		...provider,
		id: "fallback-provider",
		endpoints: [{ ...endpoint, parameters: [], capabilities: ["generation"] }],
	})
	const result = fromConfig({
		providers: [provider, fallbackProvider],
		deployments: [deployment, { ...deployment, id: "fallback", provider: fallbackProvider.id }],
		modelRoutes: [
			{
				model: "chat",
				deployments: [deployment.id],
				fallback: ["fallback"],
				requiredParameters: ["input"],
			},
		],
	})
	assert.ok(Result.isFailure(result))
	if (Result.isFailure(result)) {
		assert.ok(result.failure._tag === "RouterUnsupportedCombination")
		if (result.failure._tag === "RouterUnsupportedCombination") {
			assert.equal(result.failure.provider, fallbackProvider.id)
			assert.equal(result.failure.deployment, "fallback")
		}
	}
})

it("rejects route capability demand unsupported by one fallback candidate", () => {
	const fallbackProvider = ProviderContract.make({
		...provider,
		id: "fallback-provider",
		endpoints: [{ ...endpoint, capabilities: [] }],
	})
	const result = fromConfig({
		providers: [provider, fallbackProvider],
		deployments: [deployment, { ...deployment, id: "fallback", provider: fallbackProvider.id }],
		modelRoutes: [
			{
				model: "chat",
				deployments: [deployment.id],
				fallback: ["fallback"],
				requiredCapabilities: ["generation"],
			},
		],
	})
	assert.ok(Result.isFailure(result))
	if (Result.isFailure(result)) {
		assert.ok(result.failure._tag === "RouterUnsupportedCombination")
		if (result.failure._tag === "RouterUnsupportedCombination") {
			assert.equal(result.failure.provider, fallbackProvider.id)
			assert.equal(result.failure.deployment, "fallback")
		}
	}
})
