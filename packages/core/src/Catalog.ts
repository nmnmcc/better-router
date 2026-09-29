import { Context, Effect, HashMap, Layer, Option, Result } from "effect"
import { CapabilityError, generation } from "./Capability.js"
import type { Capability } from "./Capability.js"

export interface Catalog {
	readonly get: (id: string) => Effect.Effect<Option.Option<Capability>>
	readonly has: (id: string) => Effect.Effect<boolean>
	readonly list: Effect.Effect<readonly Capability[]>
}

export class CapabilityCatalog extends Context.Service<CapabilityCatalog, Catalog>()(
	"CapabilityCatalog",
) {}

export const make = (
	capabilities: readonly Capability[],
): Result.Result<Catalog, CapabilityError> =>
	Result.map(
		capabilities.reduce<Result.Result<HashMap.HashMap<string, Capability>, CapabilityError>>(
			(current, capability) =>
				Result.gen(function* () {
					const entries = yield* current
					return HashMap.has(entries, capability.id)
						? yield* Result.fail(
								CapabilityError.make({
									id: capability.id,
									message: "Capability is already registered",
								}),
							)
						: HashMap.set(entries, capability.id, capability)
				}),
			Result.succeed(HashMap.empty()),
		),
		(entries): Catalog => ({
			get: (id) => Effect.succeed(HashMap.get(entries, id)),
			has: (id) => Effect.succeed(HashMap.has(entries, id)),
			list: Effect.succeed(Array.from(HashMap.values(entries))),
		}),
	)

export const layer = (
	capabilities: readonly Capability[] = [generation],
): Layer.Layer<CapabilityCatalog, CapabilityError> =>
	Layer.effect(CapabilityCatalog, Effect.fromResult(make(capabilities)))
