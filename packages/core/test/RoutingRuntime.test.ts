import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import * as Deployment from "../src/Deployment.js"
import * as Persistence from "../src/Persistence.js"
import * as RoutingRuntime from "../src/RoutingRuntime.js"

const deployment = Deployment.make({
	id: "primary",
	provider: "provider",
	model: "model",
	protocol: "generation",
	limits: { maxConcurrent: 1 },
})

const request = { model: "model", input: "hello", max_output_tokens: 1 } as const

it.effect("tracks durable active requests and cooldown availability", () =>
	Effect.gen(function* () {
		const runtime = yield* RoutingRuntime.make([deployment])
		const reservation = yield* runtime.reserve(deployment, request)
		yield* runtime.finish(reservation, { _tag: "failure", cooldownMillis: 1_000 })
		assert.deepEqual(yield* runtime.available([deployment]), [])
		yield* TestClock.adjust("1 second")
		assert.deepEqual(yield* runtime.available([deployment]), [deployment])
		const state = yield* runtime.state(deployment.id)
		assert.equal(state.activeRequests, 0)
		assert.equal(state.failureCount, 1)
	}).pipe(Effect.provide(Persistence.layerMemory), Effect.provide(TestClock.layer())),
)
