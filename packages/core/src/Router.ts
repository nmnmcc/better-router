import { Cause, Context, Effect, Exit, Layer, Option, Result, Schema, Scope } from "effect"
import type { FileSystem, Path } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import type { HttpApi } from "effect/http-api"
import * as HttpDeclarations from "./HttpApi.js"
import * as Persistence from "./Persistence.js"
import { PluginStartFailed, SetupError } from "./Plugin.js"
import type { AnyPlugin } from "./Plugin.js"
import type { HttpMiddleware, Middleware } from "./PluginContributions.js"
import { ProcessError } from "./GenerationProcess.js"
import { Error as ProviderError } from "./Provider.js"
import { Error as RouteError, Route } from "./Route.js"
import * as RouteRuntime from "./Route.js"
import * as RoutingRuntime from "./RoutingRuntime.js"
import type { Service as RouteService } from "./Route.js"
import * as Registry from "./Registry.js"

/** A resource graph failed to start after its declarations passed preflight. */
export class CompositionError extends Schema.TaggedError<CompositionError>()(
	"RouterCompositionError",
	{
		phase: Schema.Literals(["layers", "persistence", "deployments", "http"]),
		message: Schema.String,
		/** The plugin whose declaration caused a composition-phase failure. */
		plugin: Schema.optional(Schema.String),
		cause: Schema.optional(Schema.Defect({ excludeCause: true })),
	},
) {}

export const Error = Schema.Union([
	CompositionError,
	SetupError,
	RouteError,
	ProviderError,
	ProcessError,
]).pipe(Schema.toTaggedUnion("_tag"))

export type RouterError = typeof Error.Type
export type StartupError = SetupError | CompositionError

type AnyLayer = Layer.Layer<any, any, any>
type ConfigOf<P> = P extends { readonly config: infer C } ? C : never
type Items<C, K extends PropertyKey> = C extends { readonly [Key in K]?: infer A }
	? NonNullable<A> extends readonly (infer V)[]
		? V
		: NonNullable<A>
	: never
type EffectRequirements<E> = E extends Effect.Effect<any, any, infer R> ? R : never
type FunctionRequirements<F> = F extends (...args: any[]) => infer E ? EffectRequirements<E> : never
type LayerOf<P> = P extends { readonly layer?: infer L } ? NonNullable<L> : never
type KnownLayerOutput<Value> = 0 extends 1 & Value ? never : unknown extends Value ? never : Value
type LayerRequirements<P> =
	LayerOf<P> extends infer L ? (L extends AnyLayer ? Layer.Services<L> : never) : never
type LayerOutputs<P> =
	LayerOf<P> extends infer L
		? L extends AnyLayer
			? KnownLayerOutput<Layer.Success<L>>
			: never
		: never
type LayerGraphRequirements<
	Plugins extends readonly unknown[],
	Available = never,
> = Plugins extends readonly [infer Head, ...infer Tail]
	? | Exclude<LayerRequirements<Head>, Available | Scope.Scope | Persistence.Persistence>
		| LayerGraphRequirements<Tail, Available | LayerOutputs<Head>>
	: Exclude<LayerRequirements<Plugins[number]>, Scope.Scope | Persistence.Persistence>
type CallbackRequirements<C> = C extends unknown
	? { readonly [K in keyof C]-?: FunctionRequirements<C[K]> }[keyof C]
	: never
type ProviderRequirements<P> =
	Items<ConfigOf<P>, "providers"> extends infer C
		? C extends { readonly runtime?: infer F }
			? FunctionRequirements<NonNullable<F>>
			: never
		: never
type PolicyRequirements<P> = CallbackRequirements<Items<ConfigOf<P>, "policies">>
type PipelineRequirements<P> = CallbackRequirements<Items<ConfigOf<P>, "pipelines">>
type HookRequirements<P> = CallbackRequirements<Items<ConfigOf<P>, "hooks">>
type MiddlewareRequirements<P> =
	Items<ConfigOf<P>, "middleware"> extends infer M
		? M extends Middleware<any, infer R>
			? R
			: never
		: never
type HttpMiddlewareRequirements<M> = M extends HttpMiddleware<infer R> ? R : never
type MigrationRequirements<P> =
	Items<ConfigOf<P>, "persistence"> extends infer D
		? Items<D, "migrations"> extends infer M
			? M extends { readonly run: infer E }
				? EffectRequirements<E>
				: never
			: never
		: never
type InputRequirements<S> = S extends Schema.Constraint ? S["DecodingServices"] : never
type OutputRequirements<S> = S extends Schema.Constraint ? S["EncodingServices"] : never
type HttpRequirements<P> =
	Items<ConfigOf<P>, "http"> extends infer H
		? H extends { readonly contract: { readonly layer: (...args: any[]) => infer L } }
			? L extends AnyLayer
				? Layer.Services<L>
				: never
			: H extends {
						readonly handler: infer F
						readonly input: infer I
						readonly output: infer O
				  }
				? | FunctionRequirements<F>
					| InputRequirements<I>
					| OutputRequirements<O>
					| HttpMiddlewareRequirements<Items<H, "middleware">>
				: never
		: never
type InitRequirements<P> = P extends { readonly init?: infer F }
	? FunctionRequirements<NonNullable<F>>
	: never

/** Services which the host supplies when it binds the declared HTTP routes. */
export type HttpHostServices =
	| HttpRouter.HttpRouter
	| Etag.Generator
	| FileSystem.FileSystem
	| HttpPlatform.HttpPlatform
	| Path.Path

/** External dependencies remain visible instead of being widened to `any`. */
export type Requirements<Plugins extends readonly AnyPlugin[]> =
	| LayerGraphRequirements<Plugins>
	| Exclude<
			| ProviderRequirements<Plugins[number]>
			| PolicyRequirements<Plugins[number]>
			| PipelineRequirements<Plugins[number]>
			| MiddlewareRequirements<Plugins[number]>
			| HookRequirements<Plugins[number]>
			| MigrationRequirements<Plugins[number]>
			| InitRequirements<Plugins[number]>,
			LayerOutputs<Plugins[number]> | Scope.Scope | Persistence.Persistence
	  >
	| Exclude<
			HttpRequirements<Plugins[number]>,
			LayerOutputs<Plugins[number]> | Scope.Scope | HttpHostServices | Persistence.Persistence
	  >

type ApiOf<H> = H extends { readonly api: infer A }
	? A extends HttpApi.Constraint
		? A
		: never
	: never
type PluginApi<P> = ApiOf<Items<ConfigOf<P>, "http">>
type ComposedApi<Plugins extends readonly AnyPlugin[]> = HttpApi.HttpApi<
	"better-router",
	PluginApi<Plugins[number]> extends infer A
		? A extends HttpApi.HttpApi<any, infer G>
			? G
			: never
		: never
>

export interface Options<Plugins extends readonly AnyPlugin[] = readonly AnyPlugin[]> {
	readonly plugins: Plugins
}

/** Pure, immutable declarations. Creating this object never starts a resource. */
export interface Router<Plugins extends readonly AnyPlugin[] = readonly AnyPlugin[]> {
	readonly plugins: Plugins
	readonly registry: Registry.Snapshot
	readonly http: { readonly api: ComposedApi<Plugins> }
}

/** The generation gateway acquired by `runtime` or `layer` in its owner's Scope. */
export interface Service<Api extends HttpApi.Constraint = HttpApi.Constraint> {
	readonly route: RouteService
	readonly registry: Registry.Snapshot
	readonly plugins: readonly { readonly id: string; readonly runtime: unknown }[]
	readonly generate: RouteService["generate"]
	readonly http: {
		readonly api: Api
		readonly routes: Layer.Layer<never, unknown, HttpHostServices>
	}
}

export class RouterRuntime extends Context.Service<RouterRuntime, Service>()(
	"BetterRouterRouter",
) {}

/** Complete static preflight before credentials, Layers or init callbacks run. */
export const make = <const Plugins extends readonly AnyPlugin[]>(
	options: Options<Plugins>,
): Result.Result<Router<Plugins>, SetupError> =>
	Registry.fromPlugins(options?.plugins).pipe(
		Result.map((registry) => ({
			plugins: registry.plugins as unknown as Plugins,
			registry,
			http: { api: registry.api as unknown as ComposedApi<Plugins> },
		})),
	)

const failStartup = (
	plugin: string,
	cause: Cause.Cause<unknown>,
): Effect.Effect<never, SetupError> =>
	Cause.hasInterruptsOnly(cause)
		? Effect.failCause(cause as Cause.Cause<never>)
		: Effect.fail(PluginStartFailed.make({ plugin, cause }))

const pluginLayer = (plugin: AnyPlugin): AnyLayer =>
	plugin.layer === undefined
		? (Layer.empty as unknown as AnyLayer)
		: (plugin.layer as AnyLayer).pipe(
				Layer.catchCause((cause) => Layer.effectContext(failStartup(plugin.id, cause))),
			)

const buildPluginLayers = (
	plugins: readonly AnyPlugin[],
	context: Context.Context<any>,
): Effect.Effect<Context.Context<any>, SetupError, any> =>
	plugins.reduce<Effect.Effect<Context.Context<any>, SetupError, any>>(
		(current, plugin) =>
			current.pipe(
				Effect.flatMap((environment) =>
					Layer.build(pluginLayer(plugin)).pipe(
						Effect.provideContext(environment),
						Effect.map((provided) => Context.merge(environment, provided)),
					),
				),
			),
		Effect.succeed(context),
	)

const atPhase = <A, E, R>(
	phase: CompositionError["phase"],
	message: string,
	effect: Effect.Effect<A, E, R>,
	plugin?: string,
): Effect.Effect<A, CompositionError, R> =>
	effect.pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.failCause(cause as Cause.Cause<never>)
				: Effect.fail(
						CompositionError.make({
							phase,
							message,
							...(plugin === undefined ? {} : { plugin }),
							cause,
						}),
					),
		),
	)

/* Registry entries erase types; Requirements computes the concrete tuple first. */
const acquire = (router: Router): Effect.Effect<Service, StartupError, any> =>
	Effect.gen(function* () {
		const external = yield* Effect.context<any>()
		const persistenceContext = Option.isSome(
			Context.getOption(external, Persistence.Persistence),
		)
			? Context.empty()
			: yield* Layer.build(Persistence.layerMemory)
		const baseContext = Context.merge(external, persistenceContext)
		const environment = yield* buildPluginLayers(router.registry.plugins, baseContext)
		const persistence = Context.get(environment, Persistence.Persistence)
		yield* router.registry.plugins
			.reduce<Effect.Effect<void, CompositionError, any>>(
				(current, plugin) =>
					current.pipe(
						Effect.andThen(
							atPhase(
								"persistence",
								"Persistence initialization failed",
								persistence.initialize(plugin.config.persistence ?? []),
								plugin.id,
							),
						),
					),
				Effect.succeed(void 0),
			)
			.pipe(Effect.provideContext(environment))
		const health = yield* atPhase(
			"persistence",
			"Routing runtime initialization failed",
			Layer.build(RoutingRuntime.layer(router.registry.deployments)),
		).pipe(Effect.provideContext(environment))
		const withHealth = Context.merge(environment, health)
		const routing = yield* atPhase(
			"deployments",
			"Deployment runtime initialization failed",
			Layer.build(RouteRuntime.layer(router.registry)),
		).pipe(Effect.provideContext(withHealth))
		const runtimeContext = Context.merge(withHealth, routing)
		const runtimes = yield* Effect.forEach(router.registry.plugins, (plugin) =>
			(plugin.init === undefined
				? Effect.succeed<unknown>(undefined)
				: Effect.suspend(() => plugin.init!(Registry.context(router.registry))).pipe(
						Effect.catchCause((cause) => failStartup(plugin.id, cause)),
					)
			).pipe(
				Effect.provideContext(runtimeContext),
				Effect.map((runtime) => ({ id: plugin.id, runtime })),
			),
		)
		const route = Context.get(runtimeContext, Route)
		const routes = yield* atPhase(
			"http",
			"HTTP declarations failed to bind",
			Effect.sync(() =>
				HttpDeclarations.layer(router.registry.http, route).pipe(
					Layer.provide(Layer.succeedContext(runtimeContext)),
				),
			),
		) as Effect.Effect<Layer.Layer<never, unknown, HttpHostServices>, CompositionError>
		return {
			route,
			registry: router.registry,
			plugins: runtimes,
			generate: route.generate,
			http: { api: router.http.api, routes },
		} satisfies Service
	}) as Effect.Effect<Service, StartupError, any>

/** Startup failure closes its child Scope; success lives in the caller's Scope. */
export const runtime = <const Plugins extends readonly AnyPlugin[]>(
	router: Router<Plugins>,
): Effect.Effect<
	Service<ComposedApi<Plugins>>,
	StartupError,
	Scope.Scope | Requirements<Plugins>
> =>
	Effect.gen(function* () {
		const scope = yield* Scope.make()
		yield* Effect.addFinalizer((exit) => Scope.close(scope, exit))
		return yield* acquire(router).pipe(
			Effect.provideService(Scope.Scope, scope),
			Effect.onExit((exit) =>
				Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
			),
		)
	}) as Effect.Effect<
		Service<ComposedApi<Plugins>>,
		StartupError,
		Scope.Scope | Requirements<Plugins>
	>

/** Provide once for long-lived hosts and consume RouterRuntime as a service. */
export const layer = <const Plugins extends readonly AnyPlugin[]>(
	router: Router<Plugins>,
): Layer.Layer<RouterRuntime, StartupError, Requirements<Plugins>> =>
	Layer.effect(RouterRuntime, runtime(router))

export type ServicesOf<Value> = Value extends Router<infer Plugins> ? Requirements<Plugins> : never
