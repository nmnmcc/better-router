import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Option, Ref, Result, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as Deployment from "../src/Deployment.js"
import * as Persistence from "../src/Persistence.js"
import * as RoutingRuntime from "../src/RoutingRuntime.js"

const primary = Deployment.make({
	id: "primary",
	provider: "provider",
	model: "model",
	protocol: "generation",
	pricing: { inputPerToken: 1, outputPerToken: 2 },
	limits: { maxConcurrent: 1, rpm: 2, tpm: 100, maxTokens: 20 },
})

const request = {
	model: "model",
	input: "hello",
	max_output_tokens: 2,
} as const

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	effect.pipe(Effect.provide(Persistence.layerMemory), Effect.provide(TestClock.layer()))

it.effect("reserves capacity and settles usage, cost, and latency exactly once", () =>
	provide(
		Effect.gen(function* () {
			const runtime = yield* RoutingRuntime.make([primary])
			const reservation = yield* runtime.reserve(primary, request, {
				key: "tenant",
				limit: 100,
				reservation: 5,
			})
			const during = yield* runtime.state(primary.id)
			assert.equal(during.activeRequests, 1)
			assert.equal(during.reservedTokens, reservation.estimatedTokens)
			assert.equal(during.reservedCost, reservation.estimatedCost)

			yield* runtime.finish(reservation, {
				_tag: "success",
				latencyMs: 12,
				usage: {
					input_tokens: 2,
					output_tokens: 3,
					total_tokens: 5,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			})
			const after = yield* runtime.state(primary.id)
			assert.equal(after.activeRequests, 0)
			assert.equal(after.reservedTokens, 0)
			assert.equal(after.reservedCost, 0)
			assert.equal(after.successCount, 1)
			assert.equal(after.failureCount, 0)
			assert.equal(after.inputTokens, 2)
			assert.equal(after.outputTokens, 3)
			assert.equal(after.totalCost, 8)
			assert.equal(after.latencyMs, 12)

			yield* runtime.finish(reservation, { _tag: "success" })
			assert.equal((yield* runtime.state(primary.id)).activeRequests, 0)
		}),
	),
)

it.effect("checks concurrent capacity and restores it after cancellation", () =>
	provide(
		Effect.gen(function* () {
			const runtime = yield* RoutingRuntime.make([primary])
			const first = yield* runtime.reserve(primary, request)
			const blocked = yield* runtime.reserve(primary, request).pipe(Effect.flip)
			assert.equal(blocked.kind, "capacity")
			yield* runtime.finish(first, { _tag: "cancelled" })
			const second = yield* runtime.reserve(primary, request)
			yield* runtime.finish(second, { _tag: "failure", cooldownMillis: 0 })
			const state = yield* runtime.state(primary.id)
			assert.equal(state.activeRequests, 0)
			assert.equal(state.failureCount, 1)
		}),
	),
)

it.effect("serializes concurrent reservations at a shared capacity boundary", () =>
	provide(
		Effect.gen(function* () {
			const runtime = yield* RoutingRuntime.make([primary])
			const outcomes = yield* Effect.all(
				[
					Effect.result(runtime.reserve(primary, request)),
					Effect.result(runtime.reserve(primary, request)),
				],
				{ concurrency: "unbounded" },
			)
			const successes = outcomes.filter(Result.isSuccess)
			const failures = outcomes.filter(Result.isFailure)
			assert.equal(successes.length, 1)
			assert.equal(failures.length, 1)
			const firstSuccess = successes[0]
			const firstFailure = failures[0]
			assert.equal(firstFailure?.failure.kind, "capacity")
			if (firstSuccess !== undefined)
				yield* runtime.finish(firstSuccess.success, { _tag: "cancelled" })
			assert.equal((yield* runtime.state(primary.id)).activeRequests, 0)
		}),
	),
)

it.effect("enforces RPM and budget windows, then resets only the window counters", () =>
	provide(
		Effect.gen(function* () {
			const limited = Deployment.make({
				...primary,
				id: "limited",
				limits: { maxConcurrent: 2, rpm: 2, tpm: 100, maxTokens: 20 },
			})
			const runtime = yield* RoutingRuntime.make([limited])
			const first = yield* runtime.reserve(limited, request, {
				key: "tenant",
				limit: 5,
				reservation: 5,
			})
			const budgetBlocked = yield* runtime
				.reserve(limited, request, {
					key: "tenant",
					limit: 5,
					reservation: 5,
				})
				.pipe(Effect.flip)
			assert.equal(budgetBlocked.kind, "budget")
			yield* runtime.finish(first, { _tag: "cancelled" })
			const second = yield* runtime.reserve(limited, request, { limit: 100 })
			yield* runtime.finish(second, { _tag: "cancelled" })
			const rpmBlocked = yield* runtime
				.reserve(limited, request, {
					key: "tenant",
					limit: 100,
				})
				.pipe(Effect.flip)
			assert.equal(rpmBlocked.kind, "rate_limit")
			yield* TestClock.adjust("61 seconds")
			const next = yield* runtime.reserve(limited, request, {
				key: "tenant",
				limit: 5,
				reservation: 5,
			})
			yield* runtime.finish(next, { _tag: "cancelled" })
			assert.equal((yield* runtime.state(limited.id)).failureCount, 0)
		}),
	),
)

it.effect("recovers abandoned reservations after the prior owner scope closes", () =>
	provide(
		Effect.gen(function* () {
			const persistence = yield* Persistence.Persistence
			const closed = yield* Ref.make(false)
			const prior = yield* Effect.scoped(
				Effect.gen(function* () {
					yield* Effect.addFinalizer(() => Ref.set(closed, true))
					const first = yield* RoutingRuntime.make([primary])
					const reservation = yield* first.reserve(primary, request)
					yield* first.finish(reservation, { _tag: "success" })
					const stale = yield* first.reserve(primary, request)
					return { reservation, stale }
				}),
			)
			assert.equal(yield* Ref.get(closed), true)
			const reloaded = yield* RoutingRuntime.make([primary])
			const state = yield* reloaded.state(primary.id)
			assert.equal(state.activeRequests, 0)
			assert.equal(state.reservedTokens, 0)
			assert.equal(state.successCount, 1)
			assert.equal(state.totalCost, prior.reservation.estimatedCost)
			const stored = yield* persistence.state(RoutingRuntime.declaration).get("snapshot")
			assert.equal(Option.isSome(stored), true)
			if (Option.isSome(stored)) assert.deepEqual(stored.value.reservations, {})
			const foreign = yield* reloaded
				.finish(prior.stale, { _tag: "cancelled" })
				.pipe(Effect.flip)
			assert.equal(foreign.kind, "reservation")
		}),
	),
)

it.effect("settles concurrent duplicate finish calls without double billing", () =>
	provide(
		Effect.gen(function* () {
			const runtime = yield* RoutingRuntime.make([primary])
			const reservation = yield* runtime.reserve(primary, request)
			yield* Effect.all(
				[
					runtime.finish(reservation, { _tag: "success" }),
					runtime.finish(reservation, { _tag: "success" }),
				],
				{ concurrency: "unbounded" },
			)
			const state = yield* runtime.state(primary.id)
			assert.equal(state.successCount, 1)
			assert.equal(state.activeRequests, 0)
			assert.equal(state.totalCost, reservation.estimatedCost)
		}),
	),
)

it.effect("persists cooldown and clears it only after the wall clock deadline", () =>
	provide(
		Effect.gen(function* () {
			yield* Effect.scoped(
				Effect.gen(function* () {
					const runtime = yield* RoutingRuntime.make([primary])
					const reservation = yield* runtime.reserve(primary, request)
					yield* runtime.finish(reservation, { _tag: "failure", cooldownMillis: 1_000 })
					assert.deepEqual(yield* runtime.available([primary]), [])
				}),
			)
			const reloaded = yield* RoutingRuntime.make([primary])
			assert.deepEqual(yield* reloaded.available([primary]), [])
			yield* TestClock.adjust("1 second")
			assert.deepEqual(yield* reloaded.available([primary]), [primary])
			assert.equal((yield* reloaded.state(primary.id)).healthy, true)
		}),
	),
)

it.effect("charges observed failed usage while releasing the remaining reservation", () =>
	provide(
		Effect.gen(function* () {
			const runtime = yield* RoutingRuntime.make([primary])
			const reservation = yield* runtime.reserve(primary, request, { limit: 100 })
			yield* runtime.finish(reservation, {
				_tag: "failure",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			})
			const state = yield* runtime.state(primary.id)
			assert.equal(state.totalCost, 3)
			assert.equal(state.inputTokens, 1)
			assert.equal(state.failureCount, 1)
			assert.equal(state.reservedCost, 0)
		}),
	),
)

it.effect("uses short pricing aliases and enforces input/output token limits", () =>
	provide(
		Effect.gen(function* () {
			const limited = Deployment.make({
				...primary,
				id: "short-pricing",
				pricing: { input: 3, output: 5 },
				limits: { maxInputTokens: 2, maxOutputTokens: 4, maxTokens: 6 },
			})
			const runtime = yield* RoutingRuntime.make([limited])
			const reservation = yield* runtime.reserve(
				limited,
				{
					model: "model",
					input: "abcd",
					max_output_tokens: 2,
				},
				{ limit: 13 },
			)
			assert.equal(reservation.estimatedInputTokens, 1)
			assert.equal(reservation.estimatedOutputTokens, 2)
			assert.equal(reservation.estimatedCost, 13)
			assert.equal(reservation.budgetReservation, 13)
			const budgetBlocked = yield* runtime
				.reserve(
					limited,
					{ model: "model", input: "abcd", max_output_tokens: 2 },
					{ limit: 13 },
				)
				.pipe(Effect.flip)
			assert.equal(budgetBlocked.kind, "budget")
			yield* runtime.finish(reservation, {
				_tag: "success",
				usage: {
					input_tokens: 1,
					output_tokens: 2,
					total_tokens: 3,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				},
			})
			assert.equal((yield* runtime.state(limited.id)).totalCost, 13)
			const inputBlocked = yield* runtime
				.reserve(limited, {
					model: "model",
					input: "123456789012",
					max_output_tokens: 1,
				})
				.pipe(Effect.flip)
			assert.equal(inputBlocked.kind, "token_limit")
			const outputBlocked = yield* runtime
				.reserve(limited, {
					model: "model",
					input: "a",
					max_output_tokens: 5,
				})
				.pipe(Effect.flip)
			assert.equal(outputBlocked.kind, "token_limit")
		}),
	),
)

it.effect("caps inferred output by total token limits when the request omits max output", () =>
	provide(
		Effect.gen(function* () {
			const limited = Deployment.make({
				...primary,
				id: "inferred-output",
				limits: { maxTokens: 4, maxOutputTokens: 20 },
			})
			const runtime = yield* RoutingRuntime.make([limited])
			const reservation = yield* runtime.reserve(limited, {
				model: "model",
				input: "abcd",
			})
			assert.equal(reservation.estimatedInputTokens, 1)
			assert.equal(reservation.estimatedOutputTokens, 3)
			yield* runtime.finish(reservation, { _tag: "cancelled" })
		}),
	),
)

it.effect("keeps invalid budget and usage issue paths without changing accounting", () =>
	provide(
		Effect.gen(function* () {
			const runtime = yield* RoutingRuntime.make([primary])
			const invalidBudget = yield* runtime
				.reserve(primary, request, {
					limit: Number.POSITIVE_INFINITY,
				})
				.pipe(Effect.flip)
			assert.equal(invalidBudget.kind, "invalid")
			assert.equal(invalidBudget.retryable, false)
			assert.equal(Schema.isSchemaError(invalidBudget.cause), true)
			if (Schema.isSchemaError(invalidBudget.cause))
				assert.match(invalidBudget.cause.message, /limit/)
			assert.equal((yield* runtime.state(primary.id)).activeRequests, 0)
			const reservation = yield* runtime.reserve(primary, request)
			const invalidUsage = yield* runtime
				.finish(reservation, {
					_tag: "success",
					usage: {
						input_tokens: -1,
						output_tokens: 0,
						total_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
						output_tokens_details: { reasoning_tokens: 0 },
					},
				})
				.pipe(Effect.flip)
			assert.equal(invalidUsage.kind, "invalid")
			assert.equal(Schema.isSchemaError(invalidUsage.cause), true)
			if (Schema.isSchemaError(invalidUsage.cause))
				assert.match(invalidUsage.cause.message, /usage.*input_tokens|input_tokens/s)
			assert.equal((yield* runtime.state(primary.id)).activeRequests, 1)
			yield* runtime.finish(reservation, { _tag: "cancelled" })
		}),
	),
)

it.effect("handles deployment and tenant names that match object prototype keys", () =>
	provide(
		Effect.gen(function* () {
			const named = Deployment.make({ ...primary, id: "constructor", limits: {} })
			const runtime = yield* RoutingRuntime.make([named])
			const reservation = yield* runtime.reserve(
				named,
				{
					...request,
					metadata: { tenant: "__proto__" },
				},
				{ limit: 100 },
			)
			assert.equal(reservation.budgetKey, "__proto__")
			yield* runtime.finish(reservation, { _tag: "cancelled" })
			assert.equal((yield* runtime.state(named.id)).activeRequests, 0)
			const unknown = yield* runtime
				.reserve({ ...primary, id: "toString" }, request)
				.pipe(Effect.flip)
			assert.equal(unknown.kind, "deployment")
		}),
	),
)
