import { Effect, Layer, Result, Schema, SchemaIssue } from "effect"
import { HttpApi } from "effect/http-api"
import type { Scope } from "effect"
import type { Capability, Issue as CapabilityIssue } from "./Capability.js"
import * as CapabilityModule from "./Capability.js"
import type { DeploymentConfig } from "./Deployment.js"
import * as DeploymentModule from "./Deployment.js"
import type {
	Hook,
	HttpContribution,
	Middleware,
	ModelRouteConfig,
	NormalizedPluginContributions,
	PersistenceContribution,
	Pipeline,
	PluginConfig,
	Projection,
	RoutingPolicy,
} from "./PluginContributions.js"
import type { ProviderContract } from "./ProviderContract.js"
import * as ProviderContractModule from "./ProviderContract.js"
import type { Declaration } from "./Persistence.js"

export const DuplicateKind = Schema.Literals([
	"plugin",
	"capability",
	"provider",
	"deployment",
	"model",
	"pipeline",
	"projection",
	"policy",
	"middleware",
	"hook",
	"http_group",
	"http_route",
	"persistence",
] as const)

export class DuplicateId extends Schema.TaggedError<DuplicateId>()("RouterDuplicateId", {
	kind: DuplicateKind,
	id: Schema.String,
}) {}

export class DuplicateHttpRoute extends Schema.TaggedError<DuplicateHttpRoute>()(
	"RouterDuplicateHttpRoute",
	{
		method: Schema.String,
		path: Schema.String,
	},
) {}

export class InvalidPlugin extends Schema.TaggedError<InvalidPlugin>()("RouterInvalidPlugin", {
	id: Schema.String,
	message: Schema.String,
	issues: Schema.optional(
		Schema.Array(
			Schema.Struct({
				path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
				message: Schema.String,
			}),
		),
	),
}) {}

export class InvalidDeclaration extends Schema.TaggedError<InvalidDeclaration>()(
	"RouterInvalidDeclaration",
	{
		kind: Schema.String,
		id: Schema.String,
		message: Schema.String,
		issues: Schema.optional(
			Schema.Array(
				Schema.Struct({
					path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
					message: Schema.String,
				}),
			),
		),
	},
) {}

export class UnsupportedCombination extends Schema.TaggedError<UnsupportedCombination>()(
	"RouterUnsupportedCombination",
	{
		provider: Schema.String,
		deployment: Schema.String,
		protocol: Schema.String,
		message: Schema.String,
		issues: Schema.optional(
			Schema.Array(
				Schema.Struct({
					path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
					message: Schema.String,
				}),
			),
		),
	},
) {}

export class PluginStartFailed extends Schema.TaggedError<PluginStartFailed>()(
	"RouterPluginStartFailed",
	{
		plugin: Schema.String,
		cause: Schema.Defect({ excludeCause: true }),
	},
) {}

export const SetupError = Schema.Union([
	DuplicateId,
	DuplicateHttpRoute,
	InvalidPlugin,
	InvalidDeclaration,
	UnsupportedCombination,
	PluginStartFailed,
]).pipe(Schema.toTaggedUnion("_tag"))

export type SetupError = typeof SetupError.Type

/** The immutable declaration view made available to plugin initialization. */
export interface PluginInitContext {
	readonly plugins: readonly AnyPlugin[]
	readonly capabilities: readonly Capability[]
	readonly providerContracts: readonly ProviderContract<any, any>[]
	readonly providers: readonly ProviderContract<any, any>[]
	readonly deployments: readonly DeploymentConfig[]
	readonly modelRoutes: readonly ModelRouteConfig[]
	readonly policies: readonly RoutingPolicy<any, any>[]
	readonly pipelines: readonly Pipeline<any, any>[]
	readonly projections: readonly Projection[]
	readonly middleware: readonly Middleware<any, any>[]
	readonly hooks: readonly Hook<any, any, any>[]
	readonly persistence: readonly PersistenceContribution<any>[]
	readonly http: readonly HttpContribution<any, any>[]
	readonly api: HttpApi.Top
}

export type PluginContext = PluginInitContext
export type PluginRuntime = unknown

/**
 * A plugin separates static contributions (`config`) from runtime acquisition
 * (`layer`/`init`). Neither runtime field can append declarations.
 */
export interface RouterPlugin<
	Id extends string = string,
	Capabilities extends readonly Capability[] = readonly Capability[],
	Config extends PluginConfig<any> = PluginConfig,
	Requirements = never,
	Runtime = PluginRuntime,
> {
	readonly id: Id
	readonly capabilities: Capabilities
	readonly config: Config
	readonly layer?: Layer.Layer<Runtime, unknown, Requirements>
	readonly init?: (
		context: PluginInitContext,
	) => Effect.Effect<Runtime, unknown, Scope.Scope | Requirements>
}

export type Plugin<
	Id extends string = string,
	Capabilities extends readonly Capability[] = readonly Capability[],
	Config extends PluginConfig<any> = PluginConfig,
	Requirements = never,
	Runtime = PluginRuntime,
> = RouterPlugin<Id, Capabilities, Config, Requirements, Runtime>

/** Existential declaration view; make preserves each concrete Layer and init type. */
export interface AnyPlugin {
	readonly id: string
	readonly capabilities: readonly Capability[]
	readonly config: PluginConfig<any>
	readonly layer?: Layer.Any
	readonly init?: (context: PluginInitContext) => Effect.Effect<unknown, unknown, any>
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null

const pluginId = (value: unknown): string =>
	isRecord(value) && typeof value.id === "string" ? value.id : "unknown"

const issuePath = (path: readonly unknown[] | undefined): readonly (string | number)[] =>
	(path ?? []).map((segment) =>
		typeof segment === "number"
			? segment
			: typeof segment === "string"
				? segment
				: String(segment),
	)

export const issuesOf = (error: Schema.SchemaError): readonly CapabilityIssue[] =>
	SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => ({
		path: issuePath(issue.path),
		message: issue.message,
	}))

const functionSchema = Schema.declare(
	(value): value is (...arguments_: readonly unknown[]) => unknown => typeof value === "function",
)
const schemaSchema = Schema.declare((value): value is Schema.Constraint => Schema.isSchema(value))
const layerSchema = Schema.declare((value): value is Layer.Any => Layer.isLayer(value))
const effectSchema = Schema.declare((value): value is Effect.Effect<unknown, unknown, unknown> =>
	Effect.isEffect(value),
)
const apiSchema = Schema.declare((value): value is HttpApi.Top => HttpApi.isHttpApi(value))

const persistenceSchema = Schema.Struct({
	namespace: Schema.NonEmptyString,
	schema: schemaSchema,
	version: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	migrations: Schema.optional(
		Schema.Array(
			Schema.Struct({
				id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
				name: Schema.NonEmptyString,
				run: effectSchema,
			}),
		),
	),
})

const modelRouteSchema = Schema.Struct({
	id: Schema.optional(Schema.NonEmptyString),
	model: Schema.NonEmptyString,
	deployments: Schema.Array(Schema.NonEmptyString),
	policy: Schema.optional(Schema.NonEmptyString),
	strategy: Schema.optional(Schema.NonEmptyString),
	pipelines: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	middleware: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	fallback: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	retry: Schema.optional(
		Schema.Struct({
			maxAttempts: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
			retriesPerDeployment: Schema.optional(
				Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			),
			delayMillis: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
			cooldownMillis: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
			retryableKinds: Schema.optional(Schema.Array(Schema.NonEmptyString)),
		}),
	),
	requiredTags: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	requiredCapabilities: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	requiredParameters: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	streaming: Schema.optional(Schema.Boolean),
	budget: Schema.optional(
		Schema.Struct({
			key: Schema.optional(Schema.NonEmptyString),
			limit: Schema.Number.check(Schema.isGreaterThan(0)),
			reservation: Schema.optional(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))),
		}),
	),
	access: Schema.optional(
		Schema.Struct({
			metadataKey: Schema.NonEmptyString,
			allow: Schema.Array(Schema.NonEmptyString),
		}),
	),
})

const policySchema = Schema.Struct({
	id: Schema.NonEmptyString,
	strategy: Schema.optional(Schema.NonEmptyString),
	rank: Schema.optional(functionSchema),
})
const pipelineSchema = Schema.Struct({ id: Schema.NonEmptyString, run: functionSchema })
const middlewareSchema = Schema.Struct({ id: Schema.NonEmptyString, wrap: functionSchema })
const hookSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	beforeRequest: Schema.optional(functionSchema),
	beforeAttempt: Schema.optional(functionSchema),
	afterResponse: Schema.optional(functionSchema),
	afterSuccess: Schema.optional(functionSchema),
	afterFailure: Schema.optional(functionSchema),
	onError: Schema.optional(functionSchema),
	onCancel: Schema.optional(functionSchema),
	onStreamEvent: Schema.optional(functionSchema),
	onFinalize: Schema.optional(functionSchema),
})
const projectionSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	protocol: Schema.NonEmptyString,
	capability: Schema.NonEmptyString,
	decode: Schema.optional(functionSchema),
	encode: Schema.optional(functionSchema),
})
const httpEndpointSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	method: Schema.Literals([
		"GET",
		"HEAD",
		"POST",
		"PUT",
		"PATCH",
		"DELETE",
		"OPTIONS",
		"TRACE",
		"CONNECT",
	]),
	path: Schema.NonEmptyString.check(Schema.isPattern(/^\//)),
	input: schemaSchema,
	output: schemaSchema,
	handler: functionSchema,
	middleware: Schema.optional(
		Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, wrap: functionSchema })),
	),
})
const httpContractSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	api: apiSchema,
	contract: Schema.Struct({ api: apiSchema, layer: functionSchema }),
})
const httpSchema = Schema.Union([httpContractSchema, httpEndpointSchema])
/** Provider extension keys remain unknown until the Registry selects the
 * provider's complete, pure deployment Schema during final preflight. */
const deploymentDescriptorSchema = Schema.StructWithRest(DeploymentModule.DeploymentConfigSchema, [
	Schema.Record(Schema.String, Schema.Unknown),
])
const configSchema = Schema.Struct({
	providers: Schema.optional(Schema.Array(ProviderContractModule.ProviderContractSchema)),
	deploymentSchema: Schema.optional(schemaSchema),
	deployments: Schema.optional(Schema.Array(deploymentDescriptorSchema)),
	modelRoutes: Schema.optional(Schema.Array(modelRouteSchema)),
	policies: Schema.optional(Schema.Array(policySchema)),
	pipelines: Schema.optional(Schema.Array(pipelineSchema)),
	projections: Schema.optional(Schema.Array(projectionSchema)),
	middleware: Schema.optional(Schema.Array(middlewareSchema)),
	hooks: Schema.optional(Schema.Array(hookSchema)),
	http: Schema.optional(Schema.Array(httpSchema)),
	persistence: Schema.optional(Schema.Array(persistenceSchema)),
})
const pluginSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	capabilities: Schema.Array(CapabilityModule.SchemaDefinition),
	config: configSchema,
	layer: Schema.optional(layerSchema),
	init: Schema.optional(functionSchema),
})

const invalid = (
	value: unknown,
	message: string,
	issues?: readonly CapabilityIssue[],
): Result.Result<AnyPlugin, SetupError> =>
	Result.fail(
		InvalidPlugin.make({
			id: pluginId(value),
			message,
			...(issues === undefined ? {} : { issues }),
		}),
	)

const forbiddenConfigKeys = ["layers", "providersLayers", "apis", "route", "routes"] as const

const hasOwn = (value: Readonly<Record<string, unknown>>, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(value, key)

/** Validate a plugin descriptor without invoking any callback or acquiring a Layer. */
export const validate = (value: unknown): Result.Result<AnyPlugin, SetupError> => {
	if (!isRecord(value))
		return invalid(value, "Plugin must be an object", [
			{ path: [], message: "Expected an object" },
		])
	if (typeof value.id !== "string")
		return invalid(value, "Plugin id must be a string", [
			{ path: ["id"], message: "Expected a string" },
		])
	if (value.id.length === 0)
		return invalid(value, "Plugin id cannot be empty", [
			{ path: ["id"], message: "Expected a non-empty string" },
		])
	if (!Array.isArray(value.capabilities))
		return invalid(value, "Plugin capabilities must be an array", [
			{ path: ["capabilities"], message: "Expected an array" },
		])
	if (!isRecord(value.config))
		return invalid(value, "Plugin config must be an object", [
			{ path: ["config"], message: "Expected an object" },
		])
	if (hasOwn(value, "state"))
		return invalid(value, "Plugin state has been removed; use layer or init", [
			{ path: ["state"], message: "Unexpected property" },
		])
	if (hasOwn(value, "contributions"))
		return invalid(value, "Plugin contributions has been removed; use config", [
			{ path: ["contributions"], message: "Unexpected property" },
		])
	const forbidden = forbiddenConfigKeys.find((key) =>
		hasOwn(value.config as Readonly<Record<string, unknown>>, key),
	)
	if (forbidden !== undefined)
		return invalid(value, `Plugin config ${forbidden} is a removed runtime declaration`, [
			{ path: ["config", forbidden], message: "Unexpected property" },
		])
	return Schema.decodeUnknownResult(pluginSchema, { onExcessProperty: "error" })(value).pipe(
		Result.mapError((error) =>
			InvalidPlugin.make({
				id: value.id as string,
				message: error.message,
				issues: issuesOf(error),
			}),
		),
		Result.flatMap(() => {
			const config = value.config as Readonly<Record<string, unknown>>
			const declaredSchema = config.deploymentSchema
			const deployments = config.deployments
			if (!Schema.isSchema(declaredSchema) || !Array.isArray(deployments))
				return Result.succeed(value as unknown as AnyPlugin)
			const deploymentSchema = declaredSchema as unknown as Schema.ConstraintDecoder<unknown>
			return deployments.reduce<Result.Result<AnyPlugin, SetupError>>(
				(current, deployment, index) =>
					Result.flatMap(current, () =>
						Schema.decodeUnknownResult(deploymentSchema, { onExcessProperty: "error" })(
							deployment,
						).pipe(
							Result.map(() => value as unknown as AnyPlugin),
							Result.mapError((error) =>
								InvalidPlugin.make({
									id: value.id as string,
									message: error.message,
									issues: issuesOf(error).map((issue) => ({
										...issue,
										path: ["config", "deployments", index, ...issue.path],
									})),
								}),
							),
						),
					),
				Result.succeed(value as unknown as AnyPlugin),
			)
		}),
	)
}

/** Exact definition inference for object plugin factories. */
export const make = <const Definition extends AnyPlugin>(definition: Definition): Definition =>
	definition

export type PluginIds<Plugins> = Plugins extends readonly unknown[]
	? Plugins[number] extends { readonly id: infer Id extends string }
		? Id
		: never
	: Plugins extends { readonly id: infer Id extends string }
		? Id
		: never

export type PluginCapabilities<PluginValue> = PluginValue extends {
	readonly capabilities: infer Values
}
	? Values extends readonly Capability[]
		? Values[number]
		: never
	: never

export type PluginConfigOf<PluginValue> = PluginValue extends { readonly config: infer Value }
	? Value
	: never

export type PluginRequirements<PluginValue> = PluginValue extends {
	readonly layer?: infer Value
}
	? Value extends Layer.Any
		? Layer.Services<Value>
		: never
	: never

export type PluginLayerServices<Plugins> = Plugins extends readonly unknown[]
	? PluginRequirements<Plugins[number]>
	: PluginRequirements<Plugins>

export type PluginLayerOutputs<Plugins> = Plugins extends readonly unknown[]
	? Plugins[number] extends { readonly layer?: infer Value }
		? Value extends Layer.Any
			? Layer.Success<Value>
			: never
		: never
	: never

export type PluginLayerErrors<Plugins> = Plugins extends readonly unknown[]
	? Plugins[number] extends { readonly layer?: infer Value }
		? Value extends Layer.Any
			? Layer.Error<Value>
			: never
		: never
	: never

/** Normalize optional declaration arrays into immutable snapshots. */
export const contributionsOf = (plugin: AnyPlugin): NormalizedPluginContributions => {
	const config = plugin.config as PluginConfig<any>
	return {
		providers: config.providers === undefined ? [] : config.providers.map(cloneProvider),
		deployments:
			config.deployments === undefined ? [] : config.deployments.map(cloneDeployment),
		modelRoutes: config.modelRoutes === undefined ? [] : config.modelRoutes.map(cloneRoute),
		policies:
			config.policies === undefined ? [] : config.policies.map((value) => ({ ...value })),
		pipelines:
			config.pipelines === undefined ? [] : config.pipelines.map((value) => ({ ...value })),
		projections:
			config.projections === undefined
				? []
				: config.projections.map((value) => ({ ...value })),
		middleware:
			config.middleware === undefined ? [] : config.middleware.map((value) => ({ ...value })),
		hooks: config.hooks === undefined ? [] : config.hooks.map((value) => ({ ...value })),
		http: config.http === undefined ? [] : config.http.map(cloneHttp),
		persistence:
			config.persistence === undefined ? [] : config.persistence.map(clonePersistence),
	}
}

const cloneProvider = (value: ProviderContract<any, any>): ProviderContract<any, any> =>
	ProviderContractModule.make({
		id: value.id,
		endpoints: value.endpoints.map((endpoint) => ({
			...endpoint,
			parameters: [...endpoint.parameters],
			...(endpoint.capabilities === undefined
				? {}
				: { capabilities: [...endpoint.capabilities] }),
		})),
		...(value.capabilities === undefined
			? {}
			: {
					capabilities: value.capabilities.map((capability) =>
						"kind" in capability
							? CapabilityModule.make(capability)
							: { ...capability },
					),
				}),
		...(value.protocols === undefined ? {} : { protocols: [...value.protocols] }),
		...(value.deploymentSchema === undefined
			? {}
			: { deploymentSchema: value.deploymentSchema }),
		...(value.runtime === undefined ? {} : { runtime: value.runtime }),
		...(value.encode === undefined ? {} : { encode: value.encode }),
		...(value.decode === undefined ? {} : { decode: value.decode }),
		...(value.validateEnvironment === undefined
			? {}
			: { validateEnvironment: value.validateEnvironment }),
	})

/** Copy plain static extension data; opaque Schema/Layer/functions keep identity. */
const cloneStatic = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(cloneStatic)
		: typeof value === "object" &&
			  value !== null &&
			  (Object.getPrototypeOf(value) === Object.prototype ||
					Object.getPrototypeOf(value) === null)
			? Object.fromEntries(
					Object.entries(value).map(([key, entry]) => [key, cloneStatic(entry)] as const),
				)
			: value

const cloneDeployment = (value: DeploymentConfig): DeploymentConfig =>
	cloneStatic(value) as DeploymentConfig

const cloneRoute = (value: ModelRouteConfig): ModelRouteConfig => ({
	...value,
	deployments: [...value.deployments],
	...(value.pipelines === undefined ? {} : { pipelines: [...value.pipelines] }),
	...(value.middleware === undefined ? {} : { middleware: [...value.middleware] }),
	...(value.fallback === undefined ? {} : { fallback: [...value.fallback] }),
	...(value.retry === undefined
		? {}
		: {
				retry: {
					...value.retry,
					...(value.retry.retryableKinds === undefined
						? {}
						: { retryableKinds: [...value.retry.retryableKinds] }),
				},
			}),
	...(value.requiredTags === undefined ? {} : { requiredTags: [...value.requiredTags] }),
	...(value.requiredCapabilities === undefined
		? {}
		: { requiredCapabilities: [...value.requiredCapabilities] }),
	...(value.requiredParameters === undefined
		? {}
		: { requiredParameters: [...value.requiredParameters] }),
	...(value.budget === undefined ? {} : { budget: { ...value.budget } }),
	...(value.access === undefined
		? {}
		: { access: { ...value.access, allow: [...value.access.allow] } }),
})

const cloneHttp = (value: HttpContribution<any, any>): HttpContribution<any, any> =>
	"contract" in value
		? { ...value, contract: { ...value.contract } }
		: {
				...value,
				...(value.middleware === undefined
					? {}
					: { middleware: value.middleware.map((middleware) => ({ ...middleware })) }),
			}

const clonePersistence = <Requirements>(
	value: PersistenceContribution<Requirements>,
): PersistenceContribution<Requirements> => ({
	...value,
	...(value.migrations === undefined
		? {}
		: { migrations: value.migrations.map((migration) => ({ ...migration })) }),
})

/** Clone the static declaration view while retaining executable function/Layers. */
export const clonePlugin = (plugin: AnyPlugin): AnyPlugin => {
	const config = plugin.config as PluginConfig<any>
	const contributions = contributionsOf(plugin)
	const clonedConfig: PluginConfig<any> = {
		...(config.providers === undefined ? {} : { providers: contributions.providers }),
		...(config.deploymentSchema === undefined
			? {}
			: { deploymentSchema: config.deploymentSchema }),
		...(config.deployments === undefined ? {} : { deployments: contributions.deployments }),
		...(config.modelRoutes === undefined ? {} : { modelRoutes: contributions.modelRoutes }),
		...(config.policies === undefined ? {} : { policies: contributions.policies }),
		...(config.pipelines === undefined ? {} : { pipelines: contributions.pipelines }),
		...(config.projections === undefined ? {} : { projections: contributions.projections }),
		...(config.middleware === undefined ? {} : { middleware: contributions.middleware }),
		...(config.hooks === undefined ? {} : { hooks: contributions.hooks }),
		...(config.http === undefined ? {} : { http: contributions.http }),
		...(config.persistence === undefined ? {} : { persistence: contributions.persistence }),
	}
	return {
		id: plugin.id,
		capabilities: plugin.capabilities.map(CapabilityModule.make),
		config: clonedConfig,
		...(plugin.layer === undefined ? {} : { layer: plugin.layer }),
		...(plugin.init === undefined ? {} : { init: plugin.init }),
	}
}

export type PluginDeclaration = Declaration
