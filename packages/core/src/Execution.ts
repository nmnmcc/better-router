import { Context, Deferred, Effect, Match, Option, Stream } from "effect"
import type { GenerationEvent, GenerationResponse } from "./Generation.js"
import type { ProtocolResponse } from "./Pipeline.js"
import { RouterError } from "./Router.js"

export interface ContextValue {
	readonly requestId: string
	readonly identity?: { readonly tenant: string; readonly subject: string }
	readonly deadline?: number
}

/** A host supplies this per request; plugins do not read global mutable state. */
export class ExecutionContext extends Context.Service<ExecutionContext, ContextValue>()(
	"ExecutionContext",
) {}

export type Execution =
	| {
			readonly type: "generation"
			readonly events: Stream.Stream<GenerationEvent, RouterError>
			readonly cancel: Effect.Effect<void>
	  }
	| {
			readonly type: "opaque"
			readonly response: ProtocolResponse
			readonly cancel: Effect.Effect<void>
	  }

/** Every returned execution owns one cancellation signal for every subscription. */
export const generation = (
	events: Stream.Stream<GenerationEvent, RouterError>,
): Effect.Effect<Execution> =>
	Effect.map(Deferred.make<void>(), (cancelled) => ({
		type: "generation" as const,
		events: Stream.interruptWhen(Deferred.await(cancelled))(events),
		cancel: Deferred.succeed(cancelled, void 0),
	}))

export const opaque = (response: ProtocolResponse): Effect.Effect<Execution> =>
	Effect.map(Deferred.make<void>(), (cancelled) => ({
		type: "opaque" as const,
		response: {
			...response,
			body: Stream.interruptWhen(Deferred.await(cancelled))(response.body),
		},
		cancel: Deferred.succeed(cancelled, void 0),
	}))

/** Consumption runs the same lazy generation stream once, with no second provider call. */
export const complete = (
	events: Stream.Stream<GenerationEvent, RouterError>,
): Effect.Effect<GenerationResponse, RouterError> =>
	Stream.runFoldEffect(
		events,
		() => Option.none<GenerationResponse>(),
		(previous, event) =>
			Option.isSome(previous)
				? Effect.fail(invalid())
				: Effect.succeed(
						Match.value(event).pipe(
							Match.when(
								{
									type: Match.is(
										"response.completed",
										"response.incomplete",
										"response.failed",
									),
								},
								(value) => Option.some(value.response),
							),
							Match.orElse(() => previous),
						),
					),
	).pipe(
		Effect.flatMap((result) =>
			Option.match(result, { onNone: () => Effect.fail(invalid()), onSome: Effect.succeed }),
		),
	)

const invalid = (): RouterError =>
	RouterError.cases.InvalidResponse.make({ message: "Missing or duplicate terminal response" })
