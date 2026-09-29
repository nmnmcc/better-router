import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"
import { make } from "@better-router/core/Lifecycle"

const first = { type: "started", requestId: "request_1", model: "chat" } as const
const second = {
	type: "completed",
	requestId: "request_1",
	model: "chat",
	deployment: "provider_1",
} as const

it.effect("publishes lifecycle events to a subscription stream", () =>
	Effect.gen(function* () {
		const lifecycle = yield* make()
		const collected = yield* lifecycle.events.pipe(
			Stream.take(2),
			Stream.runCollect,
			Effect.forkChild,
		)
		yield* Effect.yieldNow
		yield* lifecycle.publish(first)
		yield* lifecycle.publish(second)
		assert.deepEqual(yield* Fiber.join(collected), [first, second])
	}),
)

it.effect("supports independent subscriptions to the same lifecycle", () =>
	Effect.gen(function* () {
		const lifecycle = yield* make()
		const firstSubscription = yield* lifecycle.events.pipe(
			Stream.take(1),
			Stream.runCollect,
			Effect.forkChild,
		)
		const secondSubscription = yield* lifecycle.events.pipe(
			Stream.take(1),
			Stream.runCollect,
			Effect.forkChild,
		)
		yield* Effect.yieldNow
		yield* lifecycle.publish(first)
		assert.deepEqual(yield* Fiber.join(firstSubscription), [first])
		assert.deepEqual(yield* Fiber.join(secondSubscription), [first])
	}),
)
