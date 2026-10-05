import { Option, Result, Schema } from "effect"
import type { GenerationRequest } from "./Generation.js"
import type { DeploymentRef as CoreDeploymentRef } from "./Deployment.js"

/**
 * A deployment reference is deliberately smaller than an executable
 * deployment.  Policies only need stable identity and routing metadata; they
 * must never receive credentials or provider clients.
 */
export interface DeploymentRef extends CoreDeploymentRef {
	readonly weight?: number | undefined
	readonly tags?: readonly string[] | undefined
	readonly pricing?:
		| {
				readonly inputPerToken?: number | undefined
				readonly outputPerToken?: number | undefined
				readonly input?: number | undefined
				readonly output?: number | undefined
		  }
		| undefined
	readonly limits?:
		| {
				readonly maxConcurrency?: number | undefined
				readonly maxConcurrent?: number | undefined
				readonly requestsPerMinute?: number | undefined
				readonly tokensPerMinute?: number | undefined
				readonly rpm?: number | undefined
				readonly tpm?: number | undefined
				readonly maxTokens?: number | undefined
		  }
		| undefined
}

export interface CandidateMetrics {
	readonly activeRequests: number
	readonly latencyMs?: number
	readonly inputTokens?: number
	readonly outputTokens?: number
	readonly failureCount: number
	readonly successCount: number
}

export interface PolicyContext {
	readonly signals: Readonly<Record<string, unknown>>
	readonly metrics: Readonly<Record<string, CandidateMetrics | undefined>>
}

export class Error extends Schema.TaggedError<Error>()("RoutingPolicyError", {
	id: Schema.String,
	message: Schema.String,
}) {}

export type RoutingPolicyError = typeof Error.Type

export interface Strategy {
	readonly id: string
	readonly rank: (
		request: GenerationRequest,
		candidates: readonly DeploymentRef[],
		context: PolicyContext,
	) => readonly DeploymentRef[]
}

export type RoutingPolicy = Strategy

const metric = (context: PolicyContext, deployment: DeploymentRef): CandidateMetrics =>
	context.metrics[deployment.id] ?? {
		activeRequests: 0,
		failureCount: 0,
		successCount: 0,
	}

const weight = (deployment: DeploymentRef): number =>
	deployment.weight === undefined || !Number.isFinite(deployment.weight)
		? 1
		: Math.max(0, deployment.weight)

const WeightedRandom = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(1))

/** Hosts supply randomness; pure callers have a deterministic midpoint default. */
const weightedRandom = (context: PolicyContext): number => {
	const decoded = Schema.decodeUnknownResult(WeightedRandom)(context.signals["routing:random"])
	return Result.isSuccess(decoded) ? decoded.success : 0.5
}

const price = (deployment: DeploymentRef): number => {
	const pricing = deployment.pricing
	if (pricing === undefined) return Number.POSITIVE_INFINITY
	return (
		(pricing.inputPerToken ?? pricing.input ?? 0) +
		(pricing.outputPerToken ?? pricing.output ?? 0)
	)
}

const compareNumbers = (left: number, right: number): number =>
	left < right ? -1 : left > right ? 1 : 0

const compareIds = (left: DeploymentRef, right: DeploymentRef): number =>
	left.id < right.id ? -1 : left.id > right.id ? 1 : 0

/** Insert into an ordered array without mutating the input array. */
const insert = (
	values: readonly DeploymentRef[],
	value: DeploymentRef,
	compare: (left: DeploymentRef, right: DeploymentRef) => number,
): readonly DeploymentRef[] => {
	const first = values[0]
	return first === undefined || compare(value, first) < 0
		? [value, ...values]
		: [first, ...insert(values.slice(1), value, compare)]
}

const orderBy = (
	values: readonly DeploymentRef[],
	compare: (left: DeploymentRef, right: DeploymentRef) => number,
): readonly DeploymentRef[] =>
	values.reduce<readonly DeploymentRef[]>(
		(previous, value) => insert(previous, value, compare),
		[],
	)

const tieBreak =
	(primary: (value: DeploymentRef) => number) =>
	(left: DeploymentRef, right: DeploymentRef): number => {
		const compared = compareNumbers(primary(left), primary(right))
		return compared === 0 ? compareIds(left, right) : compared
	}

/** Preserve configured fallback order. */
export const simple: Strategy = {
	id: "simple",
	rank: (_request, candidates) => [...candidates],
}

/**
 * Select the first candidate proportionally, preserving remaining fallback
 * order. Zero weights are ineligible while positive weights exist; an all-zero
 * candidate set uses equal weights. Randomness comes from `routing:random`.
 */
export const weighted: Strategy = {
	id: "weighted",
	rank: (_request, candidates, context) => {
		const first = candidates[0]
		if (first === undefined) return []
		const positive = candidates.filter((candidate) => weight(candidate) > 0)
		const eligible = positive.length === 0 ? candidates : positive
		const maximum = eligible.reduce(
			(previous, candidate) => Math.max(previous, weight(candidate)),
			0,
		)
		const scaledWeight = (candidate: DeploymentRef): number =>
			maximum === 0 ? 1 : weight(candidate) / maximum
		const total = eligible.reduce(
			(previous, candidate) => previous + scaledWeight(candidate),
			0,
		)
		const threshold = weightedRandom(context) * total
		const sampled = eligible.reduce<{
			readonly cumulative: number
			readonly selected: Option.Option<DeploymentRef>
		}>(
			(previous, candidate) => {
				const cumulative = previous.cumulative + scaledWeight(candidate)
				return {
					cumulative,
					selected: Option.isSome(previous.selected)
						? previous.selected
						: threshold < cumulative
							? Option.some(candidate)
							: Option.none(),
				}
			},
			{ cumulative: 0, selected: Option.none() },
		)
		const selected = Option.getOrElse(
			sampled.selected,
			() => eligible[eligible.length - 1] ?? first,
		)
		return [selected, ...eligible.filter((candidate) => candidate.id !== selected.id)]
	},
}

/** Prefer deployments with the fewest in-flight requests. */
export const leastBusy: Strategy = {
	id: "least-busy",
	rank: (_request, candidates, context) =>
		orderBy(
			candidates,
			tieBreak((deployment) => metric(context, deployment).activeRequests),
		),
}

/** Prefer deployments with the lowest known latency; unknown latency is last. */
export const latency: Strategy = {
	id: "latency",
	rank: (_request, candidates, context) =>
		orderBy(
			candidates,
			tieBreak(
				(deployment) => metric(context, deployment).latencyMs ?? Number.POSITIVE_INFINITY,
			),
		),
}

/** Prefer deployments with the lowest configured token price. */
export const cost: Strategy = {
	id: "cost",
	rank: (_request, candidates) => orderBy(candidates, tieBreak(price)),
}

export const builtIns: readonly Strategy[] = [simple, weighted, leastBusy, latency, cost]

export const strategies = {
	simple,
	weighted,
	leastBusy,
	latency,
	cost,
} as const

export interface StrategyRegistry {
	readonly strategies: readonly Strategy[]
	readonly get: (id: string) => Strategy | undefined
}

const duplicateStrategy = (id: string): RoutingPolicyError =>
	Error.make({ id, message: `Duplicate routing strategy: ${id}` })

/** Build an immutable strategy registry and reject duplicate IDs up front. */
export const makeRegistry = (
	strategies: readonly Strategy[] = builtIns,
): Result.Result<StrategyRegistry, RoutingPolicyError> => {
	const checked = strategies.reduce<Result.Result<readonly Strategy[], RoutingPolicyError>>(
		(previous, strategy) =>
			Result.flatMap(previous, (values) =>
				values.some((value) => value.id === strategy.id)
					? Result.fail(duplicateStrategy(strategy.id))
					: Result.succeed([...values, strategy]),
			),
		Result.succeed([]),
	)
	return Result.map(checked, (values) => ({
		strategies: values,
		get: (id: string) => values.find((strategy) => strategy.id === id),
	}))
}

export const registry = makeRegistry()

export const strategyRegistry = registry

/** Run a strategy and keep its output constrained to the input candidates. */
export const rank = (
	strategy: Strategy,
	request: GenerationRequest,
	candidates: readonly DeploymentRef[],
	context: PolicyContext,
): Result.Result<readonly DeploymentRef[], RoutingPolicyError> => {
	const ranked = strategy.rank(request, candidates, context)
	const invalid = ranked.find(
		(candidate, index) =>
			!candidates.some((entry) => entry.id === candidate.id) ||
			ranked.findIndex((entry) => entry.id === candidate.id) !== index,
	)
	return invalid === undefined
		? Result.succeed(ranked)
		: Result.fail(
				Error.make({
					id: strategy.id,
					message: `Strategy returned an unknown or duplicate deployment: ${invalid.id}`,
				}),
			)
}
