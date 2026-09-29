import { Context, Effect, HashMap, Layer, Option, Result } from "effect"
import { ProjectionError } from "./Projection.js"
import type { Definition, Session } from "./Projection.js"

export interface RuntimeService {
	readonly open: (
		id: string,
		request: unknown,
	) => Effect.Effect<Session<unknown, unknown, unknown, unknown>, ProjectionError>
	readonly list: Effect.Effect<readonly string[]>
}

/** Dynamic lookup is only at the plugin composition seam; sessions stay typed inside each plugin. */
export class ProjectionRuntime extends Context.Service<ProjectionRuntime, RuntimeService>()(
	"ProjectionRuntime",
) {}

export const make = (
	definitions: readonly Definition<unknown, unknown, unknown, unknown, unknown>[],
): Result.Result<RuntimeService, ProjectionError> =>
	Result.map(
		definitions.reduce<
			Result.Result<
				HashMap.HashMap<string, Definition<unknown, unknown, unknown, unknown, unknown>>,
				ProjectionError
			>
		>(
			(current, definition) =>
				Result.gen(function* () {
					const entries = yield* current
					if (HashMap.has(entries, definition.id))
						return yield* Result.fail(
							ProjectionError.make({
								message: `Duplicate projection: ${definition.id}`,
							}),
						)
					return HashMap.set(entries, definition.id, definition)
				}),
			Result.succeed(HashMap.empty()),
		),
		(entries): RuntimeService => ({
			open: (id, input) =>
				Effect.gen(function* () {
					const definition = yield* Option.match(HashMap.get(entries, id), {
						onNone: () =>
							Effect.fail(
								ProjectionError.make({
									message: `Projection is not registered: ${id}`,
								}),
							),
						onSome: Effect.succeed,
					})
					const request = yield* Effect.fromResult(definition.decode(input))
					return yield* definition.open(request).pipe(
						Effect.mapError((cause) =>
							ProjectionError.make({
								message:
									cause instanceof Error ? cause.message : "Projection failed",
							}),
						),
					)
				}),
			list: Effect.succeed(Array.from(HashMap.keys(entries))),
		}),
	)

export const layer = (
	definitions: readonly Definition<unknown, unknown, unknown, unknown, unknown>[],
): Layer.Layer<ProjectionRuntime, ProjectionError> =>
	Layer.effect(ProjectionRuntime, Effect.fromResult(make(definitions)))
