import type { Layer } from "effect"
import type { Contract } from "./Api.js"
import type { Route } from "./Route.js"

/** A Layer accepted by plugin state. Concrete packages narrow this at their API. */
export type AnyLayer = Layer.Layer<any, any, any>

export type RouteLayer = Layer.Layer<Route, any, any>

/**
 * Runtime configuration contributed by a plugin.
 *
 * This is intentionally separate from `Capability`: changing a key, endpoint
 * credential, provider model, or Layer must not change the capability identity.
 */
export interface State<
	RouteImplementation extends RouteLayer = RouteLayer,
	Providers extends readonly AnyLayer[] = readonly AnyLayer[],
	Apis extends readonly Contract<any, any>[] = readonly Contract<any, any>[],
> {
	readonly route?: RouteImplementation
	readonly providers?: Providers
	/** `layers` is the neutral name; `providers` remains for provider-oriented callers. */
	readonly layers?: Providers
	readonly apis?: Apis
}

export type StateOf<Plugin> = Plugin extends { readonly state?: infer Value }
	? Exclude<Value, undefined>
	: never

export type ProvidersOf<StateValue> = StateValue extends {
	readonly providers?: infer Values
}
	? Values extends readonly AnyLayer[]
		? Values
		: readonly []
	: StateValue extends { readonly layers?: infer Values }
		? Values extends readonly AnyLayer[]
			? Values
			: readonly []
		: readonly []

export type ApisOf<StateValue> = StateValue extends { readonly apis?: infer Values }
	? Values extends readonly Contract<any, any>[]
		? Values
		: readonly []
	: readonly []

export type RouteOf<StateValue> = StateValue extends {
	readonly route?: infer Value
}
	? Value extends RouteLayer
		? Value
		: never
	: never

export const empty = (): State<never, readonly [], readonly []> => ({})

export const make = <
	const RouteImplementation extends RouteLayer = RouteLayer,
	const Providers extends readonly AnyLayer[] = readonly [],
	const Apis extends readonly Contract<any, any>[] = readonly [],
>(
	state: State<RouteImplementation, Providers, Apis>,
): State<RouteImplementation, Providers, Apis> => state
