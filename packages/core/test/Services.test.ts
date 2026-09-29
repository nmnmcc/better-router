import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Cause, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import * as Services from "@better-router/core/Services"

it.effect("provides model catalog, cache, response, job, and key-value memory adapters", () =>
	Effect.gen(function* () {
		const catalog = yield* Services.ModelCatalog
		assert.equal(yield* catalog.contains("chat"), true)
		assert.equal(yield* catalog.contains("missing"), false)
		assert.deepEqual(yield* catalog.models, ["chat", "responses"])

		const cache = yield* Services.Cache
		assert.deepEqual(yield* cache.get("missing"), Option.none())
		yield* cache.set("answer", 42)
		assert.deepEqual(yield* cache.get("answer"), Option.some(42))
		yield* cache.remove("answer")
		assert.deepEqual(yield* cache.get("answer"), Option.none())

		const responses = yield* Services.ResponseStore
		yield* responses.put("response_1", { status: "completed" })
		assert.deepEqual(yield* responses.get("response_1"), Option.some({ status: "completed" }))

		const jobs = yield* Services.JobStore
		yield* jobs.put("job_1", { status: "queued" })
		assert.deepEqual(yield* jobs.get("job_1"), Option.some({ status: "queued" }))

		const values = yield* Services.KeyValueStore
		yield* values.set("key", "value")
		assert.deepEqual(yield* values.get("key"), Option.some("value"))
		yield* values.remove("key")
		assert.deepEqual(yield* values.get("key"), Option.none())
	}).pipe(
		Effect.provide(
			Layer.mergeAll(
				Services.modelCatalogMemory(["chat", "responses"]),
				Services.cacheMemory,
				Services.responseMemory,
				Services.jobMemory,
				Services.keyValueMemory,
			),
		),
	),
)

it.effect("tracks health changes and unknown deployments as unhealthy", () =>
	Effect.gen(function* () {
		const health = yield* Services.HealthState
		assert.equal(yield* health.isHealthy("provider_1"), true)
		assert.equal(yield* health.isHealthy("missing"), false)
		const changes = yield* health.changes.pipe(
			Stream.take(1),
			Stream.runCollect,
			Effect.forkChild,
		)
		yield* Effect.yieldNow
		assert.deepEqual(yield* Fiber.join(changes), [{ provider_1: true }])
	}).pipe(Effect.provide(Services.healthMemory({ provider_1: true }))),
)

it.effect("enforces budget limits without charging failed reservations", () =>
	Effect.gen(function* () {
		const budget = yield* Services.BudgetLedger
		yield* budget.reserve("tenant", 3)
		const rejected = yield* Effect.flip(budget.reserve("tenant", 3))
		assert.equal(rejected.tenant, "tenant")
		yield* budget.settle("tenant", 2)
		yield* budget.reserve("tenant", 2)
		const stillRejected = yield* Effect.flip(budget.reserve("tenant", 3))
		assert.equal(stillRejected._tag, "BudgetError")
	}).pipe(Effect.provide(Services.budgetMemory({ tenant: 5 }))),
)

it.effect("keeps concurrent budget reservations atomic", () =>
	Effect.gen(function* () {
		const budget = yield* Services.BudgetLedger
		const [first, second] = yield* Effect.all(
			[
				Effect.exit(budget.reserve("tenant", 3)),
				Effect.exit(budget.reserve("tenant", 3)),
			] as const,
			{ concurrency: "unbounded" },
		)
		const successes = [first, second].filter(Exit.isSuccess)
		const failures = [first, second].filter(Exit.isFailure)
		assert.equal(successes.length, 1)
		assert.equal(failures.length, 1)
		if (failures.length !== 1) return
		const reasons = failures[0].cause.reasons.filter(Cause.isFailReason)
		assert.equal(reasons.length, 1)
		if (reasons.length !== 1) return
		assert.equal(reasons[0].error._tag, "BudgetError")
		yield* budget.reserve("tenant", 2)
		const exhausted = yield* Effect.flip(budget.reserve("tenant", 1))
		assert.equal(exhausted._tag, "BudgetError")
	}).pipe(Effect.provide(Services.budgetMemory({ tenant: 5 }))),
)
