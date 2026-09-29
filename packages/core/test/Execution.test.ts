import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Exit, Fiber, Stream } from "effect"
import { opaque, generation, complete } from "@better-router/core/Execution"
import type { ProviderError } from "@better-router/core/Deployment"
import type { GenerationEvent } from "@better-router/core/Generation"
import type { RouterError } from "@better-router/core/Router"

const terminal = {
	type: "response.completed" as const,
	sequence_number: 0,
	response: { id: "response_1", status: "completed" } as never,
}

it.effect(
	"completes on each supported terminal response and rejects missing or duplicate terminals",
	() =>
		Effect.gen(function* () {
			const completed = yield* complete(Stream.succeed(terminal))
			assert.equal(completed.id, "response_1")

			const missing = yield* Effect.flip(complete(Stream.empty))
			assert.equal(missing._tag, "InvalidResponse")

			const duplicate = yield* Effect.flip(complete(Stream.make(terminal, terminal)))
			assert.equal(duplicate._tag, "InvalidResponse")
		}),
)

it.effect("interrupts generation and opaque response streams after cancellation", () =>
	Effect.gen(function* () {
		const generated = yield* generation(
			Stream.never as Stream.Stream<GenerationEvent, RouterError>,
		)
		if (generated.type !== "generation") return
		const generatedFiber = yield* generated.events.pipe(Stream.runDrain, Effect.forkChild)
		yield* generated.cancel
		const generatedExit = yield* Fiber.await(generatedFiber)
		assert.equal(Exit.isSuccess(generatedExit), true)

		const response = yield* opaque({
			status: 200,
			headers: {},
			body: Stream.never as Stream.Stream<Uint8Array, ProviderError>,
		})
		if (response.type !== "opaque") return
		const opaqueFiber = yield* response.response.body.pipe(Stream.runDrain, Effect.forkChild)
		yield* response.cancel
		const opaqueExit = yield* Fiber.await(opaqueFiber)
		assert.equal(Exit.isSuccess(opaqueExit), true)
	}),
)
