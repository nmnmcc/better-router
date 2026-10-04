import { Context, Effect, Layer, Schema, Stream } from "effect"
import * as Capability from "./Capability.js"
import * as RouterPlugin from "./Plugin.js"
import type { GenerationRequest } from "./Generation.js"
import type { Process } from "./GenerationProcess.js"
import { Request as GenerationRequestSchema } from "./GenerationSchema.js"
import { Error as ProviderError } from "./Provider.js"

export type Request<Model extends string = string> = Omit<GenerationRequest, "model"> & {
	readonly model: Model
}

export class UnknownModel extends Schema.TaggedError<UnknownModel>()("RouteUnknownModel", {
	model: Schema.String,
}) {}

export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("RouteInvalidRequest", {
	message: Schema.String,
}) {}

export class HandlerFailed extends Schema.TaggedError<HandlerFailed>()("RouteHandlerFailed", {
	model: Schema.String,
	cause: Schema.Defect({ excludeCause: true }),
}) {}

export const Error = Schema.Union([UnknownModel, InvalidRequest, HandlerFailed]).pipe(
	Schema.toTaggedUnion("_tag"),
)

export type RouteError = typeof Error.Type
export const RouteError = Error

export type Handler<Model extends string = string, Requirements = unknown> = (
	request: Request<Model>,
) => Effect.Effect<Process<unknown, Requirements>, unknown, Requirements>

/** A handler map keeps each handler's environment so `layer` can expose it. */
export type HandlerMap = Readonly<
	Record<string, (request: Request) => Effect.Effect<Process<unknown, unknown>, unknown, any>>
>

export interface Service {
	readonly generate: (
		request: GenerationRequest,
	) => Effect.Effect<Process<unknown, never>, RouteError | ProviderError>
}

export class Route extends Context.Service<Route, Service>()("BetterRouterRoute") {}

type HandlerValue<Handlers> = Handlers[keyof Handlers & string]

type AnyHandler = (...args: any[]) => Effect.Effect<Process<unknown, any>, unknown, any>

type KeyedHandlers<Handlers> = {
	readonly [Model in keyof Handlers]: Handler<Extract<Model, string>, any>
}

type HandlerRequirementsOf<Value> = Value extends (
	...args: never[]
) => Effect.Effect<unknown, unknown, infer R>
	? R
	: never

type HandlerResultOf<Value> = Value extends (
	...args: never[]
) => Effect.Effect<infer A, unknown, unknown>
	? A
	: never

type HandlerRequirements<Handlers> = HandlerRequirementsOf<HandlerValue<Handlers>>

type HandlerResult<Handlers> = HandlerResultOf<HandlerValue<Handlers>>

const decodeRequest = (request: unknown): Effect.Effect<GenerationRequest, InvalidRequest> =>
	Schema.decodeUnknownEffect(GenerationRequestSchema)(request, {
		onExcessProperty: "error",
	}).pipe(Effect.mapError((error) => InvalidRequest.make({ message: error.message })))

/**
 * Build the only routing service. Object keys are public model aliases; the
 * handler owns provider choice, failover, retries and stopping conditions.
 */
export const layer = <const Handlers extends Readonly<Record<string, AnyHandler>>>(
	handlers: Handlers & KeyedHandlers<Handlers>,
): Layer.Layer<Route, never, HandlerRequirements<Handlers>> =>
	Layer.effect(
		Route,
		Effect.gen(function* () {
			const environment = yield* Effect.context<HandlerRequirements<Handlers>>()
			const provideProcess = (
				process: Process<unknown, HandlerRequirements<Handlers>>,
			): Process => ({
				events: Stream.provideContext(process.events, environment),
				response: Effect.provideContext(process.response, environment),
				terminal: Effect.provideContext(process.terminal, environment),
				cancel: process.cancel,
			})
			return {
				generate: (request) =>
					decodeRequest(request).pipe(
						Effect.flatMap((parsed) => {
							const entries = handlers as unknown as HandlerMap
							const handler = Object.prototype.hasOwnProperty.call(
								entries,
								parsed.model,
							)
								? entries[parsed.model]
								: undefined
							return handler
								? ((
										handler(parsed as never) as unknown as Effect.Effect<
											HandlerResult<Handlers>,
											unknown,
											HandlerRequirements<Handlers>
										>
									).pipe(
										Effect.provideContext(environment),
										Effect.map(provideProcess),
										Effect.mapError((cause) =>
											Schema.is(ProviderError)(cause)
												? cause
												: HandlerFailed.make({
														model: parsed.model,
														cause,
													}),
										),
									) as unknown as Effect.Effect<
										Process<unknown, never>,
										RouteError | ProviderError
									>)
								: Effect.fail(UnknownModel.make({ model: parsed.model }))
						}),
					),
			} satisfies Service
		}),
	) as Layer.Layer<Route, never, HandlerRequirements<Handlers>>

/** Stable routing capability; handler maps are supplied as plugin state. */
export const capability = Capability.make({
	id: "routing.models",
	version: 1,
	kind: "routing",
	projections: ["generation"],
} as const)

/** Turn a route declaration into a Better Auth-style object plugin. */
export const plugin = <const Handlers extends Readonly<Record<string, AnyHandler>>>(
	handlers: Handlers & KeyedHandlers<Handlers>,
): RouterPlugin.RouterPlugin<
	"model-routes",
	readonly [typeof capability],
	{ readonly route: Layer.Layer<Route, never, HandlerRequirements<Handlers>> }
> =>
	RouterPlugin.make({
		id: "model-routes",
		capabilities: [capability] as const,
		state: { route: layer<Handlers>(handlers) },
	})

export const makePlugin = plugin

/** Access the route service inside another Effect program. */
export const generate = (
	request: GenerationRequest,
): Effect.Effect<Process<unknown, never>, RouteError | ProviderError, Route> =>
	Effect.flatMap(Route, (service) => service.generate(request))
