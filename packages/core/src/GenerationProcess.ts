import { Deferred, Effect, Match, Option, Ref, Schema, Stream } from "effect"
import type { GenerationEvent, GenerationResponse } from "./Generation.js"

/** Errors raised while reconstructing the terminal value of a generation. */
export class ProcessError extends Schema.TaggedError<ProcessError>()("GenerationProcessError", {
	message: Schema.String,
}) {}

export type ProcessFailure<E> = E | ProcessError

/**
 * A generation is a live process rather than a response-shaped data object.
 *
 * `events` is lazy and may be subscribed to independently. `response` folds a
 * subscription until the first terminal response event. `cancel` interrupts
 * every view created from this process and is idempotent.
 */
export interface Process<E = unknown, R = never> {
	readonly events: Stream.Stream<GenerationEvent, E, R>
	readonly response: Effect.Effect<GenerationResponse, ProcessFailure<E>, R>
	readonly terminal: Effect.Effect<GenerationResponse, ProcessFailure<E>, R>
	readonly cancel: Effect.Effect<void>
}

const terminalResponse = (event: GenerationEvent): Option.Option<GenerationResponse> =>
	Match.value(event).pipe(
		Match.when(
			{
				type: Match.is("response.completed", "response.incomplete", "response.failed"),
			},
			(value) => Option.some(value.response),
		),
		Match.orElse(() => Option.none()),
	)

const missingTerminal = (): ProcessError =>
	ProcessError.make({ message: "Generation ended without exactly one terminal response" })

/** Fold semantic events without invoking the provider a second time. */
export const complete = <E, R>(
	events: Stream.Stream<GenerationEvent, E, R>,
): Effect.Effect<GenerationResponse, ProcessFailure<E>, R> =>
	Stream.runFoldEffect(
		events,
		() => Option.none<GenerationResponse>(),
		(previous, event) => {
			const terminal = terminalResponse(event)
			return Option.isSome(terminal)
				? Option.isSome(previous)
					? Effect.fail(missingTerminal())
					: Effect.succeed(terminal)
				: Effect.succeed(previous)
		},
	).pipe(
		Effect.flatMap((value) =>
			Option.match(value, {
				onNone: () => Effect.fail(missingTerminal()),
				onSome: Effect.succeed,
			}),
		),
	)

/** Construct a cancellable process around one provider event stream. */
export const make = <E, R>(
	events: Stream.Stream<GenerationEvent, E, R>,
): Effect.Effect<Process<E, R>> =>
	Effect.gen(function* () {
		const cancelled = yield* Deferred.make<void>()
		const cancelledRef = yield* Ref.make(false)
		const view = Stream.interruptWhen(Deferred.await(cancelled))(events)
		const response = Effect.raceFirst(
			complete(view),
			Deferred.await(cancelled).pipe(Effect.flatMap(() => Effect.interrupt)),
		).pipe(
			Effect.catchCause((cause) =>
				Ref.get(cancelledRef).pipe(
					Effect.flatMap((isCancelled) =>
						isCancelled ? Effect.interrupt : Effect.failCause(cause),
					),
				),
			),
			Effect.flatMap((value) =>
				Ref.get(cancelledRef).pipe(
					Effect.flatMap((isCancelled) =>
						isCancelled ? Effect.interrupt : Effect.succeed(value),
					),
				),
			),
		)
		return {
			events: view,
			response,
			terminal: response,
			cancel: Ref.set(cancelledRef, true).pipe(
				Effect.andThen(Deferred.succeed(cancelled, void 0)),
			),
		} satisfies Process<E, R>
	})

/** Namespace-shaped API used as `Generation.Process.make` by consumers. */
export const Process = {
	make,
	complete,
}
