import { Context, Effect, Layer, Schema } from "effect"
import type { Scope } from "effect"
import type { FileSystem, Path } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { HttpApi } from "effect/http-api"
import type { Contract } from "./Api.js"
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
export const Error = Schema.Union([CompositionError, RouteError, ProviderError, ProcessError]).pipe(
	Schema.toTaggedUnion("_tag"),
)

export type RouterError = typeof Error.Type

type AnyLayer = Layer.Layer<any, any, any>
type RouteLayer = Layer.Layer<Route, any, any>

export interface Options<
	RouteImplementation extends RouteLayer = RouteLayer,
	Providers extends readonly AnyLayer[] = readonly AnyLayer[],
	Apis extends readonly Contract<any, any>[] = readonly Contract<any, any>[],
> {
	readonly route: RouteImplementation
	readonly providers?: Providers
	readonly apis?: Apis
}

type MakeOptions<
	RouteImplementation extends RouteLayer,
	Providers extends readonly AnyLayer[],
	Apis extends readonly Contract<any, any>[],
> = {
	readonly route: RouteImplementation
	readonly providers?: Providers
	readonly apis?: Apis
}

export interface Router<Api extends HttpApi.Constraint = HttpApi.Constraint> {
	readonly route: RouteService
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
	RouteImplementation extends RouteLayer,
	Providers extends readonly AnyLayer[],
> = LayerServices<Providers> | Exclude<Layer.Services<RouteImplementation>, LayerOutputs<Providers>>

type CompositionErrors<
	RouteImplementation extends RouteLayer,
	Providers extends readonly AnyLayer[],
> = Layer.Error<RouteImplementation> | LayerErrors<Providers>

type ContractApi<Definition> = Definition extends Contract<infer Api, any> ? Api : never

type ComposedApi<Apis extends readonly Contract<any, any>[]> = HttpApi.HttpApi<
	"better-router",
	ContractApi<Apis[number]> extends HttpApi.HttpApi<any, infer Groups> ? Groups : never
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

const composeRoute = (options: Options): AnyLayer => {
	const providers = combineProviders(options.providers ?? [])
	return options.providers && options.providers.length > 0
		? (Layer.provide(options.route, providers) as AnyLayer)
		: options.route
}

const compose = (options: Options): Effect.Effect<Router, unknown, Scope.Scope> =>
	Layer.build(composeRoute(options)).pipe(
		Effect.map((context) => {
			const route = Context.get(context, Route)
			const apis = options.apis ?? []
			const routes = apis.reduce<AnyLayer>(
				(current, contract) => Layer.merge(current, contract.layer(route) as AnyLayer),
				Layer.empty as unknown as AnyLayer,
			) as unknown as Layer.Layer<never, never, HttpHostServices>
			return {
				route,
				generate: route.generate,
				http: { api: combineApis(apis), routes },
			} satisfies Router
		}),
	)

/** Build a router inside the caller's Scope. */
export const make = <
	const RouteImplementation extends RouteLayer,
	const Providers extends readonly AnyLayer[] = readonly [],
	const Apis extends readonly Contract<any, any>[] = readonly [],
>(
	options: MakeOptions<RouteImplementation, Providers, Apis>,
): Effect.Effect<
	Router<ComposedApi<Apis>>,
	CompositionErrors<RouteImplementation, Providers>,
	Scope.Scope | CompositionRequirements<RouteImplementation, Providers>
> =>
	compose(options) as Effect.Effect<
		Router<ComposedApi<Apis>>,
		CompositionErrors<RouteImplementation, Providers>,
		Scope.Scope | CompositionRequirements<RouteImplementation, Providers>
	>

/** Expose the same composition as a Context service. */
export const layer = <
	const RouteImplementation extends RouteLayer,
	const Providers extends readonly AnyLayer[] = readonly [],
	const Apis extends readonly Contract<any, any>[] = readonly [],
>(
	options: MakeOptions<RouteImplementation, Providers, Apis>,
): Layer.Layer<
	RouterRuntime,
	CompositionErrors<RouteImplementation, Providers>,
	CompositionRequirements<RouteImplementation, Providers>
> =>
	Layer.effect(RouterRuntime, compose(options)) as Layer.Layer<
		RouterRuntime,
		CompositionErrors<RouteImplementation, Providers>,
		CompositionRequirements<RouteImplementation, Providers>
	>

export { RouteError, ProviderError, ProcessError }
