import { Cause, Context, Deferred, Effect, Exit, Match, Option, Ref, Scope, Stream } from "effect"
import * as Fiber from "effect/Fiber"
import type { GenerationEvent, GenerationResponse } from "./Generation.js"
import { ProcessError } from "./GenerationProcess.js"
import type { Process, ProcessFailure } from "./GenerationProcess.js"

type JournalStep<E> =
	| {
			readonly _tag: "Event"
			readonly event: GenerationEvent
			readonly next: Deferred.Deferred<JournalStep<E>>
	  }
	| {
			readonly _tag: "End"
			readonly exit: Exit.Exit<void, E>
	  }

interface Journal<E> {
	readonly tail: Deferred.Deferred<JournalStep<E>>
	readonly terminal: Option.Option<GenerationResponse>
	readonly terminalCount: number
	readonly invalid: Option.Option<ProcessError>
}

interface Control {
	readonly started: boolean
	readonly entered: boolean
	readonly cancelled: boolean
	readonly done: boolean
}

export interface Options<E = never, R = never> {
	readonly onCancelBeforeStart?: Effect.Effect<void, E, R>
}

const terminalResponse = (event: GenerationEvent): Option.Option<GenerationResponse> =>
	Match.value(event).pipe(
		Match.when(
			{ type: Match.is("response.completed", "response.incomplete", "response.failed") },
			(value) => Option.some(value.response),
		),
		Match.orElse(() => Option.none()),
	)

const responseExit = <E>(
	exit: Exit.Exit<void, E>,
	journal: Journal<E>,
): Exit.Exit<GenerationResponse, ProcessFailure<E>> =>
	Option.isSome(journal.invalid)
		? Exit.fail(journal.invalid.value)
		: Exit.isFailure(exit)
			? Exit.failCause(exit.cause)
			: journal.terminalCount === 1 && Option.isSome(journal.terminal)
				? Exit.succeed(journal.terminal.value)
				: Exit.fail(
						ProcessError.make({
							message: "Generation ended without exactly one terminal response",
						}),
					)

/**
 * Bind one lazy producer to the router's scope. Every view replays that same
 * execution, and the terminal result is folded once by the producer.
 *
 * The immutable linked journal retains the finite generation for later views.
 * Its nodes have constant append cost and are released with the process.
 */
export const makeFromProducer = <E, R>(
	run: (emit: (event: GenerationEvent) => Effect.Effect<void>) => Effect.Effect<void, E, R>,
	context: Context.Context<R>,
	ownerScope: Scope.Scope,
	options: Options<E, R> = {},
): Effect.Effect<Process<E, never>> =>
	Effect.uninterruptible(
		Effect.gen(function* () {
			const processScope = yield* Scope.fork(ownerScope)
			const first = yield* Deferred.make<JournalStep<E>>()
			const journal = yield* Ref.make<Journal<E>>({
				tail: first,
				terminal: Option.none(),
				terminalCount: 0,
				invalid: Option.none(),
			})
			const control = yield* Ref.make<Control>({
				started: false,
				entered: false,
				cancelled: false,
				done: false,
			})
			const consumers = yield* Ref.make(0)
			const producerFiber = yield* Deferred.make<Option.Option<Fiber.Fiber<void, E>>>()
			const cancelled = yield* Deferred.make<void>()
			const callbackDone = yield* Ref.make(false)
			const callbackResult = yield* Deferred.make<void, E>()
			const completed = yield* Deferred.make<GenerationResponse, ProcessFailure<E>>()
			const beforeStart =
				options.onCancelBeforeStart === undefined
					? Effect.void
					: Effect.provideContext(options.onCancelBeforeStart, context)
			const cancelBeforeStart = Effect.uninterruptible(
				Ref.modify(callbackDone, (done) => [!done, true]).pipe(
					Effect.flatMap((claimed) =>
						claimed
							? Deferred.complete(callbackResult, beforeStart).pipe(
									Effect.andThen(Deferred.await(callbackResult)),
								)
							: Deferred.await(callbackResult),
					),
				),
			)

			const emit = (event: GenerationEvent): Effect.Effect<void> =>
				Effect.uninterruptible(
					Effect.gen(function* () {
						const next = yield* Deferred.make<JournalStep<E>>()
						const terminal = terminalResponse(event)
						const previous = yield* Ref.modify(journal, (current) => {
							const duplicate =
								Option.isSome(terminal) && current.terminalCount > 0
									? Option.some(
											ProcessError.make({
												message:
													"Generation emitted more than one terminal response",
											}),
										)
									: current.invalid
							return [
								[
									current.tail,
									Option.isNone(current.invalid) ? duplicate : Option.none(),
								] as const,
								{
									tail: next,
									terminal: Option.orElse(current.terminal, () => terminal),
									terminalCount:
										current.terminalCount + (Option.isSome(terminal) ? 1 : 0),
									invalid: Option.isSome(current.invalid)
										? current.invalid
										: duplicate,
								},
							] as const
						})
						const [tail, duplicate] = previous
						yield* Deferred.succeed(tail, { _tag: "Event", event, next })
						if (Option.isSome(duplicate))
							yield* Deferred.fail(completed, duplicate.value)
					}),
				)

			const finish = (exit: Exit.Exit<void, E>): Effect.Effect<void> =>
				Effect.gen(function* () {
					const outcome = yield* Ref.modify(control, (current) =>
						current.done
							? [Option.none<Exit.Exit<void, E>>(), current]
							: [
									Option.some(
										current.cancelled
											? Exit.isFailure(exit)
												? Exit.failCause(
														Cause.combine(
															Cause.interrupt(),
															exit.cause,
														),
													)
												: Exit.interrupt()
											: exit,
									),
									{ ...current, done: true },
								],
					)
					if (Option.isNone(outcome)) return
					const finalJournal = yield* Ref.get(journal)
					yield* Deferred.succeed(finalJournal.tail, { _tag: "End", exit: outcome.value })
					yield* Deferred.done(completed, responseExit(outcome.value, finalJournal))
					yield* Scope.close(processScope, outcome.value)
				})

			const producer = Effect.uninterruptibleMask((restore) =>
				Effect.scoped(
					Effect.gen(function* () {
						yield* Ref.update(control, (current) => ({ ...current, entered: true }))
						const sourceScope = yield* Scope.Scope
						const state = yield* Ref.get(control)
						if (state.cancelled) yield* cancelBeforeStart
						else
							yield* restore(
								Effect.suspend(() => run(emit)).pipe(
									Effect.provideContext(
										Context.add(context, Scope.Scope, sourceScope),
									),
								),
							)
					}),
				),
			).pipe(Effect.onExit(finish))

			// Claiming the start and completing its fiber cell are uninterruptible.
			// Cancellation can safely wait for the cell even when it races a fork.
			const start = Effect.uninterruptible(
				Effect.gen(function* () {
					const claimed = yield* Ref.modify(control, (current) => [
						!current.started,
						{ ...current, started: true },
					])
					if (!claimed) return
					const current = yield* Ref.get(control)
					if (current.cancelled) {
						yield* Deferred.succeed(producerFiber, Option.none())
						return
					}
					const fiber = yield* Effect.forkIn(producer, processScope, {
						uninterruptible: false,
					})
					yield* Deferred.succeed(producerFiber, Option.some(fiber))
				}),
			)

			const cancel = Effect.uninterruptible(
				Effect.gen(function* () {
					const pending = yield* Ref.modify(control, (current) => [
						!current.done,
						current.done ? current : { ...current, cancelled: true },
					])
					if (!pending) return
					yield* Deferred.succeed(cancelled, void 0)
					yield* start
					const fiber = yield* Deferred.await(producerFiber)
					if (Option.isNone(fiber)) {
						const callback = yield* Effect.exit(cancelBeforeStart)
						yield* finish(
							Exit.isFailure(callback)
								? Exit.failCause(Cause.combine(Cause.interrupt(), callback.cause))
								: Exit.interrupt(),
						)
					} else {
						yield* Fiber.interrupt(fiber.value)
						// A fiber interrupted before its first instruction has not yet
						// installed onExit. Settle the journal after its release as well.
						const producerExit = yield* Fiber.await(fiber.value)
						const state = yield* Ref.get(control)
						const callback = state.entered
							? Exit.succeed<void>(void 0)
							: yield* Effect.exit(cancelBeforeStart)
						yield* finish(
							Exit.isFailure(callback)
								? Exit.failCause(
										Cause.combine(
											Exit.isFailure(producerExit)
												? producerExit.cause
												: Cause.interrupt(),
											callback.cause,
										),
									)
								: producerExit,
						)
					}
				}),
			)

			const acquire = Ref.update(consumers, (count) => count + 1).pipe(Effect.andThen(start))
			const release = Ref.modify(consumers, (count) => [
				count === 1,
				Math.max(0, count - 1),
			]).pipe(Effect.flatMap((last) => (last ? cancel : Effect.void)))
			const replay = Stream.unfold(
				first,
				(
					node,
				): Effect.Effect<
					readonly [GenerationEvent, Deferred.Deferred<JournalStep<E>>] | undefined,
					E
				> =>
					Effect.gen(function* () {
						const current = yield* Ref.get(control)
						if (current.cancelled) return undefined
						const step = yield* Effect.raceFirst(
							Deferred.await(node).pipe(Effect.map(Option.some)),
							Deferred.await(cancelled).pipe(
								Effect.as(Option.none<JournalStep<E>>()),
							),
						)
						if (Option.isNone(step)) return undefined
						if (step.value._tag === "Event")
							return [step.value.event, step.value.next] as const
						if (Exit.isFailure(step.value.exit))
							return yield* Effect.failCause(step.value.exit.cause)
						return undefined
					}),
			)
			const events = Stream.unwrap(
				Effect.acquireRelease(acquire, () => release).pipe(Effect.as(replay)),
			)
			const response = Effect.acquireUseRelease(
				acquire,
				() => Deferred.await(completed),
				() => release,
			)

			yield* Scope.addFinalizer(processScope, cancel)
			return { events, response, terminal: response, cancel } satisfies Process<E, never>
		}),
	)

/** Construct a process around a stream without allowing views to rerun it. */
export const make = <E, R>(
	events: Stream.Stream<GenerationEvent, E, R>,
	context: Context.Context<R>,
	ownerScope: Scope.Scope,
	options: Options<E, R> = {},
): Effect.Effect<Process<E, never>> =>
	makeFromProducer((emit) => Stream.runForEach(events, emit), context, ownerScope, options)
