import { Context, Effect, Layer, Schema } from "effect"
import type { Scope } from "effect"
import type { FileSystem, Path } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { HttpApi } from "effect/http-api"
import type { Contract } from "./Api.js"
import { SetupError } from "./Plugin.js"
import type { AnyPlugin, PluginApis, PluginProviders, PluginRoutes } from "./Plugin.js"
import * as Registry from "./Registry.js"
import type { GenerationRequest } from "./Generation.js"
import type { Process } from "./GenerationProcess.js"
import { ProcessError } from "./GenerationProcess.js"
import { Error as ProviderError } from "./Provider.js"
import { Error as RouteError, Route } from "./Route.js"
import type { RouteError as RouteErrorType, Service as RouteService } from "./Route.js"

/** Errors raised while assembling a router and its Layers. */
export class CompositionError extends Schema.TaggedError<CompositionError>()(
	"RouterCompositionError",
	{ message: Schema.String },
) {}

/** The errors visible at the router seam. Protocols add their own wire errors. */
export const Error = Schema.Union([
	CompositionError,
	SetupError,
	RouteError,
	ProviderError,
	ProcessError,
]).pipe(Schema.toTaggedUnion("_tag"))

export type RouterError = typeof Error.Type

type AnyLayer = Layer.Layer<any, any, any>
type RouteLayer = Layer.Layer<Route, any, any>

export interface Options<
	RouteImplementation extends RouteLayer | undefined = undefined,
	Providers extends readonly AnyLayer[] = readonly AnyLayer[],
	Apis extends readonly Contract<any, any>[] = readonly Contract<any, any>[],
	Plugins extends readonly AnyPlugin[] = readonly AnyPlugin[],
> {
	/** A route may be supplied directly or by exactly one plugin state value. */
	readonly route?: RouteImplementation
	readonly providers?: Providers
	readonly apis?: Apis
	readonly plugins?: Plugins
}

type MakeOptions<
	RouteImplementation extends RouteLayer | undefined,
	Providers extends readonly AnyLayer[],
	Apis extends readonly Contract<any, any>[],
	Plugins extends readonly AnyPlugin[],
> = {
	readonly route?: RouteImplementation
	readonly providers?: Providers
	readonly apis?: Apis
	readonly plugins?: Plugins
}

export interface Router<Api extends HttpApi.Constraint = HttpApi.Constraint> {
	readonly route: RouteService
	/** The immutable declaration state used to build this router. */
	readonly registry: Registry.Snapshot
	readonly generate: (
		request: GenerationRequest,
	) => Effect.Effect<Process<unknown, never>, RouteErrorType | typeof ProviderError.Type>
	readonly http: {
		readonly api: Api
		readonly routes: Layer.Layer<never, never, HttpHostServices>
	}
}

/** Platform services supplied by the host that serves protocol Layers. */
export type HttpHostServices =
	| HttpRouter.HttpRouter
	| Etag.Generator
	| FileSystem.FileSystem
	| HttpPlatform.HttpPlatform
	| Path.Path

/** Layer-provided router service for long-lived hosts and SDK consumers. */
export class RouterRuntime extends Context.Service<RouterRuntime, Router>()("BetterRouterRouter") {}

type LayerUnion<Layers extends readonly AnyLayer[]> = Layers[number] extends infer Value
	? Value extends AnyLayer
		? Value
		: never
	: never

type LayerServices<Layers extends readonly AnyLayer[]> =
	LayerUnion<Layers> extends infer Value
		? Value extends AnyLayer
			? Layer.Services<Value>
			: never
		: never

type LayerOutputs<Layers extends readonly AnyLayer[]> =
	LayerUnion<Layers> extends infer Value
		? Value extends AnyLayer
			? Layer.Success<Value>
			: never
		: never

type LayerErrors<Layers extends readonly AnyLayer[]> =
	LayerUnion<Layers> extends infer Value
		? Value extends AnyLayer
			? Layer.Error<Value>
			: never
		: never

type CompositionRequirements<
	RouteImplementation extends RouteLayer | undefined,
	Providers extends readonly AnyLayer[],
	Plugins extends readonly AnyPlugin[],
> =
	| LayerServices<Providers>
	| PluginLayerServices<Plugins>
	| Exclude<
			RouteLayerServices<RouteImplementation> | PluginRouteServices<Plugins>,
			LayerOutputs<Providers> | PluginLayerOutputs<Plugins> | PluginRouteOutputs<Plugins>
	  >

type CompositionErrors<
	RouteImplementation extends RouteLayer | undefined,
	Providers extends readonly AnyLayer[],
	Plugins extends readonly AnyPlugin[],
> =
	| SetupError
	| RouteLayerError<RouteImplementation>
	| LayerErrors<Providers>
	| PluginLayerErrors<Plugins>
	| PluginRouteErrors<Plugins>

type ContractApi<Definition> = Definition extends Contract<infer Api, any> ? Api : never

type PluginLayerServices<Plugins extends readonly AnyPlugin[]> =
	PluginProviders<Plugins> extends infer Value
		? Value extends AnyLayer
			? Layer.Services<Value>
			: never
		: never

type PluginRouteServices<Plugins extends readonly AnyPlugin[]> =
	PluginRoutes<Plugins> extends infer Value
		? Value extends RouteLayer
			? Layer.Services<Value>
			: never
		: never

type PluginRouteOutputs<Plugins extends readonly AnyPlugin[]> =
	PluginRoutes<Plugins> extends infer Value
		? Value extends RouteLayer
			? Layer.Success<Value>
			: never
		: never

type PluginRouteErrors<Plugins extends readonly AnyPlugin[]> =
	PluginRoutes<Plugins> extends infer Value
		? Value extends RouteLayer
			? Layer.Error<Value>
			: never
		: never

type RouteLayerServices<RouteImplementation> = RouteImplementation extends RouteLayer
	? Layer.Services<RouteImplementation>
	: never

type RouteLayerError<RouteImplementation> = RouteImplementation extends RouteLayer
	? Layer.Error<RouteImplementation>
	: never

type PluginLayerOutputs<Plugins extends readonly AnyPlugin[]> =
	PluginProviders<Plugins> extends infer Value
		? Value extends AnyLayer
			? Layer.Success<Value>
			: never
		: never

type PluginLayerErrors<Plugins extends readonly AnyPlugin[]> =
	PluginProviders<Plugins> extends infer Value
		? Value extends AnyLayer
			? Layer.Error<Value>
			: never
		: never

type PluginContractApi<Plugins extends readonly AnyPlugin[]> =
	PluginApis<Plugins> extends infer Value
		? Value extends Contract<infer Api, any>
			? Api
			: never
		: never

type ComposedApi<
	Apis extends readonly Contract<any, any>[],
	Plugins extends readonly AnyPlugin[],
> = HttpApi.HttpApi<
	"better-router",
	| (ContractApi<Apis[number]> extends HttpApi.HttpApi<any, infer Groups> ? Groups : never)
	| (PluginContractApi<Plugins> extends HttpApi.HttpApi<any, infer Groups> ? Groups : never)
>

const combineProviders = (providers: readonly AnyLayer[]): AnyLayer =>
	providers.reduce<AnyLayer>(
		(current, provider) => Layer.merge(current, provider),
		Layer.empty as unknown as AnyLayer,
	)

const combineApis = (apis: readonly Contract[]): HttpApi.Constraint =>
	apis.reduce<HttpApi.Top>(
		(current, contract) => current.addHttpApi(contract.api as HttpApi.Top),
		HttpApi.make("better-router") as unknown as HttpApi.Top,
	) as HttpApi.Constraint

const composeRoute = (route: RouteLayer, providers: readonly AnyLayer[]): AnyLayer => {
	const combined = combineProviders(providers)
	return providers.length > 0 ? (Layer.provide(route, combined) as AnyLayer) : route
}

const noRoute = (): CompositionError =>
	CompositionError.make({ message: "Router requires a route Layer or a route plugin state" })

type ComposeOptions = {
	readonly route?: RouteLayer | undefined
	readonly providers?: readonly AnyLayer[] | undefined
	readonly apis?: readonly Contract<any, any>[] | undefined
	readonly plugins?: readonly AnyPlugin[] | undefined
}

const compose = (options: ComposeOptions): Effect.Effect<Router, unknown, Scope.Scope> =>
	Effect.gen(function* () {
		const plugins = yield* Effect.fromResult(Registry.fromPlugins(options.plugins ?? []))
		const registry = yield* Effect.fromResult(
			Registry.extend(plugins, {
				route: options.route,
				providers: options.providers,
				apis: options.apis,
			}),
		)
		const routeLayer = registry.route
		if (routeLayer === undefined) return yield* Effect.fail(noRoute())
		yield* Registry.start(registry)
		const routeContext = yield* Layer.build(composeRoute(routeLayer, registry.providers))
		const route = Context.get(routeContext, Route)
		const apis = registry.apis
		const routes = apis.reduce<AnyLayer>(
			(current, contract) => Layer.merge(current, contract.layer(route) as AnyLayer),
			Layer.empty as unknown as AnyLayer,
		) as unknown as Layer.Layer<never, never, HttpHostServices>
		return {
			route,
			registry,
			generate: route.generate,
			http: { api: combineApis(apis), routes },
		} satisfies Router
	})

/** Build a router inside the caller's Scope. */
export const make = <
	const RouteImplementation extends RouteLayer | undefined = undefined,
	const Providers extends readonly AnyLayer[] = readonly [],
	const Apis extends readonly Contract<any, any>[] = readonly [],
	const Plugins extends readonly AnyPlugin[] = readonly [],
>(
	options: MakeOptions<RouteImplementation, Providers, Apis, Plugins>,
): Effect.Effect<
	Router<ComposedApi<Apis, Plugins>>,
	CompositionErrors<RouteImplementation, Providers, Plugins>,
	Scope.Scope | CompositionRequirements<RouteImplementation, Providers, Plugins>
> =>
	compose(options) as Effect.Effect<
		Router<ComposedApi<Apis, Plugins>>,
		CompositionErrors<RouteImplementation, Providers, Plugins>,
		Scope.Scope | CompositionRequirements<RouteImplementation, Providers, Plugins>
	>

/** Expose the same composition as a Context service. */
export const layer = <
	const RouteImplementation extends RouteLayer | undefined = undefined,
	const Providers extends readonly AnyLayer[] = readonly [],
	const Apis extends readonly Contract<any, any>[] = readonly [],
	const Plugins extends readonly AnyPlugin[] = readonly [],
>(
	options: MakeOptions<RouteImplementation, Providers, Apis, Plugins>,
): Layer.Layer<
	RouterRuntime,
	CompositionErrors<RouteImplementation, Providers, Plugins>,
	CompositionRequirements<RouteImplementation, Providers, Plugins>
> =>
	Layer.effect(RouterRuntime, compose(options)) as Layer.Layer<
		RouterRuntime,
		CompositionErrors<RouteImplementation, Providers, Plugins>,
		CompositionRequirements<RouteImplementation, Providers, Plugins>
	>

export { RouteError, ProviderError, ProcessError }
