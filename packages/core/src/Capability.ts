import { Context, Effect, HashMap, Layer, Option, Result, Schema } from "effect"

export const Capability = Schema.Struct({
  id: Schema.NonEmptyString,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  projections: Schema.Array(Schema.NonEmptyString),
})

export type Capability = typeof Capability.Type

export class CapabilityError extends Schema.TaggedError<CapabilityError>()("CapabilityError", {
  id: Schema.String,
  message: Schema.String,
}) {}

/** Reject declarations before any plugin resources are acquired. */
export const parse = (value: unknown): Result.Result<Capability, CapabilityError> => Result.mapError(Schema.decodeUnknownResult(Capability)(value), (cause) => CapabilityError.make({ id: "unknown", message: cause.message }))

/** The core knows the semantic capability, never the protocols that project it. */
export const generation: Capability = { id: "generation", version: 1, projections: [] }

export interface Catalog {
  readonly get: (id: string) => Effect.Effect<Option.Option<Capability>>
  readonly has: (id: string) => Effect.Effect<boolean>
  readonly list: Effect.Effect<readonly Capability[]>
}

export class CapabilityCatalog extends Context.Service<CapabilityCatalog, Catalog>()("CapabilityCatalog") {}

export const makeCatalog = (capabilities: readonly Capability[]): Result.Result<Catalog, CapabilityError> =>
  Result.map(
    capabilities.reduce<Result.Result<HashMap.HashMap<string, Capability>, CapabilityError>>(
      (current, capability) =>
        Result.gen(function* () {
          const entries = yield* current
          return HashMap.has(entries, capability.id) ? yield* Result.fail(CapabilityError.make({ id: capability.id, message: "Capability is already registered" })) : HashMap.set(entries, capability.id, capability)
        }),
      Result.succeed(HashMap.empty()),
    ),
    (entries): Catalog => ({
      get: (id) => Effect.succeed(HashMap.get(entries, id)),
      has: (id) => Effect.succeed(HashMap.has(entries, id)),
      list: Effect.succeed(Array.from(HashMap.values(entries))),
    }),
  )

export const layer = (capabilities: readonly Capability[] = [generation]): Layer.Layer<CapabilityCatalog, CapabilityError> => Layer.effect(CapabilityCatalog, Effect.fromResult(makeCatalog(capabilities)))
