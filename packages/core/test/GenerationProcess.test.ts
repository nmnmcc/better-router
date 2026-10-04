import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Stream } from "effect"
import * as Generation from "@better-router/core/Generation"

const response = { id: "response_1", status: "completed" } as never
const terminal = {
	type: "response.completed" as const,
	sequence_number: 0,
	response,
}

it.effect("folds one terminal response and rejects missing or duplicate terminals", () =>
	Effect.gen(function* () {
		const completed = yield* Generation.Process.complete(Stream.succeed(terminal))
		assert.equal(completed.id, "response_1")

		const missing = yield* Effect.flip(Generation.Process.complete(Stream.empty))
		assert.equal(missing._tag, "GenerationProcessError")

		const duplicate = yield* Effect.flip(
			Generation.Process.complete(Stream.make(terminal, terminal)),
		)
		assert.equal(duplicate._tag, "GenerationProcessError")
	}),
)

it.effect("keeps subscriptions independent and interrupts them on cancellation", () =>
	Effect.gen(function* () {
		const process = yield* Generation.Process.make(
			Stream.make(
				{
					type: "response.created" as const,
					sequence_number: 0,
					response: { id: "response_2", status: "in_progress" } as never,
				},
				terminal,
			),
		)
		const first = yield* Stream.runCollect(process.events)
		const second = yield* Stream.runCollect(process.events)
		assert.deepEqual(first, second)

		const cancellable = yield* Generation.Process.make(Stream.never)
		const fiber = yield* cancellable.events.pipe(Stream.runDrain, Effect.forkChild)
		const responseFiber = yield* cancellable.response.pipe(Effect.forkChild)
		yield* cancellable.cancel
		const exit = yield* Fiber.await(fiber)
		const responseExit = yield* Fiber.await(responseFiber)
		assert.equal(Exit.isSuccess(exit), true)
		assert.equal(Exit.isFailure(responseExit), true)
		if (Exit.isFailure(responseExit))
			assert.equal(Cause.hasInterruptsOnly(responseExit.cause), true)
	}),
)
