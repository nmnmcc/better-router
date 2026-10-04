import { Effect, Result, Schema } from "effect"
import type { Scope } from "effect"
import { decode as decodeCapability } from "./Capability.js"
import type { Capability } from "./Capability.js"
import type { Contract } from "./Api.js"
import type { AnyLayer, RouteLayer, State } from "./State.js"

/** Errors found while assembling plugin declarations before resource acquisition. */
export class DuplicateId extends Schema.TaggedError<DuplicateId>()("RouterDuplicateId", {
	kind: Schema.Literals(["plugin", "capability", "http_group"]),
	id: Schema.String,
}) {}

export class DuplicateHttpRoute extends Schema.TaggedError<DuplicateHttpRoute>()(
	"RouterDuplicateHttpRoute",
	{
		method: Schema.String,
		path: Schema.String,
	},
) {}

export class MultipleRoutes extends Schema.TaggedError<MultipleRoutes>()("RouterMultipleRoutes", {
	first: Schema.String,
	second: Schema.String,
}) {}

export class InvalidPlugin extends Schema.TaggedError<InvalidPlugin>()("RouterInvalidPlugin", {
	id: Schema.String,
	message: Schema.String,
}) {}

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
	MultipleRoutes,
	InvalidPlugin,
	PluginStartFailed,
]).pipe(Schema.toTaggedUnion("_tag"))

export type SetupError = typeof SetupError.Type

/** The immutable declaration snapshot passed to plugin startup hooks. */
export interface PluginContext {
	readonly plugins: readonly RouterPlugin[]
	readonly capabilities: readonly Capability[]
	readonly providers: readonly AnyLayer[]
	readonly apis: readonly Contract[]
	readonly route: RouteLayer | undefined
}

/**
 * A Better Auth-style object plugin.
 *
 * The object is a complete declaration and is passed to `Router.make` in an
 * explicit tuple. Capabilities describe what the plugin can do; `state` holds
 * the concrete Layers, credentials and endpoint configuration used to do it.
 */
export interface RouterPlugin<
	Id extends string = string,
	Capabilities extends readonly Capability[] = readonly Capability[],
	PluginState extends State = State,
> {
	readonly id: Id
	readonly capabilities?: Capabilities
	readonly state?: PluginState
	/** Optional resource hook. It cannot add declarations after construction. */
	readonly init?: (context: PluginContext) => Effect.Effect<void, unknown, Scope.Scope>
}

export type AnyPlugin = RouterPlugin<string, readonly Capability[], State>

/** Static helper for plugin factories (`myPlugin(options)`). */
export const make = <
	const Id extends string,
	const Capabilities extends readonly Capability[] = readonly [],
	const PluginState extends State = State,
>(
	definition: RouterPlugin<Id, Capabilities, PluginState>,
): RouterPlugin<Id, Capabilities, PluginState> => definition

export type PluginIds<Plugins> = Plugins extends readonly unknown[]
	? Plugins[number] extends { readonly id: infer Id extends string }
		? Id
		: never
	: Plugins extends { readonly id: infer Id extends string }
		? Id
		: never

export type PluginCapabilities<Plugin> = Plugin extends {
	readonly capabilities?: infer Values
}
	? Values extends readonly Capability[]
		? Values[number]
		: never
	: never

export type PluginStates<Plugins> = Plugins extends readonly unknown[]
	? Plugins[number] extends infer Value
		? Value extends { readonly state?: infer StateValue }
			? Exclude<StateValue, undefined>
			: never
		: never
	: never

export type PluginProviders<Plugins> =
	PluginStates<Plugins> extends infer Value
		? Value extends { readonly providers?: infer Providers }
			? Providers extends readonly AnyLayer[]
				? Providers[number]
				: never
			: Value extends { readonly layers?: infer Layers }
				? Layers extends readonly AnyLayer[]
					? Layers[number]
					: never
				: never
		: never

export type PluginApis<Plugins> =
	PluginStates<Plugins> extends infer Value
		? Value extends { readonly apis?: infer Apis }
			? Apis extends readonly Contract<any, any>[]
				? Apis[number]
				: never
			: never
		: never

export type PluginRoutes<Plugins> =
	PluginStates<Plugins> extends infer Value
		? Value extends { readonly route?: infer Route }
			? Route extends RouteLayer
				? Route
				: never
			: never
		: never

/** A pure value-level check used by registry construction and tests. */
export const validate = (plugin: AnyPlugin): Result.Result<AnyPlugin, SetupError> =>
	plugin.id.length === 0
		? Result.fail(InvalidPlugin.make({ id: plugin.id, message: "Plugin id cannot be empty" }))
		: (plugin.capabilities ?? [])
				.reduce<Result.Result<void, SetupError>>(
					(current, capability) =>
						Result.flatMap(current, () =>
							decodeCapability(capability).pipe(
								Result.mapError((error) =>
									InvalidPlugin.make({ id: plugin.id, message: error.message }),
								),
								Result.map(() => undefined),
							),
						),
					Result.succeed(undefined),
				)
				.pipe(Result.map(() => plugin))
