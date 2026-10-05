import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Option, Ref, Scope, Stream } from "effect"
import type { GenerationEvent, GenerationResponse } from "../src/Generation.js"
import * as RoutingProcess from "../src/RoutingProcess.js"

const response: GenerationResponse = {
	id: "response_shared",
	object: "response",
	created_at: 0,
	completed_at: 1,
	status: "completed",
	incomplete_details: null,
	model: "test-model",
	previous_response_id: null,
	instructions: null,
	output: [],
	error: null,
	tools: [],
	tool_choice: "auto",
	truncation: "disabled",
	parallel_tool_calls: false,
	text: { format: { type: "text" } },
	top_p: 1,
	presence_penalty: 0,
	frequency_penalty: 0,
	top_logprobs: 0,
	temperature: 1,
	reasoning: null,
	usage: null,
	max_output_tokens: null,
	max_tool_calls: null,
	store: false,
	background: false,
	service_tier: "default",
	metadata: null,
	safety_identifier: null,
	prompt_cache_key: null,
}

const created: GenerationEvent = {
	type: "response.created",
	sequence_number: 0,
	response: { ...response, status: "in_progress", completed_at: null },
}

const terminal: GenerationEvent = {
	type: "response.completed",
	sequence_number: 1,
	response,
}

const CallbackService = Context.Service<{ readonly marker: string }>(
	"RoutingProcessTestCallbackService",
)

it.effect("lazily shares one execution across events and later response views", () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const invocations = yield* Ref.make(0)
		const source = Stream.unwrap(
			Ref.update(invocations, (count) => count + 1).pipe(
				Effect.as(Stream.make(created, terminal)),
			),
		)
		const process = yield* RoutingProcess.make(source, Context.empty(), scope)
		assert.equal(yield* Ref.get(invocations), 0)
		assert.deepEqual(yield* Stream.runCollect(process.events), [created, terminal])
		assert.deepEqual(yield* process.response, response)
		assert.deepEqual(yield* process.terminal, response)
		assert.deepEqual(yield* Stream.runCollect(process.events), [created, terminal])
		yield* process.cancel
		assert.deepEqual(yield* process.response, response)
		assert.equal(yield* Ref.get(invocations), 1)
	}),
)

it.effect("concurrent event and response subscribers share all events", () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const invocations = yield* Ref.make(0)
		const emitTerminal = yield* Deferred.make<void>()
		const source = Stream.unwrap(
			Ref.update(invocations, (count) => count + 1).pipe(
				Effect.as(
					Stream.make(created).pipe(
						Stream.concat(
							Stream.fromEffect(Deferred.await(emitTerminal)).pipe(Stream.drain),
						),
						Stream.concat(Stream.succeed(terminal)),
					),
				),
			),
		)
		const process = yield* RoutingProcess.make(source, Context.empty(), scope)
		const first = yield* Stream.runCollect(process.events).pipe(Effect.forkChild)
		const second = yield* Stream.runCollect(process.events).pipe(Effect.forkChild)
		const completed = yield* process.response.pipe(Effect.forkChild)
		yield* Deferred.succeed(emitTerminal, void 0)
		assert.deepEqual(yield* Fiber.join(first), [created, terminal])
		assert.deepEqual(yield* Fiber.join(second), [created, terminal])
		assert.deepEqual(yield* Fiber.join(completed), response)
		assert.equal(yield* Ref.get(invocations), 1)
	}),
)

it.effect("cancels a suspended upstream once and waits for scoped release", () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const acquired = yield* Deferred.make<void>()
		const released = yield* Ref.make(0)
		const source = Stream.unwrap(
			Effect.acquireRelease(Deferred.succeed(acquired, void 0), () =>
				Ref.update(released, (count) => count + 1),
			).pipe(Effect.as(Stream.never)),
		)
		const process = yield* RoutingProcess.make(source, Context.empty(), scope)
		const events = yield* Stream.runDrain(process.events).pipe(Effect.forkChild)
		const completed = yield* process.response.pipe(Effect.forkChild)
		yield* Deferred.await(acquired)
		yield* Effect.all([process.cancel, process.cancel], { concurrency: "unbounded" })
		assert.equal(yield* Ref.get(released), 1)
		assert.equal(Exit.isSuccess(yield* Fiber.await(events)), true)
		const completion = yield* Fiber.await(completed)
		assert.equal(Exit.isFailure(completion), true)
		if (Exit.isFailure(completion))
			assert.equal(Cause.hasInterruptsOnly(completion.cause), true)
	}),
)

it.effect("cancel before a subscription never starts the provider", () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const invocations = yield* Ref.make(0)
		const process = yield* RoutingProcess.make(
			Stream.fromEffect(Ref.update(invocations, (count) => count + 1)).pipe(
				Stream.drain,
				Stream.concat(Stream.succeed(terminal)),
			),
			Context.empty(),
			scope,
		)
		yield* process.cancel
		assert.deepEqual(yield* Stream.runCollect(process.events), [])
		const completion = yield* Effect.exit(process.response)
		assert.equal(Exit.isFailure(completion), true)
		if (Exit.isFailure(completion))
			assert.equal(Cause.hasInterruptsOnly(completion.cause), true)
		assert.equal(yield* Ref.get(invocations), 0)
	}),
)

it.effect("interrupting the sole subscriber cancels and releases the source", () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const acquired = yield* Deferred.make<void>()
		const released = yield* Ref.make(0)
		const source = Stream.unwrap(
			Effect.acquireRelease(Deferred.succeed(acquired, void 0), () =>
				Ref.update(released, (count) => count + 1),
			).pipe(Effect.as(Stream.never)),
		)
		const process = yield* RoutingProcess.make(source, Context.empty(), scope)
		const events = yield* Stream.runDrain(process.events).pipe(Effect.forkChild)
		yield* Deferred.await(acquired)
		yield* Fiber.interrupt(events)
		assert.equal(yield* Ref.get(released), 1)
		const completion = yield* Effect.exit(process.response)
		assert.equal(Exit.isFailure(completion), true)
	}),
)

it.effect("preserves missing and duplicate terminal errors without restarting", () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		yield* Effect.forEach([Stream.empty, Stream.make(terminal, terminal)], (source) =>
			Effect.gen(function* () {
				const process = yield* RoutingProcess.make(source, Context.empty(), scope)
				const first = yield* Effect.flip(process.response)
				const repeated = yield* Effect.flip(process.response)
				assert.equal(first._tag, "GenerationProcessError")
				assert.equal(first, repeated)
			}),
		)
	}),
)

it.effect("shares typed provider and finalizer errors with every view", () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const failure = { _tag: "FinalizerFailure" as const }
		const invocations = yield* Ref.make(0)
		const process = yield* RoutingProcess.makeFromProducer(
			(emit) =>
				Ref.update(invocations, (count) => count + 1).pipe(
					Effect.andThen(emit(terminal)),
					Effect.onExit(() => Effect.fail(failure)),
				),
			Context.empty(),
			scope,
		)
		assert.equal(yield* Effect.flip(Stream.runDrain(process.events)), failure)
		assert.equal(yield* Effect.flip(process.response), failure)
		assert.equal(yield* Ref.get(invocations), 1)
	}),
)

it.effect("an early events subscriber leaves a concurrent response producer running", () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const continueSource = yield* Deferred.make<void>()
		const releases = yield* Ref.make(0)
		const source = Stream.unwrap(
			Effect.acquireRelease(Effect.void, () =>
				Ref.update(releases, (count) => count + 1),
			).pipe(
				Effect.as(
					Stream.succeed(created).pipe(
						Stream.concat(
							Stream.fromEffect(Deferred.await(continueSource)).pipe(Stream.drain),
						),
						Stream.concat(Stream.succeed(terminal)),
					),
				),
			),
		)
		const process = yield* RoutingProcess.make(source, Context.empty(), scope)
		const completion = yield* Effect.forkChild(process.response, { startImmediately: true })
		assert.deepEqual(yield* process.events.pipe(Stream.take(1), Stream.runCollect), [created])
		assert.equal(yield* Ref.get(releases), 0)
		yield* Deferred.succeed(continueSource, void 0)
		assert.deepEqual(yield* Fiber.join(completion), response)
		assert.equal(yield* Ref.get(releases), 1)
	}),
)

it.effect("closing the router scope interrupts and releases its live producer", () =>
	Effect.gen(function* () {
		const ownerScope = yield* Scope.make()
		const acquired = yield* Deferred.make<void>()
		const releases = yield* Ref.make(0)
		const process = yield* RoutingProcess.make(
			Stream.unwrap(
				Effect.acquireRelease(Deferred.succeed(acquired, void 0), () =>
					Ref.update(releases, (count) => count + 1),
				).pipe(Effect.as(Stream.never)),
			),
			Context.empty(),
			ownerScope,
		)
		const completion = yield* process.response.pipe(Effect.forkChild)
		yield* Deferred.await(acquired)
		yield* Scope.close(ownerScope, Exit.void)
		assert.equal(yield* Ref.get(releases), 1)
		const exit = yield* Fiber.await(completion)
		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) assert.equal(Cause.hasInterruptsOnly(exit.cause), true)
	}),
)

it.effect("closing an owner scope before first view does not start the producer", () =>
	Effect.gen(function* () {
		const ownerScope = yield* Scope.make()
		const invocations = yield* Ref.make(0)
		yield* RoutingProcess.make(
			Stream.fromEffect(Ref.update(invocations, (count) => count + 1)).pipe(Stream.drain),
			Context.empty(),
			ownerScope,
		)
		yield* Scope.close(ownerScope, Exit.void)
		assert.equal(yield* Ref.get(invocations), 0)
	}),
)

it.effect("cancel preserves typed failures from interrupted producer finalizers", () =>
	Effect.gen(function* () {
		const ownerScope = yield* Scope.Scope
		const acquired = yield* Deferred.make<void>()
		const failure = { _tag: "CancelledFinalizerFailure" as const }
		const process = yield* RoutingProcess.makeFromProducer(
			() =>
				Deferred.succeed(acquired, void 0).pipe(
					Effect.andThen(Effect.never),
					Effect.onExit(() => Effect.fail(failure)),
				),
			Context.empty(),
			ownerScope,
		)
		const completion = yield* process.response.pipe(Effect.forkChild)
		yield* Deferred.await(acquired)
		yield* process.cancel
		const exit = yield* Fiber.await(completion)
		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) {
			assert.equal(Cause.hasInterrupts(exit.cause), true)
			assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(failure))
		}
	}),
)

it.effect("subscription startup racing cancellation always settles every view", () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		yield* Effect.forEach(
			Array.from({ length: 16 }, (_, index) => index),
			() =>
				Effect.gen(function* () {
					const process = yield* RoutingProcess.make(Stream.never, Context.empty(), scope)
					const completion = yield* Effect.forkChild(process.response, {
						startImmediately: true,
					})
					yield* process.cancel
					const exit = yield* Fiber.await(completion)
					assert.equal(Exit.isFailure(exit), true)
					assert.deepEqual(yield* Stream.runCollect(process.events), [])
				}),
		)
	}),
)

it.effect("a duplicate terminal settles the response and releases a suspended source", () =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const releases = yield* Ref.make(0)
		const source = Stream.unwrap(
			Effect.acquireRelease(Effect.void, () =>
				Ref.update(releases, (count) => count + 1),
			).pipe(Effect.as(Stream.make(terminal, terminal).pipe(Stream.concat(Stream.never)))),
		)
		const process = yield* RoutingProcess.make(source, Context.empty(), scope)
		const failure = yield* Effect.flip(process.response)
		assert.equal(failure._tag, "GenerationProcessError")
		assert.equal(yield* Ref.get(releases), 1)
	}),
)

it.effect("runs the pre-start cancel callback once and keeps its typed failure", () =>
	Effect.gen(function* () {
		const ownerScope = yield* Scope.make()
		const calls = yield* Ref.make(0)
		const failure = { _tag: "RequestCancelledBeforeStart" as const }
		const process = yield* RoutingProcess.make(Stream.never, Context.empty(), ownerScope, {
			onCancelBeforeStart: Ref.update(calls, (count) => count + 1).pipe(
				Effect.andThen(Effect.fail(failure)),
			),
		})
		yield* process.cancel
		yield* process.cancel
		const exit = yield* Effect.exit(process.response)
		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) {
			assert.equal(Cause.hasInterrupts(exit.cause), true)
			assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(failure))
		}
		assert.equal(yield* Ref.get(calls), 1)
	}),
)

it.effect("shares one suspended pre-start callback across concurrent cancellation", () =>
	Effect.gen(function* () {
		const ownerScope = yield* Scope.make()
		const calls = yield* Ref.make(0)
		const callbackStarted = yield* Deferred.make<void>()
		const continueCallback = yield* Deferred.make<void>()
		const failure = { _tag: "ConcurrentRequestCancelledBeforeStart" as const }
		const process = yield* RoutingProcess.make(Stream.never, Context.empty(), ownerScope, {
			onCancelBeforeStart: Ref.update(calls, (count) => count + 1).pipe(
				Effect.andThen(Deferred.succeed(callbackStarted, void 0)),
				Effect.andThen(Deferred.await(continueCallback)),
				Effect.andThen(Effect.fail(failure)),
			),
		})
		const first = yield* process.cancel.pipe(Effect.forkChild)
		yield* Deferred.await(callbackStarted)
		const second = yield* process.cancel.pipe(Effect.forkChild({ startImmediately: true }))
		yield* Deferred.succeed(continueCallback, void 0)
		yield* Fiber.join(first)
		yield* Fiber.join(second)
		const exit = yield* Effect.exit(process.response)
		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) {
			assert.equal(Cause.hasInterrupts(exit.cause), true)
			assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(failure))
		}
		assert.equal(yield* Ref.get(calls), 1)
	}),
)

it.effect("runs the pre-start callback when the owner scope closes", () =>
	Effect.gen(function* () {
		const ownerScope = yield* Scope.make()
		const calls = yield* Ref.make(0)
		const failure = { _tag: "OwnerScopeRequestCancelledBeforeStart" as const }
		const process = yield* RoutingProcess.make(Stream.never, Context.empty(), ownerScope, {
			onCancelBeforeStart: Ref.update(calls, (count) => count + 1).pipe(
				Effect.andThen(Effect.fail(failure)),
			),
		})
		yield* Scope.close(ownerScope, Exit.void)
		assert.equal(yield* Ref.get(calls), 1)
		const exit = yield* Effect.exit(process.response)
		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) {
			assert.equal(Cause.hasInterrupts(exit.cause), true)
			assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(failure))
		}
	}),
)

it.effect("provides the captured context to the pre-start callback", () =>
	Effect.gen(function* () {
		const ownerScope = yield* Scope.make()
		const observed = yield* Ref.make("")
		const context = Context.make(CallbackService, { marker: "captured-context" })
		const process = yield* RoutingProcess.make(Stream.never, context, ownerScope, {
			onCancelBeforeStart: CallbackService.use((service) =>
				Ref.set(observed, service.marker),
			),
		})
		yield* process.cancel
		assert.equal(yield* Ref.get(observed), "captured-context")
	}),
)

it.effect("runs the pre-start callback when startup cancellation wins before producer entry", () =>
	Effect.gen(function* () {
		const ownerScope = yield* Scope.make()
		const calls = yield* Ref.make(0)
		const failure = { _tag: "StartupRequestCancelledBeforeStart" as const }
		const process = yield* RoutingProcess.makeFromProducer(
			() => Effect.never,
			Context.empty(),
			ownerScope,
			{
				onCancelBeforeStart: Ref.update(calls, (count) => count + 1).pipe(
					Effect.andThen(Effect.fail(failure)),
				),
			},
		)
		const completion = yield* process.response.pipe(
			Effect.forkChild({ startImmediately: true }),
		)
		yield* process.cancel
		const exit = yield* Fiber.await(completion)
		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) {
			assert.equal(Cause.hasInterrupts(exit.cause), true)
			assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(failure))
		}
		assert.equal(yield* Ref.get(calls), 1)
	}),
)
