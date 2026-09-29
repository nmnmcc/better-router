import {
	Context,
	Effect,
	HashMap,
	HashSet,
	Layer,
	Match,
	Option,
	Result,
	Schema,
	Sink,
	Stream,
} from "effect"
import type { Scope } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { ProviderError } from "./Deployment.js"
import type { InvocationOptions } from "./Deployment.js"
import type { HttpHostServices } from "./Http.js"
import { ProtocolRequest } from "./Pipeline.js"
import type { Handler } from "./Pipeline.js"
import { toGeneration } from "./Projection.js"
import type { Command } from "./Projection.js"
import * as Execution from "./Execution.js"
import type { Execution as ExecutionValue } from "./Execution.js"
import type { GenerationEvent, GenerationRequest } from "./Generation.js"
import { SetupError } from "./Plugin.js"
import type {
	PluginCapabilities,
	PluginCapabilityIds,
	PluginDeploymentIds,
	PluginDeploymentProtocols,
	PluginDeployments,
	PluginPipelines,
	PluginPolicyIds,
	PluginProjections,
	PluginProtocolIds,
	PluginRequirements,
	RouterPlugin,
} from "./Plugin.js"
import * as Registry from "./Registry.js"
import { RoutingError } from "./Routing.js"
import type { DuplicateRouteModels, ModelRoute } from "./Routing.js"
import { Request } from "./GenerationSchema.js"

class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
	message: Schema.String,
}) {}

class NoRoute extends Schema.TaggedError<NoRoute>()("NoRoute", {
	model: Schema.String,
}) {}

class NoAvailableDeployment extends Schema.TaggedError<NoAvailableDeployment>()(
	"NoAvailableDeployment",
	{
		model: Schema.String,
	},
) {}

class UnsupportedCapability extends Schema.TaggedError<UnsupportedCapability>()(
	"UnsupportedCapability",
	{
		model: Schema.String,
		capability: Schema.String,
	},
) {}

class RoutingFailed extends Schema.TaggedError<RoutingFailed>()("RoutingFailed", {
	cause: RoutingError,
}) {}

class ProviderFailed extends Schema.TaggedError<ProviderFailed>()("ProviderFailed", {
	deployment: Schema.String,
	cause: ProviderError,
}) {}

class MiddlewareFailed extends Schema.TaggedError<MiddlewareFailed>()("MiddlewareFailed", {
	id: Schema.String,
	cause: Schema.Defect({ excludeCause: true }),
}) {}

class InvalidResponse extends Schema.TaggedError<InvalidResponse>()("InvalidResponse", {
	message: Schema.String,
}) {}

export const RouterError = Schema.Union([
	InvalidRequest,
	NoRoute,
	NoAvailableDeployment,
	UnsupportedCapability,
	RoutingFailed,
	ProviderFailed,
	MiddlewareFailed,
	InvalidResponse,
]).pipe(Schema.toTaggedUnion("_tag"))

export type RouterError = typeof RouterError.Type

export interface Router<Api extends HttpApi.Constraint = HttpApi.Constraint> {
	/** Route a complete invocation; direct protocol pipelines and projections share this path. */
	readonly invoke: (
		command: Command,
		options?: InvocationOptions,
	) => Effect.Effect<ExecutionValue, RouterError>
	/** The composed HTTP surface and routes; hosts may serve them or make a fetch handler. */
	readonly http: {
		readonly api: Api
		readonly routes: Layer.Layer<never, never, HttpHostServices>
	}
}

/** Layer-provided router service for long-lived hosts and plugin handlers. */
export class RouterRuntime extends Context.Service<RouterRuntime, Router>()("RouterRuntime") {}

type Accepts<Actual extends string, Expected extends string> = string extends Actual
	? true
	: Actual extends Expected
		? true
		: false

type DeploymentProtocol<
	Plugins extends readonly RouterPlugin<string, unknown>[],
	Id extends string,
> = string extends Id
	? PluginDeploymentProtocols<Plugins>
	: PluginDeployments<Plugins> extends infer Deployment
		? Deployment extends {
				readonly id: infer DeploymentId extends string
				readonly protocol: infer Protocol extends string
			}
			? Id extends DeploymentId
				? Protocol
				: never
			: never
		: never

type InvalidPipeline<
	Pipeline,
	Plugins extends readonly RouterPlugin<string, unknown>[],
> = Pipeline extends {
	readonly deployment: infer Deployment extends string
	readonly source: infer Source extends string
	readonly target: infer Target extends string
}
	? Accepts<Deployment, PluginDeploymentIds<Plugins>> extends true
		? Accepts<Source, PluginProtocolIds<Plugins>> extends true
			? Accepts<Target, DeploymentProtocol<Plugins, Deployment>> extends true
				? never
				: Pipeline
			: Pipeline
		: Pipeline
	: never

type InvalidProjection<
	Projection,
	Plugins extends readonly RouterPlugin<string, unknown>[],
> = Projection extends { readonly capability: infer Capability extends string }
	? Accepts<Capability, PluginCapabilityIds<Plugins> | "generation"> extends true
		? never
		: Projection
	: never

type InvalidCapability<
	Capability,
	Plugins extends readonly RouterPlugin<string, unknown>[],
> = Capability extends { readonly projections: readonly (infer Projection extends string)[] }
	? Accepts<Projection, PluginProtocolIds<Plugins>> extends true
		? never
		: Capability
	: never

type InvalidPlugin<Plugin, Plugins extends readonly RouterPlugin<string, unknown>[]> =
	| InvalidPipeline<PluginPipelines<Plugin>, Plugins>
	| InvalidProjection<PluginProjections<Plugin>, Plugins>
	| InvalidCapability<PluginCapabilities<Plugin>, Plugins>

type PluginValidation<Plugins extends readonly RouterPlugin<string, unknown>[]> =
	InvalidPlugin<Plugins[number], Plugins> extends never ? unknown : never

/** Keep literal completions while allowing IDs supplied at runtime. */
type DynamicString = string & {}

type RouterRoute<Plugins extends readonly RouterPlugin<string, unknown>[]> = ModelRoute<
	PluginDeploymentIds<Plugins> | DynamicString,
	PluginPolicyIds<Plugins> | DynamicString
>

type InvalidRouteReference<Actual extends string, Declared extends string> = string extends Actual
	? never
	: Exclude<Actual, Declared>

type InvalidRouteDeployments<Actual extends readonly string[], Declared extends string> = {
	readonly [Index in keyof Actual]: Actual[Index] extends string
		? InvalidRouteReference<Actual[Index], Declared>
		: never
}[number]

type InvalidRoutePolicy<Route, Declared extends string> = Route extends {
	readonly policy: infer Policy extends string
}
	? InvalidRouteReference<Policy, Declared>
	: never

type InvalidRouteReferences<
	Route,
	Deployments extends string,
	Policies extends string,
> = Route extends { readonly deployments: infer Actual extends readonly string[] }
	? InvalidRouteDeployments<Actual, Deployments> | InvalidRoutePolicy<Route, Policies>
	: never

type RouteValidation<
	Routes extends readonly ModelRoute[],
	Deployments extends string,
	Policies extends string,
> =
	DuplicateRouteModels<Routes> extends never
		? [
				{
					[Key in keyof Routes]: InvalidRouteReferences<
						Routes[Key],
						Deployments,
						Policies
					>
				}[number],
			] extends [never]
			? unknown
			: never
		: never

export interface RouterPluginOptions<Plugins extends readonly RouterPlugin<string, unknown>[]> {
	readonly plugins: Plugins & PluginValidation<Plugins>
}

export interface RouterOptions<
	Plugins extends readonly RouterPlugin<string, unknown>[],
	Routes extends readonly RouterRoute<Plugins>[] = readonly ModelRoute<
		PluginDeploymentIds<Plugins>,
		PluginPolicyIds<Plugins>
	>[],
> {
	readonly routes: Routes &
		RouteValidation<Routes, PluginDeploymentIds<Plugins>, PluginPolicyIds<Plugins>>
}

type HttpGroups<Plugin> = Plugin extends {
	readonly http: { readonly api: HttpApi.HttpApi<string, infer Groups> }
}
	? Groups
	: never

export type ComposedHttpApi<Plugins extends readonly RouterPlugin<string, unknown>[]> =
	HttpApi.HttpApi<"better-router", HttpGroups<Plugins[number]>>

type ExternalPluginRequirements<Plugins extends readonly RouterPlugin<string, unknown>[]> = Exclude<
	PluginRequirements<Plugins[number]>,
	Registry.Registry
>

type RouterEffect<Plugins extends readonly RouterPlugin<string, unknown>[]> = Effect.Effect<
	Router<ComposedHttpApi<Plugins>>,
	SetupError,
	Scope.Scope | ExternalPluginRequirements<Plugins>
>

const makeConfigured = <
	const Plugins extends readonly RouterPlugin<string, unknown>[],
	const Routes extends readonly ModelRoute[],
>(
	plugins: Plugins,
	routes: Routes,
): RouterEffect<Plugins> => {
	const program = Effect.gen(function* () {
		const environment = yield* Effect.context<
			Scope.Scope | ExternalPluginRequirements<Plugins>
		>()
		const registeredPlugins = plugins.reduce<Result.Result<Registry.Snapshot, SetupError>>(
			(current, plugin) =>
				Result.flatMap(current, (state) => Registry.registerPlugin(state, plugin)),
			Result.succeed(Registry.empty()),
		)
		const registry = yield* Effect.fromResult(
			routes.reduce<Result.Result<Registry.Snapshot, SetupError>>(
				(current, route) =>
					Result.flatMap(current, (state) => Registry.addRoute(state, route)),
				registeredPlugins,
			),
		)
		yield* Effect.fromResult(Registry.validatePipelines(registry))
		const runtimeEnvironment = Context.add(environment, Registry.Registry, registry)

		const select = (
			request: GenerationRequest,
			invocation?: InvocationOptions,
		): Effect.Effect<Stream.Stream<GenerationEvent, RouterError>, RouterError, unknown> =>
			Effect.gen(function* () {
				const route = yield* Option.match(HashMap.get(registry.routes, request.model), {
					onNone: () =>
						Effect.fail(RouterError.cases.NoRoute.make({ model: request.model })),
					onSome: Effect.succeed,
				})
				if (request.previous_response_id && route.deployments.length !== 1) {
					return yield* Effect.fail(
						RouterError.cases.UnsupportedCapability.make({
							model: request.model,
							capability: "provider-owned continuation",
						}),
					)
				}
				const configured = yield* Effect.forEach(route.deployments, (id) =>
					Option.match(HashMap.get(registry.deployments, id), {
						onNone: () =>
							Effect.fail(
								RouterError.cases.NoAvailableDeployment.make({
									model: request.model,
								}),
							),
						onSome: Effect.succeed,
					}),
				)
				const required =
					invocation?.upstream?.mode === "require"
						? invocation.upstream.transport
						: undefined
				const eligible = configured.filter(
					(deployment) => !required || !!deployment.execute[required],
				)
				if (eligible.length === 0) {
					return yield* Effect.fail(
						required
							? RouterError.cases.UnsupportedCapability.make({
									model: request.model,
									capability: required,
								})
							: RouterError.cases.NoAvailableDeployment.make({
									model: request.model,
								}),
					)
				}
				const policy = route.policy
					? HashMap.get(registry.policies, route.policy)
					: Option.none()
				const ranked = Option.isSome(policy)
					? yield* policy.value
							.rank(request, eligible)
							.pipe(
								Effect.mapError((cause) =>
									RouterError.cases.RoutingFailed.make({ cause }),
								),
							)
					: eligible
				const eligibleIds = HashSet.fromIterable(
					eligible.map((deployment) => deployment.id),
				)
				if (
					HashSet.size(HashSet.fromIterable(ranked.map((entry) => entry.id))) !==
						ranked.length ||
					ranked.some((entry) => !HashSet.has(eligibleIds, entry.id))
				) {
					return yield* Effect.fail(
						RouterError.cases.RoutingFailed.make({
							cause: RoutingError.make({
								message: "Policy returned an unknown or duplicate deployment",
							}),
						}),
					)
				}
				if (ranked.length === 0)
					return yield* Effect.fail(
						RouterError.cases.NoAvailableDeployment.make({ model: request.model }),
					)

				const attempt = (
					index: number,
				): Effect.Effect<
					Stream.Stream<GenerationEvent, RouterError>,
					RouterError,
					unknown
				> =>
					Effect.gen(function* () {
						const selected = yield* Option.match(
							HashMap.get(registry.deployments, ranked[index].id),
							{
								onNone: () =>
									Effect.fail(
										RouterError.cases.NoAvailableDeployment.make({
											model: request.model,
										}),
									),
								onSome: Effect.succeed,
							},
						)
						const preferred = invocation?.upstream?.transport
						const transport =
							preferred && selected.execute[preferred]
								? preferred
								: selected.execute.http
									? "http"
									: "websocket"
						const execute = selected.execute[transport]!
						const upstreamRequest = { ...request, model: selected.model }
						const failure = (cause: ProviderError): RouterError =>
							RouterError.cases.ProviderFailed.make({
								deployment: selected.id,
								cause,
							})
						const next = (cause: ProviderError) =>
							cause.retryable && index + 1 < ranked.length
								? attempt(index + 1)
								: Effect.fail(failure(cause))
						return yield* execute(upstreamRequest).pipe(
							Effect.map(
								(events) =>
									Stream.unwrap(
										Stream.peel(
											Stream.rechunk(
												Stream.provideContext(events, runtimeEnvironment),
												1,
											),
											Sink.head<GenerationEvent>(),
										).pipe(
											Effect.map(([first, rest]) =>
												Option.match(first, {
													onNone: () => Stream.empty,
													onSome: (event) =>
														Stream.concat(
															Stream.succeed(event),
															Stream.mapError(rest, failure),
														),
												}),
											),
											Effect.catch(next),
										),
									) as Stream.Stream<GenerationEvent, RouterError>,
							),
							Effect.catch(next),
						)
					})
				return yield* attempt(0)
			})

		const selectNative = (
			request: ProtocolRequest,
		): Effect.Effect<Option.Option<ExecutionValue>, RouterError, unknown> =>
			Effect.gen(function* () {
				const route = yield* Option.match(HashMap.get(registry.routes, request.model), {
					onNone: () =>
						Effect.fail(RouterError.cases.NoRoute.make({ model: request.model })),
					onSome: Effect.succeed,
				})
				const configured = yield* Effect.forEach(route.deployments, (id) =>
					Option.match(HashMap.get(registry.deployments, id), {
						onNone: () =>
							Effect.fail(
								RouterError.cases.NoAvailableDeployment.make({
									model: request.model,
								}),
							),
						onSome: Effect.succeed,
					}),
				)
				const eligible = configured.filter((deployment) =>
					registry.pipelines.some(
						(pipeline) =>
							pipeline.deployment === deployment.id &&
							pipeline.source === request.protocol &&
							pipeline.target === deployment.protocol,
					),
				)
				if (eligible.length === 0) return Option.none<ExecutionValue>()
				const policy = route.policy
					? HashMap.get(registry.policies, route.policy)
					: Option.none()
				const ranked = Option.isSome(policy)
					? yield* policy.value
							.rank({ model: request.model }, eligible)
							.pipe(
								Effect.mapError((cause) =>
									RouterError.cases.RoutingFailed.make({ cause }),
								),
							)
					: eligible
				const eligibleIds = HashSet.fromIterable(
					eligible.map((deployment) => deployment.id),
				)
				if (
					HashSet.size(HashSet.fromIterable(ranked.map((entry) => entry.id))) !==
						ranked.length ||
					ranked.some((entry) => !HashSet.has(eligibleIds, entry.id))
				) {
					return yield* Effect.fail(
						RouterError.cases.RoutingFailed.make({
							cause: RoutingError.make({
								message: "Policy returned an unknown or duplicate deployment",
							}),
						}),
					)
				}
				if (ranked.length === 0) return Option.none<ExecutionValue>()
				const attempt = (
					index: number,
				): Effect.Effect<Option.Option<ExecutionValue>, RouterError, unknown> =>
					Effect.gen(function* () {
						const selected = yield* Option.match(
							HashMap.get(registry.deployments, ranked[index].id),
							{
								onNone: () =>
									Effect.fail(
										RouterError.cases.NoAvailableDeployment.make({
											model: request.model,
										}),
									),
								onSome: Effect.succeed,
							},
						)
						const pipeline = registry.pipelines.find(
							(entry) =>
								entry.deployment === selected.id &&
								entry.source === request.protocol &&
								entry.target === selected.protocol,
						)
						if (!pipeline) return Option.none<ExecutionValue>()
						const failure = (cause: ProviderError): RouterError =>
							RouterError.cases.ProviderFailed.make({
								deployment: selected.id,
								cause,
							})
						const next = (cause: ProviderError) =>
							cause.retryable && index + 1 < ranked.length
								? attempt(index + 1)
								: Effect.fail(failure(cause))
						return yield* pipeline
							.execute({ ...request, targetModel: selected.model })
							.pipe(
								Effect.flatMap((response) =>
									Execution.opaque(response).pipe(Effect.map(Option.some)),
								),
								Effect.catch(next),
							)
					})
				return yield* attempt(0)
			})

		const open = (request: GenerationRequest, invocation?: InvocationOptions) =>
			Schema.decodeUnknownEffect(Request)(request, { onExcessProperty: "error" }).pipe(
				Effect.mapError((error) =>
					RouterError.cases.InvalidRequest.make({ message: error.message }),
				),
				Effect.flatMap((parsed) =>
					parsed.model
						? select({ ...parsed, model: parsed.model }, invocation)
						: Effect.fail(
								RouterError.cases.InvalidRequest.make({
									message: "A model alias is required",
								}),
							),
				),
			)

		const asGeneration = (
			events: Stream.Stream<GenerationEvent, RouterError, unknown>,
		): Effect.Effect<ExecutionValue> =>
			Execution.generation(
				Stream.provideContext(events, runtimeEnvironment) as Stream.Stream<
					GenerationEvent,
					RouterError
				>,
			)
		const route: Handler<unknown> = (command, invocation) =>
			Match.value(command).pipe(
				Match.discriminatorsExhaustive("type")({
					generation: (value) =>
						open(value.request, invocation).pipe(Effect.flatMap(asGeneration)),
					protocol: (value) =>
						Schema.decodeUnknownEffect(ProtocolRequest)(value.request).pipe(
							Effect.mapError((error) =>
								RouterError.cases.InvalidRequest.make({ message: error.message }),
							),
							Effect.flatMap((request) =>
								selectNative(request).pipe(
									Effect.flatMap(
										Option.match({
											onNone: () =>
												Effect.fromResult(
													toGeneration(value, registry.projections),
												).pipe(
													Effect.mapError((error) =>
														error.reason === "unsupported"
															? RouterError.cases.UnsupportedCapability.make(
																	{
																		model: request.model,
																		capability:
																			request.protocol,
																	},
																)
															: RouterError.cases.InvalidRequest.make(
																	{
																		message: error.message,
																	},
																),
													),
													Effect.flatMap((projected) =>
														open(projected, invocation),
													),
													Effect.flatMap(asGeneration),
												),
											onSome: Effect.succeed,
										}),
									),
								),
							),
						),
				}),
			)
		const handler = registry.middleware.reduceRight<Handler<unknown>>(
			(next, middleware) => middleware.wrap(next),
			route,
		)
		const invoke: Router["invoke"] = (command, invocation) =>
			Effect.provideContext(
				handler(command, invocation),
				runtimeEnvironment,
			) as Effect.Effect<ExecutionValue, RouterError>

		const router: Router<ComposedHttpApi<Plugins>> = {
			invoke,
			http: {
				api: registry.api as unknown as ComposedHttpApi<Plugins>,
				get routes() {
					const contextLayer = Layer.succeedContext(runtimeEnvironment)
					return plugins.reduce<Layer.Layer<never, never, HttpHostServices>>(
						(current, plugin) =>
							plugin.http
								? (Layer.merge(
										current,
										Layer.provide(plugin.http.routes(router), contextLayer),
									) as Layer.Layer<never, never, HttpHostServices>)
								: current,
						Layer.empty,
					)
				},
			},
		}
		yield* Effect.forEach(plugins, (plugin) =>
			plugin.start
				? plugin.start(router).pipe(
						Effect.provideContext(runtimeEnvironment),
						Effect.mapError((cause) =>
							SetupError.cases.PluginStartFailed.make({ plugin: plugin.id, cause }),
						),
					)
				: Effect.void,
		)
		return router
	})
	// Plugin declarations are erased in the registry; their requirements were captured above.
	return program as RouterEffect<Plugins>
}

/** Fix plugin declarations before configuring routes for SDK calls and HTTP serving. */
export function make<const Plugins extends readonly RouterPlugin<string, unknown>[]>(
	options: RouterPluginOptions<Plugins>,
): <const Routes extends readonly RouterRoute<Plugins>[] = readonly RouterRoute<Plugins>[]>(
	options: RouterOptions<Plugins, Routes>,
) => RouterEffect<Plugins> {
	return <const Routes extends readonly RouterRoute<Plugins>[]>(
		routeOptions: RouterOptions<Plugins, Routes>,
	) => makeConfigured<Plugins, Routes>(options.plugins, routeOptions.routes)
}

export function layer<const Plugins extends readonly RouterPlugin<string, unknown>[]>(
	options: RouterPluginOptions<Plugins>,
): <const Routes extends readonly RouterRoute<Plugins>[] = readonly RouterRoute<Plugins>[]>(
	options: RouterOptions<Plugins, Routes>,
) => Layer.Layer<RouterRuntime, SetupError, Scope.Scope | ExternalPluginRequirements<Plugins>> {
	return <const Routes extends readonly RouterRoute<Plugins>[]>(
		routeOptions: RouterOptions<Plugins, Routes>,
	) =>
		Layer.effect(
			RouterRuntime,
			makeConfigured<Plugins, Routes>(options.plugins, routeOptions.routes),
		)
}
