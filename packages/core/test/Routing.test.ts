import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Ref, Result, Stream } from "effect"
import * as Generation from "@better-router/core/Generation"
import * as Routing from "@better-router/core/Routing"

const request: Generation.GenerationRequest = { model: "chat", input: [] }

const candidates: readonly Routing.DeploymentRef[] = [
	{
		id: "primary",
		provider: "provider-a",
		model: "model-a",
		protocol: "generation",
		tags: ["production", "fast"],
	},
	{
		id: "fallback",
		provider: "provider-b",
		model: "model-b",
		protocol: "generation",
		tags: ["production"],
	},
]

const completed = {
	type: "response.completed" as const,
	sequence_number: 0,
	response: { id: "response", status: "completed" } as never,
} satisfies Generation.GenerationEvent

it("filters candidates without mutating the deployment list", () => {
	const filtered = Routing.filterCandidates(candidates, {
		includeTags: ["fast"],
	})

	assert.deepEqual(
		filtered.map((candidate) => candidate.id),
		["primary"],
	)
	assert.deepEqual(
		candidates.map((candidate) => candidate.id),
		["primary", "fallback"],
	)
})

it.effect("fails early when a route has no eligible candidates", () =>
	Routing.selectCandidates<Routing.DeploymentRef, never>(
		request,
		candidates,
		{ includeTags: ["missing"] },
		undefined,
		undefined,
	).pipe(
		Effect.flip,
		Effect.tap((error) =>
			Effect.sync(() =>
				assert.equal((error as { readonly _tag?: string })._tag, "RoutingNoCandidates"),
			),
		),
	),
)

it("rejects duplicate candidate identifiers while building a routing context", () => {
	const result = Routing.makeContext(request, [candidates[0]!, candidates[0]!])

	assert.equal(result._tag, "Failure")
	if (Result.isFailure(result)) assert.equal(result.failure._tag, "RoutingInvalidCandidates")
})

it.effect("falls back when the first deployment fails before its first event", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make<Readonly<Record<string, number>>>({})
		const count = (id: string) =>
			Ref.update(calls, (current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }))
		const retryable = { retryable: true }
		const deployments: readonly Routing.ExecutableDeployment[] = [
			{
				...candidates[0]!,
				execute: () => count("primary").pipe(Effect.map(() => Stream.fail(retryable))),
			},
			{
				...candidates[1]!,
				execute: () => count("fallback").pipe(Effect.map(() => Stream.succeed(completed))),
			},
		]
		const stream = yield* Routing.executeWithFallback(request, deployments)
		const events = yield* Stream.runCollect(stream)
		const observed = yield* Ref.get(calls)

		assert.equal(events.length, 1)
		assert.equal(observed.primary, 1)
		assert.equal(observed.fallback, 1)
	}),
)

it.effect("does not replay after the first semantic event", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make<Readonly<Record<string, number>>>({})
		const count = (id: string) =>
			Ref.update(calls, (current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }))
		const terminalError = { retryable: true }
		const deployments: readonly Routing.ExecutableDeployment[] = [
			{
				...candidates[0]!,
				execute: () =>
					count("primary").pipe(
						Effect.map(() =>
							Stream.concat(Stream.succeed(completed), Stream.fail(terminalError)),
						),
					),
			},
			{
				...candidates[1]!,
				execute: () => count("fallback").pipe(Effect.map(() => Stream.succeed(completed))),
			},
		]
		const stream = yield* Routing.executeWithFallback(request, deployments)
		const failure = yield* Stream.runCollect(stream).pipe(Effect.flip)
		const observed = yield* Ref.get(calls)

		assert.equal(failure, terminalError)
		assert.equal(observed.primary, 1)
		assert.equal(observed.fallback ?? 0, 0)
	}),
)
