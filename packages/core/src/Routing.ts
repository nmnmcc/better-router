import { Effect, Option, Result, Schema, Sink, Stream } from "effect"
import type { GenerationEvent, GenerationRequest } from "./Generation.js"
import type { CandidateMetrics, DeploymentRef, PolicyContext, Strategy } from "./Policies.js"
import * as Policies from "./Policies.js"

export type { CandidateMetrics, DeploymentRef, PolicyContext, Strategy } from "./Policies.js"

/** A model alias maps to an ordered set of private deployment IDs. */
export interface ModelRoute<Model extends string = string, Deployment extends string = string> {
	readonly model: Model
	readonly deployments: readonly Deployment[]
	readonly strategy?: string
	readonly policy?: RoutingPolicy
	readonly requiredTags?: readonly string[]
}

/** Runtime deployment shape required by the generation fallback executor. */
export type ExecutableDeployment<
	Ref extends DeploymentRef = DeploymentRef,
	ErrorType = unknown,
	Requirements = never,
> = Ref & {
	readonly execute: (
		request: GenerationRequest,
	) => Effect.Effect<
		Stream.Stream<GenerationEvent, ErrorType, Requirements>,
		ErrorType,
		Requirements
	>
}

export interface RoutingSignals {
	readonly [name: string]: unknown
}

export interface RoutingContext {
	readonly rawRequest: unknown
	readonly structuredRequest: GenerationRequest
	readonly model: string
	readonly candidateDeployments: readonly DeploymentRef[]
	readonly metadata: Readonly<Record<string, string>>
	readonly signals: RoutingSignals
	readonly metrics: Readonly<Record<string, CandidateMetrics | undefined>>
}

export interface CandidateFilter {
	readonly includeTags?: readonly string[] | undefined
	readonly excludeTags?: readonly string[] | undefined
	readonly excludeDeployments?: readonly string[] | undefined
	readonly includeProviders?: readonly string[] | undefined
	readonly excludeProviders?: readonly string[] | undefined
	readonly requiredCapabilities?: readonly string[] | undefined
}

export interface FilterableDeployment extends DeploymentRef {
	readonly capabilities?: readonly string[] | undefined
}

export class NoCandidates extends Schema.TaggedError<NoCandidates>()("RoutingNoCandidates", {
	model: Schema.String,
	message: Schema.String,
}) {}

export class InvalidCandidates extends Schema.TaggedError<InvalidCandidates>()(
	"RoutingInvalidCandidates",
	{
		model: Schema.String,
		message: Schema.String,
	},
) {}

export class PolicyFailed extends Schema.TaggedError<PolicyFailed>()("RoutingPolicyFailed", {
	id: Schema.String,
	message: Schema.String,
}) {}

export class FallbackExhausted extends Schema.TaggedError<FallbackExhausted>()(
	"RoutingFallbackExhausted",
	{
		model: Schema.String,
		attempts: Schema.Int,
	},
) {}

export class AccessDenied extends Schema.TaggedError<AccessDenied>()("RoutingAccessDenied", {
	model: Schema.String,
	message: Schema.String,
}) {}

export const Error = Schema.Union([
	NoCandidates,
	InvalidCandidates,
	PolicyFailed,
	FallbackExhausted,
	AccessDenied,
]).pipe(Schema.toTaggedUnion("_tag"))

export type RoutingError = typeof Error.Type

export interface RoutingPolicy<Requirements = never> {
	readonly id: string
	readonly rank: (
		request: GenerationRequest,
		candidates: readonly DeploymentRef[],
		context: PolicyContext,
	) => Effect.Effect<readonly DeploymentRef[], unknown, Requirements>
}

export interface CandidateSelection {
	readonly candidates: readonly DeploymentRef[]
	readonly context: RoutingContext
}

const includesEvery = (values: readonly string[], required: readonly string[]): boolean =>
	required.every((value) => values.includes(value))

/** Apply static tag/provider filters without changing the candidate input. */
export const filterCandidates = <Candidate extends FilterableDeployment>(
	candidates: readonly Candidate[],
	filter: CandidateFilter = {},
): readonly Candidate[] =>
	candidates.filter((candidate) => {
		const tags = candidate.tags ?? []
		const capabilities = candidate.capabilities ?? []
		return (
			(filter.includeTags === undefined || includesEvery(tags, filter.includeTags)) &&
			(filter.excludeTags === undefined ||
				!filter.excludeTags.some((tag) => tags.includes(tag))) &&
			(filter.excludeDeployments === undefined ||
				!filter.excludeDeployments.includes(candidate.id)) &&
			(filter.includeProviders === undefined ||
				filter.includeProviders.includes(candidate.provider)) &&
			(filter.excludeProviders === undefined ||
				!filter.excludeProviders.includes(candidate.provider)) &&
			(filter.requiredCapabilities === undefined ||
				includesEvery(capabilities, filter.requiredCapabilities))
		)
	})

const candidateIds = (candidates: readonly DeploymentRef[]): readonly string[] =>
	candidates.map((candidate) => candidate.id)

const invalidCandidate = (
	model: string,
	candidates: readonly DeploymentRef[],
	allowed: readonly DeploymentRef[] = candidates,
): Option.Option<InvalidCandidates> => {
	const invalid = candidates.find(
		(candidate, index) =>
			!allowed.some((entry) => entry.id === candidate.id) ||
			candidates.findIndex((entry) => entry.id === candidate.id) !== index,
	)
	return invalid === undefined
		? Option.none()
		: Option.some(
				InvalidCandidates.make({
					model,
					message: allowed.some((entry) => entry.id === invalid.id)
						? `Duplicate deployment candidate: ${invalid.id}`
						: `Unknown deployment candidate: ${invalid.id}`,
				}),
			)
}

/** Build a request context with an immutable signal map. */
export const makeContext = (
	request: GenerationRequest,
	candidates: readonly DeploymentRef[],
	metadata: Readonly<Record<string, string>> = request.metadata ?? {},
	signals: RoutingSignals = {},
	metrics: Readonly<Record<string, CandidateMetrics | undefined>> = {},
): Result.Result<RoutingContext, RoutingError> =>
	Option.match(invalidCandidate(request.model, candidates), {
		onNone: () =>
			Result.succeed({
				rawRequest: request,
				structuredRequest: request,
				model: request.model,
				candidateDeployments: [...candidates],
				metadata: { ...metadata },
				signals: { ...signals },
				metrics,
			}),
		onSome: Result.fail,
	})

const toPolicyContext = (context: RoutingContext): PolicyContext => ({
	signals: context.signals,
	metrics: context.metrics,
})

/** Select and validate an ordered candidate subset before an attempt starts. */
export const rankCandidates = <Requirements>(
	request: GenerationRequest,
	context: RoutingContext,
	strategy: Strategy | undefined,
	policy: RoutingPolicy<Requirements> | undefined,
): Effect.Effect<readonly DeploymentRef[], RoutingError, Requirements> => {
	return Effect.gen(function* () {
		if (context.candidateDeployments.length === 0)
			return yield* Effect.fail(
				NoCandidates.make({ model: request.model, message: "No deployment candidates" }),
			)
		const narrowed =
			policy === undefined
				? context.candidateDeployments
				: yield* Effect.suspend(() =>
						policy.rank(
							request,
							context.candidateDeployments,
							toPolicyContext(context),
						),
					).pipe(
						Effect.mapError((cause) =>
							PolicyFailed.make({ id: policy.id, message: String(cause) }),
						),
					)
		if (narrowed.length === 0)
			return yield* Effect.fail(
				NoCandidates.make({
					model: request.model,
					message: "Routing policy returned no candidates",
				}),
			)
		yield* Effect.fromResult(
			invalidCandidate(request.model, narrowed, context.candidateDeployments).pipe(
				Option.match({ onNone: () => Result.succeed(void 0), onSome: Result.fail }),
			),
		)
		const trusted = narrowed.flatMap((candidate) => {
			const value = context.candidateDeployments.find((entry) => entry.id === candidate.id)
			return value === undefined ? [] : [value]
		})
		return strategy === undefined
			? trusted
			: yield* Effect.fromResult(
					Policies.rank(strategy, request, trusted, toPolicyContext(context)),
				).pipe(
					Effect.mapError((error) =>
						PolicyFailed.make({ id: strategy.id, message: error.message }),
					),
				)
	})
}

/** Filter and rank in the same order as the request lifecycle. */
export const selectCandidates = <Candidate extends FilterableDeployment, Requirements>(
	request: GenerationRequest,
	candidates: readonly Candidate[],
	filter: CandidateFilter,
	strategy: Strategy | undefined,
	policy: RoutingPolicy<Requirements> | undefined,
): Effect.Effect<readonly Candidate[], RoutingError, Requirements> => {
	const filtered = filterCandidates(candidates, filter)
	return filtered.length === 0
		? Effect.fail(
				NoCandidates.make({
					model: request.model,
					message: "No deployment satisfies the route filter",
				}),
			)
		: Effect.fromResult(makeContext(request, filtered)).pipe(
				Effect.flatMap((context) => rankCandidates(request, context, strategy, policy)),
				Effect.map((ranked) =>
					ranked.flatMap((candidate) =>
						filtered.find((entry) => entry.id === candidate.id) === undefined
							? []
							: [filtered.find((entry) => entry.id === candidate.id)!],
					),
				),
			)
}

export interface FallbackOptions<ErrorType> {
	readonly shouldFallback?: (
		error: ErrorType,
		deployment: DeploymentRef,
		attempt: number,
	) => boolean
	readonly maxAttempts?: number
}

const defaultShouldFallback = (error: unknown): boolean =>
	typeof error !== "object" || error === null || !("retryable" in error)
		? true
		: (error as { readonly retryable?: unknown }).retryable !== false

const nextAttempt = <ErrorType>(
	error: ErrorType,
	deployment: DeploymentRef,
	attempt: number,
	options: FallbackOptions<ErrorType>,
): boolean =>
	(options.shouldFallback ?? ((value) => defaultShouldFallback(value)))(
		error,
		deployment,
		attempt,
	)

/**
 * Execute ordered deployments while preserving the first semantic event
 * boundary.  A provider may fail while opening or before emitting an event;
 * only then can the next deployment be attempted. Once the first event is
 * observed, all subsequent stream errors are forwarded unchanged.
 */
export const executeWithFallback = <ErrorType, Requirements = never>(
	request: GenerationRequest,
	deployments: readonly ExecutableDeployment<DeploymentRef, ErrorType, Requirements>[],
	options: FallbackOptions<ErrorType> = {},
): Effect.Effect<
	Stream.Stream<GenerationEvent, ErrorType | RoutingError, Requirements>,
	ErrorType | RoutingError,
	Requirements
> => {
	const limit = Math.max(1, options.maxAttempts ?? deployments.length)
	const attempt = (
		index: number,
	): Effect.Effect<
		Stream.Stream<GenerationEvent, ErrorType | RoutingError, Requirements>,
		ErrorType | RoutingError,
		Requirements
	> => {
		const deployment = deployments[index]
		if (deployment === undefined || index >= limit)
			return Effect.fail(FallbackExhausted.make({ model: request.model, attempts: index }))
		const hasNext = (): boolean => index + 1 < deployments.length && index + 1 < limit
		const canContinue = (error: ErrorType): boolean =>
			hasNext() && nextAttempt(error, deployment, index, options)
		const open = Effect.gen(function* () {
			const opened = yield* Effect.result(deployment.execute(request))
			if (Result.isFailure(opened))
				return yield* canContinue(opened.failure)
					? attempt(index + 1)
					: Effect.fail(opened.failure)
			const peeled = yield* Effect.result(
				Stream.peel(opened.success, Sink.head<GenerationEvent>()),
			)
			if (Result.isFailure(peeled))
				return yield* canContinue(peeled.failure)
					? attempt(index + 1)
					: Effect.fail(peeled.failure)
			return yield* Option.match(peeled.success[0], {
				onNone: () => (hasNext() ? attempt(index + 1) : Effect.succeed(Stream.empty)),
				onSome: (event) =>
					Effect.succeed(Stream.concat(Stream.succeed(event), peeled.success[1])),
			})
		})
		return Effect.succeed(Stream.unwrap(open)) as unknown as Effect.Effect<
			Stream.Stream<GenerationEvent, ErrorType | RoutingError, Requirements>,
			ErrorType | RoutingError,
			Requirements
		>
	}
	return deployments.length === 0
		? Effect.fail(FallbackExhausted.make({ model: request.model, attempts: 0 }))
		: attempt(0)
}

/** A small helper for hosts that want a policy signal without rebuilding context. */
export const addSignal = (
	context: RoutingContext,
	key: string,
	value: unknown,
): RoutingContext => ({
	...context,
	signals: { ...context.signals, [key]: value },
})

/** Extract IDs for diagnostics and persistence keys. */
export const ids = (candidates: readonly DeploymentRef[]): readonly string[] =>
	candidateIds(candidates)

export const Routing = {
	filterCandidates,
	makeContext,
	selectCandidates,
	rankCandidates,
	executeWithFallback,
	addSignal,
	ids,
}
