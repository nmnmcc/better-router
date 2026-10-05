import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Result } from "effect"
import * as Policies from "@better-router/core/Policies"
import type { GenerationRequest } from "@better-router/core/Generation"

const request: GenerationRequest = { model: "chat", input: [] }

const deployments: readonly Policies.DeploymentRef[] = [
	{
		id: "slow",
		provider: "provider-a",
		model: "model-a",
		protocol: "openai-chat-completions",
		weight: 1,
		pricing: { inputPerToken: 2, outputPerToken: 2 },
	},
	{
		id: "fast",
		provider: "provider-b",
		model: "model-b",
		protocol: "openai-chat-completions",
		weight: 3,
		pricing: { inputPerToken: 1, outputPerToken: 1 },
	},
	{
		id: "unknown-latency",
		provider: "provider-c",
		model: "model-c",
		protocol: "openai-chat-completions",
	},
]

const context: Policies.PolicyContext = {
	signals: {},
	metrics: {
		slow: {
			activeRequests: 2,
			latencyMs: 20,
			failureCount: 1,
			successCount: 4,
		},
		fast: {
			activeRequests: 0,
			latencyMs: 5,
			failureCount: 0,
			successCount: 3,
		},
	},
}

it("keeps simple strategy order and never mutates candidates", () => {
	const before = [...deployments]
	const ranked = Policies.simple.rank(request, deployments, context)

	assert.deepEqual(
		ranked.map((deployment) => deployment.id),
		["slow", "fast", "unknown-latency"],
	)
	assert.deepEqual(deployments, before)
})

it("orders weighted, least-busy, latency, and cost strategies", () => {
	assert.deepEqual(
		Policies.weighted.rank(request, deployments, context).map((deployment) => deployment.id),
		["fast", "slow", "unknown-latency"],
	)
	assert.deepEqual(
		Policies.leastBusy.rank(request, deployments, context).map((deployment) => deployment.id),
		["fast", "unknown-latency", "slow"],
	)
	assert.deepEqual(
		Policies.latency.rank(request, deployments, context).map((deployment) => deployment.id),
		["fast", "slow", "unknown-latency"],
	)
	assert.deepEqual(
		Policies.cost.rank(request, deployments, context).map((deployment) => deployment.id),
		["fast", "slow", "unknown-latency"],
	)
})

it.each([
	{ random: 0, first: "slow" },
	{ random: 0.249999, first: "slow" },
	{ random: 0.25, first: "fast" },
	{ random: 0.999999, first: "fast" },
])("selects weighted intervals at $random", ({ random, first }) => {
	const ranked = Policies.weighted.rank(request, deployments.slice(0, 2), {
		...context,
		signals: { "routing:random": random },
	})

	assert.equal(ranked[0]?.id, first)
})

it("distributes first choices proportionally and preserves fallback order and inputs", () => {
	const candidates = deployments.slice(0, 2)
	const before = structuredClone(deployments)
	const signals = { "routing:random": 0.5, unrelated: { value: "unchanged" } }
	const signalsBefore = structuredClone(signals)
	const choices = Array.from(
		{ length: 100 },
		(_, index) =>
			Policies.weighted.rank(request, candidates, {
				...context,
				signals: { "routing:random": index / 100 },
			})[0]?.id,
	)
	const ranked = Policies.weighted.rank(request, deployments, { ...context, signals })

	assert.equal(choices.filter((id) => id === "slow").length, 25)
	assert.equal(choices.filter((id) => id === "fast").length, 75)
	assert.deepEqual(
		ranked.map((candidate) => candidate.id),
		["fast", "slow", "unknown-latency"],
	)
	assert.deepEqual(deployments, before)
	assert.deepEqual(signals, signalsBefore)
	assert.equal(ranked[0], deployments[1])
})

it("treats an unspecified weight as one", () => {
	const candidates = [deployments[0]!, deployments[2]!]
	const ranked = Policies.weighted.rank(request, candidates, {
		...context,
		signals: { "routing:random": 0.5 },
	})

	assert.deepEqual(
		ranked.map((candidate) => candidate.id),
		["unknown-latency", "slow"],
	)
})

it("excludes zero-weight candidates while positive weights exist", () => {
	const candidates = deployments.map((candidate) => ({
		...candidate,
		weight: candidate.id === "fast" ? 3 : 0,
	}))
	const ranked = Policies.weighted.rank(request, candidates, {
		...context,
		signals: { "routing:random": 0 },
	})

	assert.deepEqual(
		ranked.map((candidate) => candidate.id),
		["fast"],
	)
})

it("uses uniform intervals for all-zero weights and handles empty candidates", () => {
	const candidates = deployments.slice(0, 2).map((candidate) => ({ ...candidate, weight: 0 }))
	const ranked = Policies.weighted.rank(request, candidates, {
		...context,
		signals: { "routing:random": 0.5 },
	})

	assert.deepEqual(
		ranked.map((candidate) => candidate.id),
		["fast", "slow"],
	)
	assert.deepEqual(Policies.weighted.rank(request, [], context), [])
	assert.equal(
		Policies.weighted.rank(request, candidates, {
			...context,
			signals: { "routing:random": 0.499999 },
		})[0]?.id,
		"slow",
	)
})

it.each([-1, 1, Number.NaN, Number.POSITIVE_INFINITY, "0", null, undefined])(
	"uses a deterministic default for an invalid random signal %s",
	(random) => {
		const ranked = Policies.weighted.rank(request, deployments, {
			...context,
			signals: { "routing:random": random },
		})

		assert.equal(ranked[0]?.id, "fast")
	},
)

it("keeps proportional selection finite when the unscaled weight sum would overflow", () => {
	const candidates = deployments.slice(0, 2).map((candidate) => ({
		...candidate,
		weight: Number.MAX_VALUE,
	}))
	const ranked = Policies.weighted.rank(request, candidates, {
		...context,
		signals: { "routing:random": 0 },
	})

	assert.equal(ranked[0]?.id, "slow")
})

it("rejects a strategy that escapes or duplicates the candidate set", () => {
	const invalid = {
		id: "invalid",
		rank: () => [
			deployments[0]!,
			deployments[0]!,
			{ id: "missing", provider: "x", model: "x", protocol: "openai-chat-completions" },
		],
	} satisfies Policies.Strategy
	const result = Policies.rank(invalid, request, deployments, context)

	assert.equal(result._tag, "Failure")
	if (Result.isFailure(result)) {
		assert.equal(result.failure._tag, "RoutingPolicyError")
		assert.equal(result.failure.id, "invalid")
	}
})

it("rejects duplicate strategy identifiers when building a registry", () => {
	const first = { id: "custom", rank: () => [] } satisfies Policies.Strategy
	const duplicate = Policies.makeRegistry([first, first])

	assert.equal(duplicate._tag, "Failure")
	if (Result.isFailure(duplicate)) {
		assert.equal(duplicate.failure._tag, "RoutingPolicyError")
		assert.equal(duplicate.failure.id, "custom")
	}
})
