import { Context, Effect, HashMap, HashSet, Layer, Option, Result, Schema } from "effect"
import { HttpApi } from "effect/http-api"
import * as Capability from "./Capability.js"
import type { Capability as CapabilityValue } from "./Capability.js"
import * as Deployment from "./Deployment.js"
import type { DeploymentConfig } from "./Deployment.js"
import * as Persistence from "./Persistence.js"
import * as Policies from "./Policies.js"
import type {
	Hook,
	HttpContribution,
	HttpContractContribution,
	HttpEndpointContribution,
	Middleware,
	ModelRouteConfig,
	NormalizedPluginContributions,
	PersistenceContribution,
	Pipeline,
	Projection,
	RoutingPolicy,
} from "./PluginContributions.js"
import {
	DuplicateHttpRoute,
	DuplicateId,
	InvalidDeclaration,
	InvalidPlugin,
	PluginStartFailed,
	SetupError,
	UnsupportedCombination,
	clonePlugin,
	contributionsOf,
	issuesOf,
	validate,
} from "./Plugin.js"
import type { AnyPlugin, PluginInitContext } from "./Plugin.js"
import * as ProviderContract from "./ProviderContract.js"
import type { ProviderContract as ProviderContractValue } from "./ProviderContract.js"

/** A complete immutable index built before any runtime Layer is acquired. */
export interface Snapshot {
	readonly plugins: readonly AnyPlugin[]
	readonly pluginIndex: HashMap.HashMap<string, AnyPlugin>
	readonly capabilities: readonly CapabilityValue[]
	readonly capabilityIndex: HashMap.HashMap<string, CapabilityValue>
	readonly providers: readonly ProviderContractValue<any, any>[]
	readonly providerIndex: HashMap.HashMap<string, ProviderContractValue<any, any>>
	readonly providerContracts: readonly ProviderContractValue<any, any>[]
	readonly providerContractIndex: HashMap.HashMap<string, ProviderContractValue<any, any>>
	readonly deployments: readonly DeploymentConfig[]
	readonly deploymentIndex: HashMap.HashMap<string, DeploymentConfig>
	readonly modelRoutes: readonly ModelRouteConfig[]
	readonly modelRouteIndex: HashMap.HashMap<string, ModelRouteConfig>
	readonly policies: readonly RoutingPolicy<any, any>[]
	readonly policyIndex: HashMap.HashMap<string, RoutingPolicy<any, any>>
	readonly pipelines: readonly Pipeline<any, any>[]
	readonly pipelineIndex: HashMap.HashMap<string, Pipeline<any, any>>
	readonly projections: readonly Projection[]
	readonly projectionIndex: HashMap.HashMap<string, Projection>
	readonly middleware: readonly Middleware<any, any>[]
	readonly middlewareIds: HashSet.HashSet<string>
	readonly hooks: readonly Hook<any, any, any>[]
	readonly hookIds: HashSet.HashSet<string>
	readonly persistence: readonly PersistenceContribution<any>[]
	readonly persistenceNamespaces: HashSet.HashSet<string>
	readonly http: readonly HttpContribution<any, any>[]
	readonly httpIndex: HashMap.HashMap<string, HttpContribution<any, any>>
	readonly httpPaths: HashSet.HashSet<string>
	readonly groupIds: HashSet.HashSet<string>
	readonly ids: HashSet.HashSet<string>
	readonly capabilityIds: HashSet.HashSet<string>
	readonly api: HttpApi.Top
}

/** Build-only provenance for recognizing intentional provider object reuse. */
interface Builder {
	readonly snapshot: Snapshot
	readonly providerSources: HashMap.HashMap<string, ProviderContractValue<any, any>>
}

export class Registry extends Context.Service<Registry, Snapshot>()("BetterRouterRegistry") {}

const emptyApi = (): HttpApi.Top => HttpApi.make("better-router") as unknown as HttpApi.Top

export const empty = (): Snapshot => {
	const capabilityIndex = HashMap.set(
		HashMap.empty<string, CapabilityValue>(),
		Capability.generation.id,
		Capability.generation,
	)
	const capabilityIds = HashSet.make(Capability.generation.id)
	const modelRouteIndex = HashMap.empty<string, ModelRouteConfig>()
	const providerIndex = HashMap.empty<string, ProviderContractValue<any, any>>()
	return {
		plugins: [],
		pluginIndex: HashMap.empty(),
		capabilities: [Capability.generation],
		capabilityIndex,
		providers: [],
		providerIndex,
		providerContracts: [],
		providerContractIndex: providerIndex,
		deployments: [],
		deploymentIndex: HashMap.empty(),
		modelRoutes: [],
		modelRouteIndex,
		policies: [],
		policyIndex: HashMap.empty(),
		pipelines: [],
		pipelineIndex: HashMap.empty(),
		projections: [],
		projectionIndex: HashMap.empty(),
		middleware: [],
		middlewareIds: HashSet.empty(),
		hooks: [],
		hookIds: HashSet.empty(),
		persistence: [],
		persistenceNamespaces: HashSet.empty(),
		http: [],
		httpIndex: HashMap.empty(),
		httpPaths: HashSet.empty(),
		groupIds: HashSet.empty(),
		ids: HashSet.empty(),
		capabilityIds,
		api: emptyApi(),
	}
}

const duplicate = (kind: Parameters<typeof DuplicateId.make>[0]["kind"], id: string): SetupError =>
	DuplicateId.make({ kind, id })

const declarationFailure = (
	kind: string,
	id: string,
	message: string,
	issues?: readonly { readonly path: readonly (string | number)[]; readonly message: string }[],
): SetupError =>
	InvalidDeclaration.make({
		kind,
		id,
		message,
		...(issues === undefined ? {} : { issues }),
	})

const pathKey = (method: string, path: string): string => `${method.toUpperCase()} ${path}`

const isContractContribution = (
	value: HttpContribution<any, any>,
): value is HttpContractContribution<any, any> =>
	Object.prototype.hasOwnProperty.call(value, "contract")

const isEndpointContribution = (
	value: HttpContribution<any, any>,
): value is HttpEndpointContribution<any, any, any> => !isContractContribution(value)

const httpEntries = (
	fragment: HttpApi.Top,
): readonly { readonly method: string; readonly path: string }[] =>
	Object.values(fragment.groups).flatMap((group) =>
		Object.values(group.endpoints).map((endpoint) => ({
			method: endpoint.method,
			path: endpoint.path,
		})),
	)

const fragmentOf = (
	value: HttpContractContribution<any, any>,
): Result.Result<HttpApi.Top, SetupError> =>
	value.contract.api === value.api
		? Result.succeed(emptyApi().addHttpApi(value.api as HttpApi.Top))
		: Result.fail(
				declarationFailure(
					"http_group",
					value.id,
					"HTTP contract api must be the same object as its contribution api",
				),
			)

const addHttpContribution = (
	snapshot: Snapshot,
	value: HttpContribution<any, any>,
): Result.Result<Snapshot, SetupError> =>
	HashMap.has(snapshot.httpIndex, value.id)
		? Result.fail(
				duplicate(isContractContribution(value) ? "http_group" : "http_route", value.id),
			)
		: isEndpointContribution(value)
			? (() => {
					const key = pathKey(value.method, value.path)
					return HashSet.has(snapshot.httpPaths, key)
						? Result.fail(
								DuplicateHttpRoute.make({
									method: value.method.toUpperCase(),
									path: value.path,
								}),
							)
						: Result.succeed({
								...snapshot,
								http: [...snapshot.http, value],
								httpIndex: HashMap.set(snapshot.httpIndex, value.id, value),
								httpPaths: HashSet.add(snapshot.httpPaths, key),
							})
				})()
			: fragmentOf(value as HttpContractContribution<any, any>).pipe(
					Result.flatMap((fragment) => {
						const groups = Object.values(fragment.groups).map(
							(group) => group.identifier,
						)
						const duplicateGroup = groups.find((group) =>
							HashSet.has(snapshot.groupIds, group),
						)
						if (duplicateGroup !== undefined)
							return Result.fail(duplicate("http_group", duplicateGroup))
						const entries = httpEntries(fragment)
						const duplicatePath = entries.find((entry) =>
							HashSet.has(snapshot.httpPaths, pathKey(entry.method, entry.path)),
						)
						if (duplicatePath !== undefined)
							return Result.fail(
								DuplicateHttpRoute.make({
									method: duplicatePath.method.toUpperCase(),
									path: duplicatePath.path,
								}),
							)
						const pathSet = entries.reduce(
							(current, entry) =>
								HashSet.add(current, pathKey(entry.method, entry.path)),
							HashSet.empty<string>(),
						)
						const duplicateWithin = entries.find((entry, index) =>
							entries
								.slice(0, index)
								.some(
									(previous) =>
										pathKey(previous.method, previous.path) ===
										pathKey(entry.method, entry.path),
								),
						)
						return duplicateWithin === undefined
							? Result.succeed({
									...snapshot,
									http: [...snapshot.http, value],
									httpIndex: HashMap.set(snapshot.httpIndex, value.id, value),
									groupIds: groups.reduce(
										(current, group) => HashSet.add(current, group),
										snapshot.groupIds,
									),
									httpPaths: HashSet.union(snapshot.httpPaths, pathSet),
									api: snapshot.api.addHttpApi(fragment),
								})
							: Result.fail(
									DuplicateHttpRoute.make({
										method: duplicateWithin.method.toUpperCase(),
										path: duplicateWithin.path,
									}),
								)
					}),
				)

const addCapabilities = (
	snapshot: Snapshot,
	values: readonly unknown[],
): Result.Result<Snapshot, SetupError> =>
	values.reduce<Result.Result<Snapshot, SetupError>>(
		(current, value) =>
			Result.flatMap(current, (state) =>
				Capability.decode(value).pipe(
					Result.mapError((error) =>
						InvalidPlugin.make({
							id: "unknown",
							message: error.message,
							...(error.issues === undefined ? {} : { issues: error.issues }),
						}),
					),
					Result.flatMap((capability) =>
						HashSet.has(state.capabilityIds, capability.id)
							? Result.fail(duplicate("capability", capability.id))
							: Result.succeed({
									...state,
									capabilities: [...state.capabilities, capability],
									capabilityIndex: HashMap.set(
										state.capabilityIndex,
										capability.id,
										capability,
									),
									capabilityIds: HashSet.add(state.capabilityIds, capability.id),
								}),
					),
				),
			),
		Result.succeed(snapshot),
	)

const addProviders = (
	builder: Builder,
	values: readonly ProviderContractValue<any, any>[],
	origins: readonly ProviderContractValue<any, any>[] = values,
): Result.Result<Builder, SetupError> =>
	values.reduce<Result.Result<Builder, SetupError>>(
		(current, value, index) =>
			Result.flatMap(current, (state) =>
				ProviderContract.decode(value).pipe(
					Result.mapError((error) =>
						declarationFailure(
							"provider",
							typeof value.id === "string" ? value.id : "unknown",
							error.message,
							issuesOf(error),
						),
					),
					Result.flatMap(() => {
						const existing = HashMap.get(state.snapshot.providerIndex, value.id)
						const origin = origins[index] ?? value
						const existingOrigin = HashMap.get(state.providerSources, value.id)
						return Option.match(existing, {
							onNone: () => {
								const provider = ProviderContract.make(value)
								const providerIndex = HashMap.set(
									state.snapshot.providerIndex,
									value.id,
									provider,
								)
								return Result.succeed({
									snapshot: {
										...state.snapshot,
										providers: [...state.snapshot.providers, provider],
										providerIndex,
										providerContracts: [
											...state.snapshot.providerContracts,
											provider,
										],
										providerContractIndex: providerIndex,
									},
									providerSources: HashMap.set(
										state.providerSources,
										value.id,
										origin,
									),
								})
							},
							onSome: () =>
								Option.isSome(existingOrigin) && existingOrigin.value === origin
									? Result.succeed(state)
									: Result.fail(duplicate("provider", value.id)),
						})
					}),
				),
			),
		Result.succeed(builder),
	)

const cloneDeployment = (value: DeploymentConfig): DeploymentConfig => ({
	...value,
	...(value.pricing === undefined ? {} : { pricing: { ...value.pricing } }),
	...(value.limits === undefined ? {} : { limits: { ...value.limits } }),
	...(value.tags === undefined ? {} : { tags: [...value.tags] }),
	...(value.parameters === undefined ? {} : { parameters: [...value.parameters] }),
	...(value.capabilities === undefined ? {} : { capabilities: [...value.capabilities] }),
})

/**
 * Replace one plugin's deployment declarations with the provider-decoded
 * values.  The first registration pass intentionally keeps provider
 * extensions opaque so that declaration order does not matter; after the
 * complete provider index exists, this projection removes unknown fields
 * (including credentials or runtime state accidentally supplied by a caller)
 * while retaining fields explicitly accepted by the provider schema.
 */
const normalizePluginDeployments = (
	plugin: AnyPlugin,
	deployments: HashMap.HashMap<string, DeploymentConfig>,
): AnyPlugin => {
	const config = plugin.config
	if (config.deployments === undefined) return plugin
	const normalized = config.deployments.map((deployment) => {
		const value = HashMap.get(deployments, deployment.id)
		return Option.isSome(value) ? cloneDeployment(value.value) : deployment
	})
	return {
		...plugin,
		config: { ...config, deployments: normalized },
	}
}

const normalizeSnapshotDeployments = (
	snapshot: Snapshot,
	values: readonly DeploymentConfig[],
): Snapshot => {
	const deployments = values.map(cloneDeployment)
	const deploymentIndex = deployments.reduce(
		(current, deployment) => HashMap.set(current, deployment.id, deployment),
		HashMap.empty<string, DeploymentConfig>(),
	)
	const normalizedPlugins = snapshot.plugins.map((plugin) =>
		normalizePluginDeployments(plugin, deploymentIndex),
	)
	const pluginIndex = normalizedPlugins.reduce(
		(current, plugin) => HashMap.set(current, plugin.id, plugin),
		HashMap.empty<string, AnyPlugin>(),
	)
	return {
		...snapshot,
		plugins: normalizedPlugins,
		pluginIndex,
		deployments,
		deploymentIndex,
	}
}

const addDeployments = (
	snapshot: Snapshot,
	values: readonly DeploymentConfig[],
): Result.Result<Snapshot, SetupError> =>
	values.reduce<Result.Result<Snapshot, SetupError>>(
		(current, value) =>
			Result.flatMap(current, (state) =>
				Deployment.decodeConfig(value).pipe(
					Result.mapError((error) =>
						declarationFailure(
							"deployment",
							typeof value.id === "string" ? value.id : "unknown",
							error.message,
							issuesOf(error),
						),
					),
					Result.flatMap((decoded) =>
						HashMap.has(state.deploymentIndex, decoded.id)
							? Result.fail(duplicate("deployment", decoded.id))
							: Result.succeed({
									...state,
									deployments: [...state.deployments, cloneDeployment(value)],
									deploymentIndex: HashMap.set(
										state.deploymentIndex,
										decoded.id,
										cloneDeployment(value),
									),
								}),
					),
				),
			),
		Result.succeed(snapshot),
	)

const cloneRoute = (value: ModelRouteConfig): ModelRouteConfig => ({
	...value,
	model: value.model,
	deployments: [...value.deployments],
	...(value.pipelines === undefined ? {} : { pipelines: [...value.pipelines] }),
	...(value.middleware === undefined ? {} : { middleware: [...value.middleware] }),
	...(value.fallback === undefined ? {} : { fallback: [...value.fallback] }),
	...(value.requiredTags === undefined ? {} : { requiredTags: [...value.requiredTags] }),
	...(value.requiredCapabilities === undefined
		? {}
		: { requiredCapabilities: [...value.requiredCapabilities] }),
	...(value.requiredParameters === undefined
		? {}
		: { requiredParameters: [...value.requiredParameters] }),
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
	...(value.budget === undefined ? {} : { budget: { ...value.budget } }),
	...(value.access === undefined
		? {}
		: { access: { ...value.access, allow: [...value.access.allow] } }),
})

const addModelRoutes = (
	snapshot: Snapshot,
	values: readonly ModelRouteConfig[],
): Result.Result<Snapshot, SetupError> =>
	values.reduce<Result.Result<Snapshot, SetupError>>(
		(current, value) =>
			Result.flatMap(current, (state) => {
				const route = cloneRoute(value)
				const duplicateModel = HashMap.has(state.modelRouteIndex, route.model)
				const duplicateRouteId =
					route.id === undefined
						? false
						: state.modelRoutes.some((entry) => entry.id === route.id)
				return duplicateModel || duplicateRouteId
					? Result.fail(duplicate("model", route.id ?? route.model))
					: Result.succeed({
							...state,
							modelRoutes: [...state.modelRoutes, route],
							modelRouteIndex: HashMap.set(state.modelRouteIndex, route.model, route),
						})
			}),
		Result.succeed(snapshot),
	)

const addPolicies = (
	snapshot: Snapshot,
	values: readonly RoutingPolicy<any, any>[],
): Result.Result<Snapshot, SetupError> =>
	values.reduce<Result.Result<Snapshot, SetupError>>(
		(current, value) =>
			Result.flatMap(current, (state) =>
				HashMap.has(state.policyIndex, value.id)
					? Result.fail(duplicate("policy", value.id))
					: Result.succeed({
							...state,
							policies: [...state.policies, value],
							policyIndex: HashMap.set(state.policyIndex, value.id, value),
						}),
			),
		Result.succeed(snapshot),
	)

const addPipelines = (
	snapshot: Snapshot,
	values: readonly Pipeline<any, any>[],
): Result.Result<Snapshot, SetupError> =>
	values.reduce<Result.Result<Snapshot, SetupError>>(
		(current, value) =>
			Result.flatMap(current, (state) =>
				HashMap.has(state.pipelineIndex, value.id)
					? Result.fail(duplicate("pipeline", value.id))
					: Result.succeed({
							...state,
							pipelines: [...state.pipelines, value],
							pipelineIndex: HashMap.set(state.pipelineIndex, value.id, value),
						}),
			),
		Result.succeed(snapshot),
	)

const addProjections = (
	snapshot: Snapshot,
	values: readonly Projection[],
): Result.Result<Snapshot, SetupError> =>
	values.reduce<Result.Result<Snapshot, SetupError>>(
		(current, value) =>
			Result.flatMap(current, (state) =>
				HashMap.has(state.projectionIndex, value.id)
					? Result.fail(duplicate("projection", value.id))
					: Result.succeed({
							...state,
							projections: [...state.projections, value],
							projectionIndex: HashMap.set(state.projectionIndex, value.id, value),
						}),
			),
		Result.succeed(snapshot),
	)

const addMiddleware = (
	snapshot: Snapshot,
	values: readonly Middleware<any, any>[],
): Result.Result<Snapshot, SetupError> =>
	values.reduce<Result.Result<Snapshot, SetupError>>(
		(current, value) =>
			Result.flatMap(current, (state) =>
				HashSet.has(state.middlewareIds, value.id)
					? Result.fail(duplicate("middleware", value.id))
					: Result.succeed({
							...state,
							middleware: [...state.middleware, value],
							middlewareIds: HashSet.add(state.middlewareIds, value.id),
						}),
			),
		Result.succeed(snapshot),
	)

const addHooks = (
	snapshot: Snapshot,
	values: readonly Hook<any, any, any>[],
): Result.Result<Snapshot, SetupError> =>
	values.reduce<Result.Result<Snapshot, SetupError>>(
		(current, value) =>
			Result.flatMap(current, (state) =>
				HashSet.has(state.hookIds, value.id)
					? Result.fail(duplicate("hook", value.id))
					: Result.succeed({
							...state,
							hooks: [...state.hooks, value],
							hookIds: HashSet.add(state.hookIds, value.id),
						}),
			),
		Result.succeed(snapshot),
	)

const addPersistence = (
	snapshot: Snapshot,
	values: readonly PersistenceContribution<any>[],
): Result.Result<Snapshot, SetupError> =>
	values.reduce<Result.Result<Snapshot, SetupError>>(
		(current, value) =>
			Result.flatMap(current, (state) =>
				Persistence.makeDeclaration(value).pipe(
					Result.mapError((error) =>
						declarationFailure(
							"persistence",
							value.namespace,
							error.message,
							error.issues,
						),
					),
					Result.flatMap((declaration) =>
						HashSet.has(state.persistenceNamespaces, declaration.namespace)
							? Result.fail(duplicate("persistence", declaration.namespace))
							: Result.succeed({
									...state,
									persistence: [...state.persistence, declaration],
									persistenceNamespaces: HashSet.add(
										state.persistenceNamespaces,
										declaration.namespace,
									),
								}),
					),
				),
			),
		Result.succeed(snapshot),
	)

const addHttp = (
	snapshot: Snapshot,
	values: readonly HttpContribution<any, any>[],
): Result.Result<Snapshot, SetupError> =>
	values.reduce<Result.Result<Snapshot, SetupError>>(
		(current, value) => Result.flatMap(current, (state) => addHttpContribution(state, value)),
		Result.succeed(snapshot),
	)

const addContributions = (
	builder: Builder,
	contributions: NormalizedPluginContributions,
	origins?: readonly ProviderContractValue<any, any>[],
): Result.Result<Builder, SetupError> =>
	Result.gen(function* () {
		const providers = yield* addProviders(builder, contributions.providers, origins)
		const deployments = yield* addDeployments(providers.snapshot, contributions.deployments)
		const routes = yield* addModelRoutes(deployments, contributions.modelRoutes)
		const policies = yield* addPolicies(routes, contributions.policies)
		const pipelines = yield* addPipelines(policies, contributions.pipelines)
		const projections = yield* addProjections(pipelines, contributions.projections)
		const middleware = yield* addMiddleware(projections, contributions.middleware)
		const hooks = yield* addHooks(middleware, contributions.hooks)
		const persistence = yield* addPersistence(hooks, contributions.persistence)
		const http = yield* addHttp(persistence, contributions.http)
		return { snapshot: http, providerSources: providers.providerSources }
	})

const appendUnique = (values: readonly string[], additions: readonly string[]): readonly string[] =>
	additions.reduce(
		(current, value) => (current.includes(value) ? current : [...current, value]),
		[...values],
	)

const routeDeployment = (
	snapshot: Snapshot,
	route: ModelRouteConfig,
	deploymentId: string,
): Result.Result<
	{ readonly deployment: DeploymentConfig; readonly provider: ProviderContractValue<any, any> },
	SetupError
> => {
	const deployment = HashMap.get(snapshot.deploymentIndex, deploymentId)
	if (Option.isNone(deployment))
		return Result.fail(
			declarationFailure("model", route.model, `Unknown deployment ${deploymentId}`),
		)
	const provider = HashMap.get(snapshot.providerIndex, deployment.value.provider)
	return Option.match(provider, {
		onNone: () =>
			Result.fail(
				declarationFailure(
					"deployment",
					deployment.value.id,
					`Unknown provider contract ${deployment.value.provider}`,
				),
			),
		onSome: (contract) => Result.succeed({ deployment: deployment.value, provider: contract }),
	})
}

const unsupportedRoute = (
	route: ModelRouteConfig,
	deployment: DeploymentConfig,
	message: string,
	issues?: readonly { readonly path: readonly (string | number)[]; readonly message: string }[],
): SetupError =>
	UnsupportedCombination.make({
		provider: deployment.provider,
		deployment: deployment.id,
		protocol: deployment.protocol,
		message: `Model route ${route.model}: ${message}`,
		...(issues === undefined ? {} : { issues }),
	})

const validateRouteCandidate = (
	snapshot: Snapshot,
	route: ModelRouteConfig,
	deploymentId: string,
): Result.Result<void, SetupError> =>
	routeDeployment(snapshot, route, deploymentId).pipe(
		Result.flatMap(({ deployment, provider }) => {
			const requiredCapabilities = route.requiredCapabilities ?? []
			const unknownCapability = requiredCapabilities.find(
				(capability) => !HashSet.has(snapshot.capabilityIds, capability),
			)
			if (unknownCapability !== undefined)
				return Result.fail(
					declarationFailure(
						"model",
						route.model,
						`Unknown capability ${unknownCapability}`,
					),
				)
			const demanded = {
				...deployment,
				parameters: appendUnique(
					deployment.parameters ?? [],
					route.requiredParameters ?? [],
				),
				capabilities: appendUnique(deployment.capabilities ?? [], requiredCapabilities),
				...(route.streaming === undefined ? {} : { streaming: route.streaming }),
			}
			return ProviderContract.validateDeployment(provider, demanded).pipe(
				Result.map(() => undefined),
				Result.mapError((error) =>
					unsupportedRoute(route, deployment, error.message, error.issues),
				),
			)
		}),
	)

const validateReferences = (snapshot: Snapshot): Result.Result<Snapshot, SetupError> => {
	const capabilityMatrixChecks = snapshot.capabilities.reduce<Result.Result<void, SetupError>>(
		(current, capability) =>
			Result.flatMap(current, () => {
				const endpoints = capability.endpoints ?? []
				const duplicateEndpoint = endpoints.find((endpoint, index) =>
					endpoints.slice(0, index).some((previous) => previous.id === endpoint.id),
				)
				if (duplicateEndpoint !== undefined)
					return Result.fail(
						declarationFailure(
							"capability",
							capability.id,
							`Capability endpoint ${duplicateEndpoint.id} is declared more than once`,
						),
					)
				return endpoints.reduce<Result.Result<void, SetupError>>(
					(endpointResult, endpoint) =>
						Result.flatMap(endpointResult, () => {
							const duplicateParameter = endpoint.parameters.find(
								(parameter, index) =>
									endpoint.parameters.slice(0, index).includes(parameter),
							)
							if (duplicateParameter !== undefined)
								return Result.fail(
									declarationFailure(
										"capability",
										capability.id,
										`Capability endpoint ${endpoint.id} declares parameter ${duplicateParameter} more than once`,
									),
								)
							const endpointCapabilities = endpoint.capabilities ?? []
							const duplicateEndpointCapability = endpointCapabilities.find(
								(value, index) =>
									endpointCapabilities.slice(0, index).includes(value),
							)
							if (duplicateEndpointCapability !== undefined)
								return Result.fail(
									declarationFailure(
										"capability",
										capability.id,
										`Capability endpoint ${endpoint.id} declares capability ${duplicateEndpointCapability} more than once`,
									),
								)
							const unknownEndpointCapability = endpointCapabilities.find(
								(value) => !HashMap.has(snapshot.capabilityIndex, value),
							)
							return unknownEndpointCapability === undefined
								? Result.succeed(void 0)
								: Result.fail(
										declarationFailure(
											"capability",
											capability.id,
											`Unknown endpoint capability ${unknownEndpointCapability}`,
										),
									)
						}),
					Result.succeed(void 0),
				)
			}),
		Result.succeed(void 0),
	)
	const capabilityChecks = snapshot.providers.reduce<Result.Result<void, SetupError>>(
		(current, provider, providerIndex) =>
			Result.flatMap(current, () => {
				const references = provider.capabilities ?? []
				const usedEndpoints = provider.endpoints.filter((endpoint) =>
					snapshot.deployments.some(
						(deployment) =>
							deployment.provider === provider.id &&
							(endpoint.id === "generation" || endpoint.id === deployment.protocol) &&
							(deployment.endpoint === undefined ||
								deployment.endpoint === endpoint.id),
					),
				)
				const usedCapabilities = usedEndpoints.flatMap((endpoint) =>
					endpoint.capabilities === undefined
						? references.map((reference) => reference.id)
						: endpoint.capabilities,
				)
				const duplicateReference = references.find((reference, index) =>
					references.slice(0, index).some((previous) => previous.id === reference.id),
				)
				if (duplicateReference !== undefined)
					return Result.fail(
						declarationFailure(
							"provider",
							provider.id,
							`Provider capability ${duplicateReference.id} is declared more than once`,
							[
								{
									path: ["config", "providers", providerIndex, "capabilities"],
									message: "Duplicate capability reference",
								},
							],
						),
					)
				const unknownReference = references.find(
					(reference) =>
						usedCapabilities.includes(reference.id) &&
						!HashMap.has(snapshot.capabilityIndex, reference.id),
				)
				if (unknownReference !== undefined)
					return Result.fail(
						declarationFailure(
							"provider",
							provider.id,
							`Unknown provider capability ${unknownReference.id}`,
						),
					)
				const wrongVersion = references.find((reference) => {
					const registered = HashMap.get(snapshot.capabilityIndex, reference.id)
					return (
						Option.isSome(registered) &&
						reference.version !== undefined &&
						registered.value.version !== reference.version
					)
				})
				if (wrongVersion !== undefined)
					return Result.fail(
						declarationFailure(
							"provider",
							provider.id,
							`Provider capability ${wrongVersion.id} has an incompatible version`,
						),
					)
				const duplicateEndpoint = provider.endpoints.find((endpoint, index) =>
					provider.endpoints
						.slice(0, index)
						.some((previous) => previous.id === endpoint.id),
				)
				if (duplicateEndpoint !== undefined)
					return Result.fail(
						declarationFailure(
							"provider",
							provider.id,
							`Provider endpoint ${duplicateEndpoint.id} is declared more than once`,
						),
					)
				return provider.endpoints.reduce<Result.Result<void, SetupError>>(
					(endpointResult, endpoint) =>
						Result.flatMap(endpointResult, () => {
							const endpointCapabilities =
								endpoint.capabilities ?? references.map((reference) => reference.id)
							const duplicateParameter = endpoint.parameters.find(
								(parameter, index) =>
									endpoint.parameters.slice(0, index).includes(parameter),
							)
							if (duplicateParameter !== undefined)
								return Result.fail(
									declarationFailure(
										"provider",
										provider.id,
										`Provider endpoint ${endpoint.id} declares parameter ${duplicateParameter} more than once`,
									),
								)
							const duplicateEndpointCapability = endpointCapabilities.find(
								(capability, index) =>
									endpointCapabilities.slice(0, index).includes(capability),
							)
							if (duplicateEndpointCapability !== undefined)
								return Result.fail(
									declarationFailure(
										"provider",
										provider.id,
										`Provider endpoint ${endpoint.id} declares capability ${duplicateEndpointCapability} more than once`,
									),
								)
							const endpointUsed = usedEndpoints.some(
								(value) => value.id === endpoint.id,
							)
							const missingEndpointReference = endpointUsed
								? endpointCapabilities.find(
										(capability) =>
											!references.some(
												(reference) => reference.id === capability,
											),
									)
								: undefined
							if (missingEndpointReference !== undefined)
								return Result.fail(
									declarationFailure(
										"provider",
										provider.id,
										`Endpoint capability ${missingEndpointReference} is not declared by the provider`,
									),
								)
							const missingEndpointCapability = endpointUsed
								? endpointCapabilities.find(
										(capability) =>
											!HashMap.has(snapshot.capabilityIndex, capability),
									)
								: undefined
							if (missingEndpointCapability !== undefined)
								return Result.fail(
									declarationFailure(
										"provider",
										provider.id,
										`Unknown endpoint capability ${missingEndpointCapability}`,
									),
								)
							const incompatible = endpointCapabilities.find((capability) => {
								const registered = HashMap.get(snapshot.capabilityIndex, capability)
								if (
									Option.isNone(registered) ||
									registered.value.endpoints === undefined
								)
									return false
								const declared = registered.value.endpoints.find(
									(candidate) => candidate.id === endpoint.id,
								)
								return (
									declared === undefined ||
									endpoint.parameters.some(
										(parameter) => !declared.parameters.includes(parameter),
									) ||
									(endpoint.streaming && !declared.streaming)
								)
							})
							return incompatible === undefined
								? Result.succeed(void 0)
								: Result.fail(
										declarationFailure(
											"provider",
											provider.id,
											`Endpoint ${endpoint.id} exceeds capability ${incompatible}`,
										),
									)
						}),
					Result.succeed(void 0),
				)
			}),
		Result.succeed(void 0),
	)
	const policyChecks = snapshot.policies.reduce<Result.Result<void, SetupError>>(
		(current, policy) =>
			Result.flatMap(current, () =>
				policy.rank === undefined && policy.strategy === undefined
					? Result.fail(
							declarationFailure(
								"policy",
								policy.id,
								"A routing policy requires rank or a strategy",
							),
						)
					: policy.strategy !== undefined &&
						  !Policies.builtIns.some((strategy) => strategy.id === policy.strategy)
						? Result.fail(
								declarationFailure(
									"policy",
									policy.id,
									`Unknown routing strategy ${policy.strategy}`,
								),
							)
						: Result.succeed(void 0),
			),
		Result.succeed(void 0),
	)
	const deploymentChecks = snapshot.deployments.reduce<
		Result.Result<readonly DeploymentConfig[], SetupError>
	>(
		(current, deployment, index) =>
			Result.flatMap(current, (decodedDeployments) =>
				Result.gen(function* () {
					const provider = yield* Option.match(
						HashMap.get(snapshot.providerIndex, deployment.provider),
						{
							onNone: () =>
								Result.fail(
									declarationFailure(
										"deployment",
										deployment.id,
										`Unknown provider contract ${deployment.provider}`,
									),
								),
							onSome: Result.succeed,
						},
					)
					const schema = (provider.deploymentSchema ??
						Deployment.DeploymentConfigSchema) as Schema.ConstraintDecoder<DeploymentConfig>
					const decoded = yield* Schema.decodeUnknownResult(schema)(deployment, {
						onExcessProperty: "error",
					}).pipe(
						Result.mapError((error) =>
							declarationFailure(
								"deployment",
								deployment.id,
								error.message,
								issuesOf(error).map((issue) => ({
									...issue,
									path: ["config", "deployments", index, ...issue.path],
								})),
							),
						),
					)
					if (provider.runtime === undefined)
						return yield* Result.fail(
							UnsupportedCombination.make({
								provider: deployment.provider,
								deployment: deployment.id,
								protocol: deployment.protocol,
								message: `Provider ${provider.id} has no Generation runtime`,
							}),
						)
					const unknownDemand = (deployment.capabilities ?? []).find(
						(capability) => !HashMap.has(snapshot.capabilityIndex, capability),
					)
					if (unknownDemand !== undefined)
						return yield* Result.fail(
							declarationFailure(
								"deployment",
								deployment.id,
								`Unknown deployment capability ${unknownDemand}`,
							),
						)
					yield* ProviderContract.validateDeployment(
						provider,
						decoded as DeploymentConfig,
					).pipe(
						Result.mapError((error) =>
							UnsupportedCombination.make({
								provider: deployment.provider,
								deployment: deployment.id,
								protocol: deployment.protocol,
								message: error.message,
								...(error.issues === undefined
									? {}
									: {
											issues: error.issues.map((issue) => ({
												...issue,
												path: [
													"config",
													"deployments",
													index,
													...issue.path,
												],
											})),
										}),
							}),
						),
					)
					return [...decodedDeployments, decoded as DeploymentConfig]
				}),
			),
		Result.succeed([]),
	)
	const routeChecks = (validatedSnapshot: Snapshot): Result.Result<void, SetupError> =>
		validatedSnapshot.modelRoutes.reduce<Result.Result<void, SetupError>>(
			(current, route) =>
				Result.flatMap(current, () => {
					if (
						route.strategy !== undefined &&
						!Policies.builtIns.some((strategy) => strategy.id === route.strategy)
					)
						return Result.fail(
							declarationFailure(
								"model",
								route.model,
								`Unknown routing strategy ${route.strategy}`,
							),
						)
					const candidates = [...route.deployments, ...(route.fallback ?? [])]
					const duplicateCandidate = candidates.find((value, index) =>
						candidates.slice(0, index).includes(value),
					)
					if (duplicateCandidate !== undefined)
						return Result.fail(
							declarationFailure(
								"model",
								route.model,
								"Model route contains a duplicate deployment",
							),
						)
					const policy =
						route.policy === undefined
							? Option.none()
							: HashMap.get(snapshot.policyIndex, route.policy)
					if (route.policy !== undefined && Option.isNone(policy))
						return Result.fail(
							declarationFailure(
								"model",
								route.model,
								`Unknown routing policy ${route.policy}`,
							),
						)
					const missingPipeline = (route.pipelines ?? []).find(
						(id) => !HashMap.has(snapshot.pipelineIndex, id),
					)
					if (missingPipeline !== undefined)
						return Result.fail(
							declarationFailure(
								"model",
								route.model,
								`Unknown routing pipeline ${missingPipeline}`,
							),
						)
					const missingMiddleware = (route.middleware ?? []).find(
						(id) => !HashSet.has(snapshot.middlewareIds, id),
					)
					if (missingMiddleware !== undefined)
						return Result.fail(
							declarationFailure(
								"model",
								route.model,
								`Unknown middleware ${missingMiddleware}`,
							),
						)
					return candidates.reduce<Result.Result<void, SetupError>>(
						(candidateResult, candidate) =>
							Result.flatMap(candidateResult, () =>
								validateRouteCandidate(validatedSnapshot, route, candidate),
							),
						Result.succeed(void 0),
					)
				}),
			Result.succeed(void 0),
		)
	const projectionChecks = snapshot.projections.reduce<Result.Result<void, SetupError>>(
		(current, projection) =>
			Result.flatMap(current, () =>
				HashSet.has(snapshot.capabilityIds, projection.capability)
					? Result.succeed(void 0)
					: Result.fail(
							declarationFailure(
								"projection",
								projection.id,
								`Unknown capability ${projection.capability}`,
							),
						),
			),
		Result.succeed(void 0),
	)
	return Result.gen(function* () {
		yield* capabilityMatrixChecks
		yield* capabilityChecks
		const decodedDeployments = yield* deploymentChecks
		const validatedSnapshot = normalizeSnapshotDeployments(snapshot, decodedDeployments)
		yield* policyChecks
		yield* routeChecks(validatedSnapshot)
		yield* projectionChecks
		return validatedSnapshot
	})
}

/** Register one plugin using only pure immutable reducers. */
const registerBuilder = (builder: Builder, plugin: AnyPlugin): Result.Result<Builder, SetupError> =>
	Result.gen(function* () {
		const snapshot = builder.snapshot
		const checked = yield* validate(plugin)
		if (HashSet.has(snapshot.ids, checked.id))
			return yield* Result.fail(duplicate("plugin", checked.id))
		const registered = clonePlugin(checked)
		const capabilities = yield* addCapabilities(snapshot, registered.capabilities)
		const declarations = yield* addContributions(
			{ snapshot: capabilities, providerSources: builder.providerSources },
			contributionsOf(registered),
			checked.config.providers,
		)
		const pluginIndex = HashMap.set(
			declarations.snapshot.pluginIndex,
			registered.id,
			registered,
		)
		return {
			snapshot: {
				...declarations.snapshot,
				plugins: [...declarations.snapshot.plugins, registered],
				pluginIndex,
				ids: HashSet.add(declarations.snapshot.ids, registered.id),
			},
			providerSources: declarations.providerSources,
		}
	})

export const register = (
	snapshot: Snapshot,
	plugin: AnyPlugin,
): Result.Result<Snapshot, SetupError> =>
	registerBuilder({ snapshot, providerSources: HashMap.empty() }, plugin).pipe(
		Result.map(({ snapshot: result }) => result),
	)

export const registerMany = (
	snapshot: Snapshot,
	plugins: readonly AnyPlugin[],
): Result.Result<Snapshot, SetupError> =>
	plugins
		.reduce<Result.Result<Builder, SetupError>>(
			(current, plugin) => Result.flatMap(current, (state) => registerBuilder(state, plugin)),
			Result.succeed({ snapshot, providerSources: HashMap.empty() }),
		)
		.pipe(Result.map(({ snapshot: result }) => result))
		.pipe(Result.flatMap(validateReferences))

export const fromPlugins = (plugins: readonly unknown[]): Result.Result<Snapshot, SetupError> =>
	Array.isArray(plugins)
		? registerMany(empty(), plugins as readonly AnyPlugin[])
		: Result.fail(
				InvalidPlugin.make({
					id: "unknown",
					message: "Plugins must be an array",
					issues: [{ path: [], message: "Expected an array" }],
				}),
			)

export const context = (snapshot: Snapshot): PluginInitContext => ({
	plugins: snapshot.plugins,
	capabilities: snapshot.capabilities,
	providerContracts: snapshot.providerContracts,
	providers: snapshot.providers,
	deployments: snapshot.deployments,
	modelRoutes: snapshot.modelRoutes,
	policies: snapshot.policies,
	pipelines: snapshot.pipelines,
	projections: snapshot.projections,
	middleware: snapshot.middleware,
	hooks: snapshot.hooks,
	persistence: snapshot.persistence,
	http: snapshot.http,
	api: snapshot.api,
})

export const layer = (snapshot: Snapshot): Layer.Layer<Registry> =>
	Layer.succeed(Registry, snapshot)

/** Initialize plugins in declaration order inside the caller's Scope. */
export const initialize = (
	snapshot: Snapshot,
): Effect.Effect<readonly unknown[], SetupError, import("effect").Scope.Scope> =>
	Effect.forEach(snapshot.plugins, (plugin) =>
		plugin.init === undefined
			? Effect.succeed<unknown>(undefined)
			: plugin
					.init(context(snapshot))
					.pipe(
						Effect.mapError((cause) =>
							PluginStartFailed.make({ plugin: plugin.id, cause }),
						),
					),
	) as Effect.Effect<readonly unknown[], SetupError, import("effect").Scope.Scope>

export const start = (
	snapshot: Snapshot,
): Effect.Effect<void, SetupError, import("effect").Scope.Scope> =>
	initialize(snapshot).pipe(Effect.asVoid)
