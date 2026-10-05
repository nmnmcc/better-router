import {
	Context,
	Effect,
	FileSystem,
	Layer,
	Result,
	Schema,
	SchemaGetter,
	Scope,
	Stream,
} from "effect"
import { describe, expect, it } from "tstyche"
import * as Generation from "@better-router/core/Generation"
import * as Plugin from "@better-router/core/Plugin"
import * as Persistence from "@better-router/core/Persistence"
import type { HttpMiddleware } from "@better-router/core/PluginContributions"
import * as ProviderContract from "@better-router/core/ProviderContract"
import * as Router from "@better-router/core/Router"

class ExternalService extends Context.Service<ExternalService, { readonly name: string }>()(
	"BetterRouterTypeExternal",
) {}

class PluginService extends Context.Service<PluginService, { readonly name: string }>()(
	"BetterRouterTypePlugin",
) {}

class DecodeService extends Context.Service<DecodeService, { readonly value: string }>()(
	"BetterRouterTypeDecode",
) {}

class EncodeService extends Context.Service<EncodeService, { readonly value: string }>()(
	"BetterRouterTypeEncode",
) {}

class UnusedSchemaService extends Context.Service<
	UnusedSchemaService,
	{ readonly value: string }
>()("BetterRouterTypeUnusedSchema") {}

const response = {
	type: "response.completed" as const,
	sequence_number: 0,
	response: { id: "type-fixture", status: "completed" } as never,
}

const externalProvider = ProviderContract.make({
	id: "typed-provider",
	endpoints: [{ id: "generation", parameters: [], streaming: true }],
	runtime: () =>
		Effect.gen(function* () {
			yield* ExternalService
			return {
				generate: () => Generation.Process.make(Stream.succeed(response)),
			}
		}),
})

const pluginProvider = ProviderContract.make({
	id: "typed-plugin-provider",
	endpoints: [{ id: "generation", parameters: [], streaming: true }],
	runtime: () =>
		Effect.gen(function* () {
			yield* PluginService
			return {
				generate: () => Generation.Process.make(Stream.succeed(response)),
			}
		}),
})

const supplied = Plugin.make({
	id: "supplied",
	capabilities: [] as const,
	config: {
		providers: [pluginProvider] as const,
		http: [
			{
				id: "supplied-http",
				method: "POST",
				path: "/typed",
				input: Schema.Struct({ value: Schema.String }),
				output: Schema.Struct({ value: Schema.String }),
				handler: () =>
					Effect.gen(function* () {
						const service = yield* PluginService
						return { value: service.name }
					}),
			},
		] as const,
	},
	layer: Layer.succeed(PluginService, { name: "provided" }),
	init: () => Effect.asVoid(PluginService),
})

describe("Router declaration and runtime types", () => {
	it("makes static preflight a pure Result", () => {
		const result = Router.make({ plugins: [supplied] as const })
		expect<typeof result>().type.toBe<
			Result.Result<Router.Router<readonly [typeof supplied]>, Plugin.SetupError>
		>()
	})

	it("removes services supplied by plugin Layers from init, Provider and HTTP requirements", () => {
		const router = Result.getOrThrow(Router.make({ plugins: [supplied] as const }))
		const runtime = Router.runtime(router)
		const layer = Router.layer(router)

		expect<Effect.Services<typeof runtime>>().type.toBe<Scope.Scope>()
		expect<Layer.Services<typeof layer>>().type.toBe<never>()
		expect<Layer.Success<typeof layer>>().type.toBe<Router.RouterRuntime>()
		expect<Effect.Error<typeof runtime>>().type.toBe<Router.StartupError>()
	})

	it("supplies default persistence even when plugin Layers need it", () => {
		const needsPersistence = Plugin.make({
			id: "persistence-layer",
			capabilities: [] as const,
			config: {},
			layer: Layer.effect(
				PluginService,
				Persistence.Persistence.pipe(Effect.as({ name: "default-memory" })),
			),
			init: () => Effect.asVoid(Persistence.Persistence),
		})
		const router = Result.getOrThrow(Router.make({ plugins: [needsPersistence] as const }))
		const runtime = Router.runtime(router)
		const layer = Router.layer(router)

		expect<Effect.Services<typeof runtime>>().type.toBe<Scope.Scope>()
		expect<Layer.Services<typeof layer>>().type.toBe<never>()
	})

	it("keeps filesystem requirements used by eager init visible", () => {
		const needsFilesystem = Plugin.make({
			id: "filesystem-init",
			capabilities: [] as const,
			config: {},
			init: () => Effect.asVoid(FileSystem.FileSystem),
		})
		const router = Result.getOrThrow(Router.make({ plugins: [needsFilesystem] as const }))
		const runtime = Router.runtime(router)
		const layer = Router.layer(router)

		expect<Effect.Services<typeof runtime>>().type.toBe<Scope.Scope | FileSystem.FileSystem>()
		expect<Layer.Services<typeof layer>>().type.toBe<FileSystem.FileSystem>()
	})

	it("requires only input decoding and output encoding services for direct HTTP schemas", () => {
		const input = Schema.Struct({
			value: Schema.String.pipe(
				Schema.decodeTo(Schema.String, {
					decode: SchemaGetter.transformEffect((value: string) =>
						Effect.as(DecodeService, value),
					),
					encode: SchemaGetter.transformEffect((value: string) =>
						Effect.as(UnusedSchemaService, value),
					),
				}),
			),
		})
		const output = Schema.Struct({
			value: Schema.String.pipe(
				Schema.decodeTo(Schema.String, {
					decode: SchemaGetter.transformEffect((value: string) =>
						Effect.as(UnusedSchemaService, value),
					),
					encode: SchemaGetter.transformEffect((value: string) =>
						Effect.as(EncodeService, value),
					),
				}),
			),
		})
		const schemaDependent = Plugin.make({
			id: "schema-http",
			capabilities: [] as const,
			config: {
				http: [
					{
						id: "schema-http",
						method: "POST",
						path: "/typed-schema",
						input,
						output,
						handler: (value: typeof input.Type) => Effect.succeed(value),
					},
				] as const,
			},
		})
		const router = Result.getOrThrow(Router.make({ plugins: [schemaDependent] as const }))
		const runtime = Router.runtime(router)
		const layer = Router.layer(router)

		expect<Effect.Services<typeof runtime>>().type.toBe<
			Scope.Scope | DecodeService | EncodeService
		>()
		expect<Layer.Services<typeof layer>>().type.toBe<DecodeService | EncodeService>()
	})

	it("keeps external Layer, init and Provider requirements visible", () => {
		const needsExternal = Plugin.make({
			id: "needs-external",
			capabilities: [] as const,
			config: { providers: [externalProvider] as const },
			layer: Layer.effect(
				PluginService,
				Effect.map(ExternalService, ({ name }) => ({ name })),
			),
			init: () => Effect.asVoid(ExternalService),
		})
		const router = Result.getOrThrow(Router.make({ plugins: [needsExternal] as const }))
		const runtime = Router.runtime(router)
		const layer = Router.layer(router)

		expect<Effect.Services<typeof runtime>>().type.toBe<ExternalService | Scope.Scope>()
		expect<Layer.Services<typeof layer>>().type.toBe<ExternalService>()
	})

	it("threads sibling Layer outputs in declaration order", () => {
		const provider = Plugin.make({
			id: "sibling-layer-provider",
			capabilities: [] as const,
			config: {},
			layer: Layer.succeed(ExternalService, { name: "sibling-output" }),
		})
		const dependent = Plugin.make({
			id: "sibling-layer-dependent",
			capabilities: [] as const,
			config: {},
			layer: Layer.effect(
				PluginService,
				Effect.map(ExternalService, ({ name }) => ({ name })),
			),
		})
		const ordered = Result.getOrThrow(Router.make({ plugins: [provider, dependent] as const }))
		const orderedRuntime = Router.runtime(ordered)
		const orderedLayer = Router.layer(ordered)
		expect<Effect.Services<typeof orderedRuntime>>().type.toBe<Scope.Scope>()
		expect<Layer.Services<typeof orderedLayer>>().type.toBe<never>()

		const reversed = Result.getOrThrow(Router.make({ plugins: [dependent, provider] as const }))
		const reversedRuntime = Router.runtime(reversed)
		const reversedLayer = Router.layer(reversed)
		expect<Effect.Services<typeof reversedRuntime>>().type.toBe<Scope.Scope | ExternalService>()
		expect<Layer.Services<typeof reversedLayer>>().type.toBe<ExternalService>()
	})

	it("propagates migration services and satisfies them through plugin Layers", () => {
		const migration = {
			namespace: "typed-migrations",
			schema: Schema.String,
			migrations: [{ id: 1, name: "external", run: Effect.asVoid(ExternalService) }] as const,
		} as const
		const external = Plugin.make({
			id: "external-migration",
			capabilities: [] as const,
			config: { persistence: [migration] as const },
		})
		const supplied = Plugin.make({
			...external,
			id: "supplied-migration",
			layer: Layer.succeed(ExternalService, { name: "provided" }),
		})
		const externalRouter = Result.getOrThrow(Router.make({ plugins: [external] as const }))
		const suppliedRouter = Result.getOrThrow(Router.make({ plugins: [supplied] as const }))
		const externalRuntime = Router.runtime(externalRouter)
		const externalLayer = Router.layer(externalRouter)
		const suppliedRuntime = Router.runtime(suppliedRouter)
		const suppliedLayer = Router.layer(suppliedRouter)

		expect<Layer.Services<typeof externalLayer>>().type.toBe<ExternalService>()
		expect<Router.Requirements<readonly [typeof external]>>().type.toBe<ExternalService>()
		expect<Router.Requirements<readonly [typeof supplied]>>().type.toBe<never>()
		expect<Effect.Services<typeof externalRuntime>>().type.toBe<Scope.Scope | ExternalService>()
		expect<Effect.Services<typeof suppliedRuntime>>().type.toBe<Scope.Scope>()
		expect<Layer.Services<typeof suppliedLayer>>().type.toBe<never>()
		expect<typeof externalRouter>().type.toBe<Router.Router<readonly [typeof external]>>()
		expect<typeof suppliedRouter>().type.toBe<Router.Router<readonly [typeof supplied]>>()
	})

	it("keeps direct HTTP handlers' external services visible", () => {
		const needsExternal = Plugin.make({
			id: "external-http",
			capabilities: [] as const,
			config: {
				http: [
					{
						id: "external-http",
						method: "GET",
						path: "/external",
						input: Schema.Struct({}),
						output: Schema.Struct({ value: Schema.String }),
						handler: () => Effect.map(ExternalService, ({ name }) => ({ value: name })),
					},
				] as const,
			},
		})
		const router = Result.getOrThrow(Router.make({ plugins: [needsExternal] as const }))
		const runtime = Router.runtime(router)
		const layer = Router.layer(router)

		expect<Effect.Services<typeof runtime>>().type.toBe<ExternalService | Scope.Scope>()
		expect<Layer.Services<typeof layer>>().type.toBe<ExternalService>()
	})

	it("keeps direct HTTP middleware's external services visible", () => {
		const middleware: HttpMiddleware<ExternalService> = {
			id: "external-http-middleware",
			wrap: (next) => (input, context) =>
				Effect.asVoid(ExternalService).pipe(Effect.andThen(next(input, context))),
		}
		const needsExternal = Plugin.make({
			id: "external-http-middleware",
			capabilities: [] as const,
			config: {
				http: [
					{
						id: "external-http-middleware",
						method: "POST",
						path: "/middleware",
						input: Schema.Struct({}),
						output: Schema.Struct({ ready: Schema.Boolean }),
						handler: () => Effect.succeed({ ready: true }),
						middleware: [middleware] as const,
					},
				] as const,
			},
		})
		const router = Result.getOrThrow(Router.make({ plugins: [needsExternal] as const }))
		const runtime = Router.runtime(router)
		const layer = Router.layer(router)

		expect<Effect.Services<typeof runtime>>().type.toBe<ExternalService | Scope.Scope>()
		expect<Layer.Services<typeof layer>>().type.toBe<ExternalService>()
	})
})
