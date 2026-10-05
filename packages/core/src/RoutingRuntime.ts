import { Clock, Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import type { GenerationRequest, GenerationUsage } from "./Generation.js"
import type { DeploymentConfig, DeploymentRef } from "./Deployment.js"
import * as Deployment from "./Deployment.js"
import { Request as GenerationRequestSchema } from "./GenerationSchema.js"
import type { CandidateMetrics } from "./Policies.js"
import * as Persistence from "./Persistence.js"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

const BudgetSchema = Schema.Struct({
	key: Schema.optional(Schema.NonEmptyString),
	limit: NonNegativeNumber,
	reservation: Schema.optional(NonNegativeNumber),
})

const UsageSchema = Schema.Struct({
	input_tokens: NonNegativeInt,
	output_tokens: NonNegativeInt,
	total_tokens: NonNegativeInt,
	input_tokens_details: Schema.Struct({ cached_tokens: NonNegativeInt }),
	output_tokens_details: Schema.Struct({ reasoning_tokens: NonNegativeInt }),
})

const OutcomeSchema = Schema.Struct({
	_tag: Schema.Literals(["success", "failure", "cancelled"]),
	latencyMs: Schema.optional(NonNegativeNumber),
	usage: Schema.optional(Schema.NullOr(UsageSchema)),
	error: Schema.optional(Schema.Unknown),
	cooldownMillis: Schema.optional(NonNegativeNumber),
})

const AccountingRequestSchema = Schema.Struct({
	request: GenerationRequestSchema,
	limits: Schema.Struct({ max_output_tokens: Schema.optional(Schema.NullOr(NonNegativeInt)) }),
})

const RuntimeDeploymentSchema = Schema.Struct({
	deployment: Deployment.DeploymentConfigSchema,
	pricing: Schema.optional(
		Schema.Struct({
			inputPerToken: Schema.optional(NonNegativeNumber),
			outputPerToken: Schema.optional(NonNegativeNumber),
			input: Schema.optional(NonNegativeNumber),
			output: Schema.optional(NonNegativeNumber),
		}),
	),
})

/** The durable state for one configured deployment. */
export const deploymentStateSchema = Schema.Struct({
	activeRequests: NonNegativeInt,
	failureCount: NonNegativeInt,
	successCount: NonNegativeInt,
	healthy: Schema.Boolean,
	cooldownUntil: NonNegativeNumber,
	latencyMs: Schema.optional(NonNegativeNumber),
	inputTokens: NonNegativeInt,
	outputTokens: NonNegativeInt,
	totalCost: NonNegativeNumber,
	reservedTokens: NonNegativeInt,
	reservedCost: NonNegativeNumber,
	requestsInWindow: NonNegativeInt,
	tokensInWindow: NonNegativeInt,
	windowStartedAt: NonNegativeNumber,
})

const budgetStateSchema = Schema.Struct({
	spent: NonNegativeNumber,
	reserved: NonNegativeNumber,
})

const reservationStateSchema = Schema.Struct({
	deploymentId: Schema.NonEmptyString,
	estimatedInputTokens: NonNegativeInt,
	estimatedOutputTokens: NonNegativeInt,
	estimatedTokens: NonNegativeInt,
	estimatedCost: NonNegativeNumber,
	reservedCost: NonNegativeNumber,
	budgetKey: Schema.optional(Schema.NonEmptyString),
	budgetReservation: NonNegativeNumber,
	startedWallMillis: NonNegativeNumber,
})

/** The single persisted snapshot. All reserve/finish transitions write this atomically. */
export const stateSchema = Schema.Struct({
	deployments: Schema.Record(Schema.String, deploymentStateSchema),
	budgets: Schema.Record(Schema.String, budgetStateSchema),
	reservations: Schema.Record(Schema.String, reservationStateSchema),
	nextReservationId: NonNegativeInt,
})

export type DeploymentState = typeof deploymentStateSchema.Type
export type BudgetState = typeof budgetStateSchema.Type
export type ReservationState = typeof reservationStateSchema.Type
export type RuntimeState = typeof stateSchema.Type

/** Stable persistence namespace for runtime health, limits and accounting. */
export const declaration = {
	namespace: "routing.runtime",
	schema: stateSchema,
	version: 1,
} as const

/** Structured runtime failures preserve the underlying StoreError or Schema issue tree. */
export class Error extends Schema.TaggedError<Error>()("RoutingRuntimeError", {
	kind: Schema.Literals([
		"store",
		"deployment",
		"capacity",
		"rate_limit",
		"token_limit",
		"budget",
		"reservation",
		"invalid",
	]),
	message: Schema.String,
	retryable: Schema.Boolean,
	deployment: Schema.optional(Schema.String),
	limit: Schema.optional(Schema.Number),
	actual: Schema.optional(Schema.Number),
	cause: Schema.optional(Schema.Defect({ excludeCause: true })),
	issues: Schema.optional(Schema.Unknown),
}) {}

export type RuntimeError = typeof Error.Type
export const RuntimeError = Error

export interface HealthState extends CandidateMetrics {
	readonly healthy: boolean
	readonly cooldownUntil: number
	readonly reservedTokens: number
	readonly reservedCost: number
	readonly requestsInWindow: number
	readonly tokensInWindow: number
	readonly totalCost: number
}

export interface RuntimeBudget {
	readonly key?: string | undefined
	readonly limit: number
	readonly reservation?: number | undefined
}

export type ReservationOutcome = {
	readonly _tag: "success" | "failure" | "cancelled"
	readonly latencyMs?: number | undefined
	readonly usage?: GenerationUsage | null | undefined
	readonly error?: unknown
	readonly cooldownMillis?: number | undefined
}

const ReservationOwner = Symbol("BetterRouterRoutingReservationOwner")

/** A reservation is a linear capability: only its first finish can settle it. */
export interface AttemptReservation {
	readonly [ReservationOwner]: object
	readonly id: string
	readonly deployment: DeploymentConfig
	readonly deploymentId: string
	readonly startedAt: number
	readonly startedWallMillis: number
	readonly startedMonotonicMillis: number
	readonly estimatedInputTokens: number
	readonly estimatedOutputTokens: number
	readonly estimatedTokens: number
	readonly estimatedCost: number
	readonly reservedCost: number
	readonly budgetKey?: string | undefined
	readonly budgetReservation: number
}

export interface RuntimeService {
	readonly snapshot: Effect.Effect<Readonly<Record<string, HealthState>>, RuntimeError>
	readonly state: (id: string) => Effect.Effect<HealthState, RuntimeError>
	readonly metrics: Effect.Effect<
		Readonly<Record<string, CandidateMetrics | undefined>>,
		RuntimeError
	>
	readonly available: <Candidate extends DeploymentRef>(
		candidates: readonly Candidate[],
	) => Effect.Effect<readonly Candidate[], RuntimeError>
	readonly reserve: (
		deployment: DeploymentConfig,
		request: GenerationRequest,
		budget?: RuntimeBudget,
	) => Effect.Effect<AttemptReservation, RuntimeError>
	readonly finish: (
		reservation: AttemptReservation,
		outcome: ReservationOutcome,
	) => Effect.Effect<void, RuntimeError>
}

export class RoutingRuntime extends Context.Service<RoutingRuntime, RuntimeService>()(
	"BetterRouterRoutingRuntime",
) {}

const emptyDeploymentState = (now: number): DeploymentState => ({
	activeRequests: 0,
	failureCount: 0,
	successCount: 0,
	healthy: true,
	cooldownUntil: 0,
	inputTokens: 0,
	outputTokens: 0,
	totalCost: 0,
	reservedTokens: 0,
	reservedCost: 0,
	requestsInWindow: 0,
	tokensInWindow: 0,
	windowStartedAt: now,
})

const emptySnapshot = (): RuntimeState => ({
	deployments: {},
	budgets: {},
	reservations: {},
	nextReservationId: 0,
})

const resetWindow = (state: DeploymentState, now: number): DeploymentState =>
	now >= state.windowStartedAt + 60_000
		? {
				...state,
				requestsInWindow: 0,
				tokensInWindow: 0,
				windowStartedAt: now,
			}
		: state

const recoverCooldown = (state: DeploymentState, now: number): DeploymentState =>
	state.cooldownUntil > 0 && state.cooldownUntil <= now
		? { ...state, healthy: true, cooldownUntil: 0 }
		: state

const resetOnStartup = (state: DeploymentState, now: number): DeploymentState => ({
	...resetWindow(state, now),
	activeRequests: 0,
	reservedTokens: 0,
	reservedCost: 0,
})

const normalizeSnapshot = (
	loaded: RuntimeState | undefined,
	deployments: readonly DeploymentConfig[],
	now: number,
): RuntimeState => {
	// A replacement runtime owns this namespace. Its startup boundary is the
	// recovery point for attempts that could not be finalized before shutdown.
	const source = loaded ?? emptySnapshot()
	const values = deployments.reduce<Record<string, DeploymentState>>(
		(previous, deployment) => ({
			...previous,
			[deployment.id]: resetOnStartup(
				own(source.deployments, deployment.id) ?? emptyDeploymentState(now),
				now,
			),
		}),
		{},
	)
	const budgets = Object.fromEntries(
		Object.entries(source.budgets).map(([key, value]) => [key, { ...value, reserved: 0 }]),
	) as Readonly<Record<string, BudgetState>>
	return {
		deployments: values,
		budgets,
		reservations: {},
		nextReservationId: source.nextReservationId,
	}
}

const healthState = (state: DeploymentState | undefined, now: number): HealthState => {
	const value = recoverCooldown(resetWindow(state ?? emptyDeploymentState(now), now), now)
	return {
		activeRequests: value.activeRequests,
		failureCount: value.failureCount,
		successCount: value.successCount,
		healthy: value.healthy,
		cooldownUntil: value.cooldownUntil,
		reservedTokens: value.reservedTokens,
		reservedCost: value.reservedCost,
		requestsInWindow: value.requestsInWindow,
		tokensInWindow: value.tokensInWindow,
		totalCost: value.totalCost,
		...(value.latencyMs === undefined ? {} : { latencyMs: value.latencyMs }),
		...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
		...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
	}
}

const metricsOf = (state: HealthState): CandidateMetrics => ({
	activeRequests: state.activeRequests,
	failureCount: state.failureCount,
	successCount: state.successCount,
	...(state.latencyMs === undefined ? {} : { latencyMs: state.latencyMs }),
	...(state.inputTokens === undefined ? {} : { inputTokens: state.inputTokens }),
	...(state.outputTokens === undefined ? {} : { outputTokens: state.outputTokens }),
})

interface LimitedDeployment {
	readonly limits?:
		| {
				readonly maxConcurrent?: number | undefined
				readonly rpm?: number | undefined
				readonly tpm?: number | undefined
				readonly maxTokens?: number | undefined
				readonly maxConcurrency?: number | undefined
				readonly requestsPerMinute?: number | undefined
				readonly tokensPerMinute?: number | undefined
		  }
		| undefined
}

const limitOf = (
	deployment: LimitedDeployment,
	field: "maxConcurrent" | "rpm" | "tpm" | "maxTokens",
): number | undefined => {
	const limits = deployment.limits
	if (limits === undefined) return undefined
	if (field === "maxConcurrent") {
		return limits.maxConcurrent ?? limits.maxConcurrency
	}
	if (field === "rpm") {
		return limits.rpm ?? limits.requestsPerMinute
	}
	if (field === "tpm") {
		return limits.tpm ?? limits.tokensPerMinute
	}
	return limits.maxTokens
}

const estimateInputTokens = (request: GenerationRequest): number =>
	Math.ceil(
		((typeof request.input === "string"
			? request.input.length
			: request.input === null || request.input === undefined
				? 0
				: JSON.stringify(request.input).length) +
			(request.instructions?.length ?? 0) +
			(request.tools === null || request.tools === undefined
				? 0
				: JSON.stringify(request.tools).length)) /
			4,
	)

const estimate = (
	deployment: DeploymentConfig,
	request: GenerationRequest,
): Readonly<{ inputTokens: number; outputTokens: number; tokens: number; cost: number }> => {
	const inputTokens = estimateInputTokens(request)
	const maxTokens = deployment.limits?.maxTokens
	const remainingTokens =
		maxTokens === undefined ? undefined : Math.max(0, maxTokens - inputTokens)
	const outputTokens = Math.max(
		0,
		request.max_output_tokens ??
			(deployment.limits?.maxOutputTokens === undefined
				? Math.min(1024, remainingTokens ?? 1024)
				: Math.min(
						deployment.limits.maxOutputTokens,
						remainingTokens ?? deployment.limits.maxOutputTokens,
					)),
	)
	const inputPrice = Math.max(
		0,
		deployment.pricing?.inputPerToken ?? deployment.pricing?.input ?? 0,
	)
	const outputPrice = Math.max(
		0,
		deployment.pricing?.outputPerToken ?? deployment.pricing?.output ?? 0,
	)
	return {
		inputTokens,
		outputTokens,
		tokens: inputTokens + outputTokens,
		cost: inputTokens * inputPrice + outputTokens * outputPrice,
	}
}

const usageValues = (
	usage: GenerationUsage | null | undefined,
	fallback: Readonly<{ inputTokens: number; outputTokens: number }>,
): Readonly<{ inputTokens: number; outputTokens: number }> => ({
	inputTokens:
		usage === null || usage === undefined
			? fallback.inputTokens
			: Math.max(0, Math.floor(usage.input_tokens)),
	outputTokens:
		usage === null || usage === undefined
			? fallback.outputTokens
			: Math.max(0, Math.floor(usage.output_tokens)),
})

const runtimeError = (
	kind: RuntimeError["kind"],
	message: string,
	options: Readonly<{
		deployment?: string
		limit?: number
		actual?: number
		cause?: unknown
		issues?: unknown
	}> = {},
): RuntimeError =>
	Error.make({
		kind,
		message,
		retryable: kind === "capacity" || kind === "rate_limit",
		...(options.deployment === undefined ? {} : { deployment: options.deployment }),
		...(options.limit === undefined ? {} : { limit: options.limit }),
		...(options.actual === undefined ? {} : { actual: options.actual }),
		...(options.cause === undefined ? {} : { cause: options.cause }),
		...(options.issues === undefined ? {} : { issues: options.issues }),
	})

const persistenceError = (cause: unknown): RuntimeError =>
	runtimeError("store", "Runtime persistence operation failed", {
		cause,
		issues: Schema.isSchemaError(cause) ? cause.issue : undefined,
	})

const asRuntimeEffect = <A>(
	effect: Effect.Effect<A, Persistence.StoreError>,
): Effect.Effect<A, RuntimeError> => effect.pipe(Effect.mapError(persistenceError))

const isRuntimeError = (cause: unknown): cause is RuntimeError =>
	typeof cause === "object" &&
	cause !== null &&
	"_tag" in cause &&
	cause._tag === "RoutingRuntimeError"

const own = <A>(record: Readonly<Record<string, A>>, key: string): A | undefined =>
	Object.hasOwn(record, key) ? record[key] : undefined

const deploymentIndex = (
	deployments: readonly DeploymentConfig[],
): Readonly<Record<string, DeploymentConfig>> =>
	deployments.reduce<Record<string, DeploymentConfig>>(
		(previous, deployment) => ({ ...previous, [deployment.id]: deployment }),
		{},
	)

const budgetKeyOf = (
	request: GenerationRequest,
	budget: RuntimeBudget | undefined,
): string | undefined =>
	budget === undefined
		? undefined
		: request.metadata === null || request.metadata === undefined
			? request.model
			: (own(request.metadata, budget.key ?? "tenant") ?? request.model)

const parse = <S extends Schema.Constraint>(
	schema: S,
	value: unknown,
): Effect.Effect<S["Type"], RuntimeError, S["DecodingServices"]> =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError((cause) =>
			runtimeError("invalid", "Invalid runtime accounting input", {
				cause,
				issues: cause.issue,
			}),
		),
	)

const makeDurable = (
	rawDeployments: readonly DeploymentConfig[],
): Effect.Effect<RuntimeService, RuntimeError, Persistence.Persistence> =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		const deployments = yield* parse(
			Schema.Array(Deployment.DeploymentConfigSchema),
			rawDeployments,
		)
		yield* parse(
			Schema.Array(RuntimeDeploymentSchema),
			deployments.map((deployment) => ({
				deployment,
				...(deployment.pricing === undefined ? {} : { pricing: deployment.pricing }),
			})),
		)
		const initialNow = yield* Clock.currentTimeMillis
		const normalized = yield* asRuntimeEffect(
			store.transaction(
				Effect.gen(function* () {
					const persisted = yield* store.get("snapshot")
					const normalized = normalizeSnapshot(
						Option.isSome(persisted) ? persisted.value : undefined,
						deployments,
						initialNow,
					)
					yield* store.set("snapshot", normalized)
					return normalized
				}),
			),
		)
		const configured = deploymentIndex(deployments)
		const semaphore = yield* Semaphore.make(1)
		const reservationOwner = {} as const
		const runtimeId = `${initialNow}:${deployments.map((deployment) => deployment.id).join(",")}`
		const read = (): Effect.Effect<RuntimeState, RuntimeError> =>
			asRuntimeEffect(store.get("snapshot")).pipe(
				Effect.map((value) => (Option.isSome(value) ? value.value : normalized)),
			)
		const write = (value: RuntimeState): Effect.Effect<void, RuntimeError> =>
			asRuntimeEffect(store.set("snapshot", value))
		const atomic = <A>(
			effect: Effect.Effect<A, RuntimeError>,
		): Effect.Effect<A, RuntimeError> =>
			semaphore.withPermit(
				store
					.transaction(effect)
					.pipe(
						Effect.mapError((cause) =>
							isRuntimeError(cause) ? cause : persistenceError(cause),
						),
					),
			)
		const snapshot = Effect.gen(function* () {
			const current = yield* read()
			const now = yield* Clock.currentTimeMillis
			return Object.fromEntries(
				deployments.map((deployment) => [
					deployment.id,
					healthState(own(current.deployments, deployment.id), now),
				]),
			) as Readonly<Record<string, HealthState>>
		})
		const state = (id: string): Effect.Effect<HealthState, RuntimeError> =>
			Effect.gen(function* () {
				const current = yield* read()
				return healthState(own(current.deployments, id), yield* Clock.currentTimeMillis)
			})
		const metrics = snapshot.pipe(
			Effect.map((current) =>
				Object.fromEntries(
					Object.entries(current).map(([id, value]) => [id, metricsOf(value)]),
				),
			),
		)
		const available = <Candidate extends DeploymentRef>(
			candidates: readonly Candidate[],
		): Effect.Effect<readonly Candidate[], RuntimeError> =>
			Effect.gen(function* () {
				const current = yield* read()
				const now = yield* Clock.currentTimeMillis
				return candidates.filter((candidate) => {
					const source: LimitedDeployment =
						own(configured, candidate.id) ?? (candidate as LimitedDeployment)
					const value = recoverCooldown(
						resetWindow(
							own(current.deployments, candidate.id) ?? emptyDeploymentState(now),
							now,
						),
						now,
					)
					const max = limitOf(source, "maxConcurrent")
					const rpm = limitOf(source, "rpm")
					const tpm = limitOf(source, "tpm")
					return (
						value.healthy &&
						value.cooldownUntil <= now &&
						(max === undefined || value.activeRequests < max) &&
						(rpm === undefined || value.requestsInWindow < rpm) &&
						(tpm === undefined || value.tokensInWindow + value.reservedTokens < tpm)
					)
				})
			})
		const reserve = (
			deployment: DeploymentConfig,
			request: GenerationRequest,
			budget?: RuntimeBudget,
		): Effect.Effect<AttemptReservation, RuntimeError> => {
			const selected = own(configured, deployment.id)
			if (selected === undefined)
				return Effect.fail(
					runtimeError("deployment", `Unknown deployment: ${deployment.id}`, {
						deployment: deployment.id,
					}),
				)
			return atomic(
				Effect.gen(function* () {
					const decoded = yield* parse(AccountingRequestSchema, {
						request,
						limits: { max_output_tokens: request.max_output_tokens },
					})
					if (budget !== undefined) yield* parse(BudgetSchema, budget)
					const amounts = estimate(selected, decoded.request)
					const budgetKey = budgetKeyOf(decoded.request, budget)
					const budgetReservation = budget?.reservation ?? amounts.cost
					const current = yield* read()
					const now = yield* Clock.currentTimeMillis
					const value = recoverCooldown(
						resetWindow(
							own(current.deployments, selected.id) ?? emptyDeploymentState(now),
							now,
						),
						now,
					)
					if (!value.healthy)
						return yield* Effect.fail(
							runtimeError("capacity", "Deployment is unhealthy", {
								deployment: selected.id,
							}),
						)
					const max = limitOf(selected, "maxConcurrent")
					const rpm = limitOf(selected, "rpm")
					const tpm = limitOf(selected, "tpm")
					const maxTokens = limitOf(selected, "maxTokens")
					const maxInputTokens = selected.limits?.maxInputTokens
					const maxOutputTokens = selected.limits?.maxOutputTokens
					if (value.cooldownUntil > now)
						return yield* Effect.fail(
							runtimeError("capacity", "Deployment is cooling down", {
								deployment: selected.id,
								limit: value.cooldownUntil,
								actual: now,
							}),
						)
					if (max !== undefined && value.activeRequests >= max)
						return yield* Effect.fail(
							runtimeError("capacity", "Deployment concurrency limit reached", {
								deployment: selected.id,
								limit: max,
								actual: value.activeRequests,
							}),
						)
					if (rpm !== undefined && value.requestsInWindow >= rpm)
						return yield* Effect.fail(
							runtimeError(
								"rate_limit",
								"Deployment requests-per-minute limit reached",
								{
									deployment: selected.id,
									limit: rpm,
									actual: value.requestsInWindow,
								},
							),
						)
					if (
						tpm !== undefined &&
						value.tokensInWindow + value.reservedTokens + amounts.tokens > tpm
					)
						return yield* Effect.fail(
							runtimeError(
								"rate_limit",
								"Deployment tokens-per-minute limit reached",
								{
									deployment: selected.id,
									limit: tpm,
									actual:
										value.tokensInWindow +
										value.reservedTokens +
										amounts.tokens,
								},
							),
						)
					if (maxTokens !== undefined && amounts.tokens > maxTokens)
						return yield* Effect.fail(
							runtimeError("token_limit", "Deployment maximum token limit exceeded", {
								deployment: selected.id,
								limit: maxTokens,
								actual: amounts.tokens,
							}),
						)
					if (maxInputTokens !== undefined && amounts.inputTokens > maxInputTokens)
						return yield* Effect.fail(
							runtimeError("token_limit", "Deployment input token limit exceeded", {
								deployment: selected.id,
								limit: maxInputTokens,
								actual: amounts.inputTokens,
							}),
						)
					if (maxOutputTokens !== undefined && amounts.outputTokens > maxOutputTokens)
						return yield* Effect.fail(
							runtimeError("token_limit", "Deployment output token limit exceeded", {
								deployment: selected.id,
								limit: maxOutputTokens,
								actual: amounts.outputTokens,
							}),
						)
					const currentBudget =
						budgetKey === undefined
							? { spent: 0, reserved: 0 }
							: (own(current.budgets, budgetKey) ?? { spent: 0, reserved: 0 })
					if (
						budget !== undefined &&
						currentBudget.spent + currentBudget.reserved + budgetReservation >
							budget.limit
					)
						return yield* Effect.fail(
							runtimeError("budget", "Route budget limit reached", {
								deployment: selected.id,
								limit: budget.limit,
								actual:
									currentBudget.spent +
									currentBudget.reserved +
									budgetReservation,
							}),
						)
					const id = `${runtimeId}:${current.nextReservationId}`
					const next: RuntimeState = {
						deployments: {
							...current.deployments,
							[selected.id]: {
								...value,
								activeRequests: value.activeRequests + 1,
								reservedTokens: value.reservedTokens + amounts.tokens,
								reservedCost: value.reservedCost + amounts.cost,
								requestsInWindow: value.requestsInWindow + 1,
							},
						},
						budgets:
							budgetKey === undefined
								? current.budgets
								: {
										...current.budgets,
										[budgetKey]: {
											...currentBudget,
											reserved: currentBudget.reserved + budgetReservation,
										},
									},
						reservations: {
							...current.reservations,
							[id]: {
								deploymentId: selected.id,
								estimatedInputTokens: amounts.inputTokens,
								estimatedOutputTokens: amounts.outputTokens,
								estimatedTokens: amounts.tokens,
								estimatedCost: amounts.cost,
								reservedCost: budgetReservation,
								...(budgetKey === undefined ? {} : { budgetKey }),
								budgetReservation,
								startedWallMillis: now,
							},
						},
						nextReservationId: current.nextReservationId + 1,
					}
					yield* write(next)
					const startedMonotonicMillis =
						Number(yield* Clock.monotonicTimeNanos) / 1_000_000
					return {
						[ReservationOwner]: reservationOwner,
						id,
						deployment: selected,
						deploymentId: selected.id,
						startedAt: startedMonotonicMillis,
						startedWallMillis: now,
						startedMonotonicMillis,
						estimatedInputTokens: amounts.inputTokens,
						estimatedOutputTokens: amounts.outputTokens,
						estimatedTokens: amounts.tokens,
						estimatedCost: amounts.cost,
						reservedCost: budgetReservation,
						...(budgetKey === undefined ? {} : { budgetKey }),
						budgetReservation,
					} satisfies AttemptReservation
				}),
			)
		}
		const finish = (
			reservation: AttemptReservation,
			outcome: ReservationOutcome,
		): Effect.Effect<void, RuntimeError> =>
			atomic(
				Effect.gen(function* () {
					yield* parse(OutcomeSchema, outcome)
					if (reservation[ReservationOwner] !== reservationOwner)
						return yield* Effect.fail(
							runtimeError("reservation", "Reservation belongs to another runtime", {
								deployment: reservation.deploymentId,
							}),
						)
					const current = yield* read()
					const pending = own(current.reservations, reservation.id)
					if (pending === undefined) return
					const now = yield* Clock.currentTimeMillis
					const mono = Number(yield* Clock.monotonicTimeNanos) / 1_000_000
					const deployment =
						own(configured, pending.deploymentId) ?? reservation.deployment
					const value = recoverCooldown(
						resetWindow(
							own(current.deployments, pending.deploymentId) ??
								emptyDeploymentState(now),
							now,
						),
						now,
					)
					const fallbackUsage = {
						inputTokens: pending.estimatedInputTokens,
						outputTokens: pending.estimatedOutputTokens,
					}
					const usage = usageValues(
						outcome.usage,
						outcome._tag === "success"
							? fallbackUsage
							: { inputTokens: 0, outputTokens: 0 },
					)
					const inputPrice = Math.max(
						0,
						deployment.pricing?.inputPerToken ?? deployment.pricing?.input ?? 0,
					)
					const outputPrice = Math.max(
						0,
						deployment.pricing?.outputPerToken ?? deployment.pricing?.output ?? 0,
					)
					const cost = usage.inputTokens * inputPrice + usage.outputTokens * outputPrice
					const budgetSpent =
						outcome._tag === "success" && deployment.pricing === undefined
							? pending.budgetReservation
							: cost
					const delay = Math.max(0, outcome.cooldownMillis ?? 0)
					const settled: DeploymentState =
						outcome._tag === "success"
							? {
									...value,
									activeRequests: Math.max(0, value.activeRequests - 1),
									reservedTokens: Math.max(
										0,
										value.reservedTokens - pending.estimatedTokens,
									),
									reservedCost: Math.max(
										0,
										value.reservedCost - pending.estimatedCost,
									),
									healthy: true,
									cooldownUntil: 0,
									successCount: value.successCount + 1,
									latencyMs: Math.max(
										0,
										outcome.latencyMs ??
											mono - reservation.startedMonotonicMillis,
									),
									inputTokens: value.inputTokens + usage.inputTokens,
									outputTokens: value.outputTokens + usage.outputTokens,
									totalCost: value.totalCost + cost,
									tokensInWindow:
										value.tokensInWindow +
										usage.inputTokens +
										usage.outputTokens,
								}
							: {
									...value,
									activeRequests: Math.max(0, value.activeRequests - 1),
									reservedTokens: Math.max(
										0,
										value.reservedTokens - pending.estimatedTokens,
									),
									reservedCost: Math.max(
										0,
										value.reservedCost - pending.estimatedCost,
									),
									inputTokens: value.inputTokens + usage.inputTokens,
									outputTokens: value.outputTokens + usage.outputTokens,
									totalCost: value.totalCost + cost,
									tokensInWindow:
										value.tokensInWindow +
										usage.inputTokens +
										usage.outputTokens,
									...(outcome._tag === "failure"
										? {
												failureCount: value.failureCount + 1,
												healthy: delay === 0 ? value.healthy : false,
												cooldownUntil:
													delay === 0 ? value.cooldownUntil : now + delay,
											}
										: {}),
								}
					const nextBudget =
						pending.budgetKey === undefined
							? current.budgets
							: {
									...current.budgets,
									[pending.budgetKey]: {
										spent:
											(own(current.budgets, pending.budgetKey)?.spent ?? 0) +
											budgetSpent,
										reserved: Math.max(
											0,
											(own(current.budgets, pending.budgetKey)?.reserved ??
												0) - pending.budgetReservation,
										),
									},
								}
					yield* write({
						deployments: { ...current.deployments, [pending.deploymentId]: settled },
						budgets: nextBudget,
						reservations: Object.fromEntries(
							Object.entries(current.reservations).filter(
								([id]) => id !== reservation.id,
							),
						),
						nextReservationId: current.nextReservationId,
					})
				}),
			)
		return {
			snapshot,
			state,
			metrics,
			available,
			reserve,
			finish,
		} satisfies RuntimeService
	})

/** Start one runtime owner for the configured deployment set. */
export const make = (
	deployments: readonly DeploymentConfig[],
): Effect.Effect<RuntimeService, RuntimeError, Persistence.Persistence> => makeDurable(deployments)

export const layer = (
	deployments: readonly DeploymentConfig[],
): Layer.Layer<RoutingRuntime, RuntimeError, Persistence.Persistence> =>
	Layer.effect(RoutingRuntime, make(deployments))
