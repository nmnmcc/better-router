import {
	Cause,
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Random,
	Ref,
	Result,
	Schema,
	SchemaIssue,
	Scope,
	Stream,
} from "effect"
import type { GenerationEvent, GenerationRequest, GenerationResponse } from "./Generation.js"
import { Request as GenerationRequestSchema } from "./GenerationSchema.js"
import type { Process } from "./GenerationProcess.js"
import * as RoutingProcess from "./RoutingProcess.js"
import type { Snapshot } from "./Registry.js"
import type { DeploymentConfig } from "./Deployment.js"
import { ref as staticDeploymentRef } from "./Deployment.js"
import type { ProviderRuntime } from "./ProviderContract.js"
import { capabilitiesForDeployment } from "./ProviderContract.js"
import { Error as ProviderError } from "./Provider.js"
import * as Routing from "./Routing.js"
import * as Policies from "./Policies.js"
import * as Hooks from "./Hooks.js"
import type { HookSet } from "./Hooks.js"
import * as Contributions from "./PluginContributions.js"
import {
	RoutingRuntime,
	RuntimeError,
	type AttemptReservation,
	type ReservationOutcome,
	type RuntimeService,
} from "./RoutingRuntime.js"

export type Request<Model extends string = string> = Omit<GenerationRequest, "model"> & {
	readonly model: Model
}

export const Issue = Schema.Struct({
	path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
	message: Schema.String,
})
export type Issue = typeof Issue.Type

export class UnknownModel extends Schema.TaggedError<UnknownModel>()("RouteUnknownModel", {
	model: Schema.String,
}) {}
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("RouteInvalidRequest", {
	message: Schema.String,
	issues: Schema.optional(Schema.Array(Issue)),
}) {}
export class HandlerFailed extends Schema.TaggedError<HandlerFailed>()("RouteHandlerFailed", {
	model: Schema.String,
	cause: Schema.Defect({ excludeCause: true }),
}) {}
export class HookFailed extends Schema.TaggedError<HookFailed>()("RouteHookFailed", {
	hook: Schema.String,
	message: Schema.String,
	cause: Schema.Defect({ excludeCause: true }),
}) {}
export class ProviderRuntimeMissing extends Schema.TaggedError<ProviderRuntimeMissing>()(
	"RouteProviderRuntimeMissing",
	{ provider: Schema.String, deployment: Schema.String },
) {}

export const Error = Schema.Union([
	UnknownModel,
	InvalidRequest,
	HandlerFailed,
	HookFailed,
	ProviderRuntimeMissing,
	Routing.Error,
]).pipe(Schema.toTaggedUnion("_tag"))
export type RouteError = typeof Error.Type
export const RouteError = Error

export interface Service {
	readonly generate: (
		request: unknown,
	) => Effect.Effect<
		Process<unknown, never>,
		RouteError | ProviderError | Routing.RoutingError | RuntimeError
	>
}
export class Route extends Context.Service<Route, Service>()("BetterRouterRoute") {}

type RuntimeEntry = {
	readonly deployment: DeploymentConfig
	readonly runtime: ProviderRuntime<any>
	readonly capabilities: readonly string[]
}
type RuntimeMap = Readonly<Record<string, RuntimeEntry>>

const deploymentRef = (
	deployment: DeploymentConfig,
	capabilities: readonly string[],
): Routing.FilterableDeployment => ({
	...staticDeploymentRef(deployment),
	capabilities,
})

const decodeRequest = (value: unknown): Effect.Effect<GenerationRequest, InvalidRequest> =>
	Schema.decodeUnknownEffect(GenerationRequestSchema)(value, { onExcessProperty: "error" }).pipe(
		Effect.mapError((error) =>
			InvalidRequest.make({
				message: error.message,
				issues: SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map(
					(issue) => ({
						path: (issue.path ?? []).map((part) =>
							typeof part === "number" || typeof part === "string"
								? part
								: String(part),
						),
						message: issue.message,
					}),
				),
			}),
		),
	)

const responseOf = (event: GenerationEvent): GenerationResponse | undefined => {
	const value = (event as { readonly response?: unknown }).response
	return value === undefined ? undefined : (value as GenerationResponse)
}
const terminal = (event: GenerationEvent): boolean => {
	const response = responseOf(event)
	return (
		response !== undefined &&
		(event.type === "response.completed" ||
			event.type === "response.incomplete" ||
			event.type === "response.failed")
	)
}
const publicEvent = (event: GenerationEvent, model: string): GenerationEvent => {
	const response = responseOf(event)
	return response === undefined
		? event
		: ({ ...event, response: { ...response, model } } as GenerationEvent)
}

const hookError = (name: string, cause: unknown): HookFailed =>
	HookFailed.make({ hook: name, message: String(cause), cause })
const runHook = <A, E, R>(
	name: string,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, HookFailed, R> =>
	effect.pipe(
		Effect.catchCause((cause) =>
			Cause.hasInterrupts(cause)
				? Effect.failCause(cause as Cause.Cause<HookFailed>)
				: Effect.fail(
						hookError(
							name,
							Option.getOrElse(Cause.findErrorOption(cause), () => cause),
						),
					),
		),
	)

/** Cleanup always runs, and a cleanup failure takes priority over a retryable source error. */
const completeLifecycle = <A, E, R, E2, R2>(
	effect: Effect.Effect<A, E, R>,
	finalize: (exit: Exit.Exit<A, E>) => Effect.Effect<void, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(restore(effect))
			const cleanup = yield* Effect.exit(finalize(exit))
			if (Exit.isFailure(cleanup))
				return yield* Effect.failCause(
					Exit.isFailure(exit) ? Cause.combine(cleanup.cause, exit.cause) : cleanup.cause,
				)
			return yield* exit
		}),
	)

const contextSchema = Schema.Struct({
	structuredRequest: GenerationRequestSchema,
	candidateDeployments: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString })),
	metadata: Schema.Record(Schema.String, Schema.String),
	signals: Schema.Record(Schema.String, Schema.Unknown),
})

/** Contributions may narrow candidates, but cannot replace preflighted deployment declarations. */
const normalizeContext = (
	value: unknown,
	initial: Routing.RoutingContext,
): Effect.Effect<Routing.RoutingContext, InvalidRequest | Routing.InvalidCandidates> =>
	Schema.decodeUnknownEffect(contextSchema)(value).pipe(
		Effect.mapError((error) =>
			InvalidRequest.make({
				message: error.message,
				issues: SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map(
					(issue) => ({
						path: (issue.path ?? []).map((part) =>
							typeof part === "number" || typeof part === "string"
								? part
								: String(part),
						),
						message: issue.message,
					}),
				),
			}),
		),
		Effect.flatMap((decoded) => {
			const invalid = decoded.candidateDeployments.find(
				(candidate, index) =>
					!initial.candidateDeployments.some((entry) => entry.id === candidate.id) ||
					decoded.candidateDeployments.findIndex((entry) => entry.id === candidate.id) !==
						index,
			)
			return invalid !== undefined || decoded.structuredRequest.model !== initial.model
				? Effect.fail(
						Routing.InvalidCandidates.make({
							model: initial.model,
							message:
								invalid === undefined
									? "A contribution cannot change the public model alias"
									: `Contribution returned an unknown or duplicate deployment: ${invalid.id}`,
						}),
					)
				: Effect.succeed({
						...initial,
						structuredRequest: decoded.structuredRequest,
						candidateDeployments: decoded.candidateDeployments.flatMap((candidate) => {
							const trusted = initial.candidateDeployments.find(
								(entry) => entry.id === candidate.id,
							)
							return trusted === undefined ? [] : [trusted]
						}),
						metadata: decoded.metadata,
						signals: decoded.signals,
					})
		}),
	)
const hooksOf = (snapshot: Snapshot): HookSet<unknown, any> =>
	Hooks.compose<unknown, any>(
		snapshot.hooks.map((hook) => ({
			...(hook.beforeRequest === undefined ? {} : { beforeRequest: [hook.beforeRequest] }),
			...(hook.beforeAttempt === undefined ? {} : { beforeAttempt: [hook.beforeAttempt] }),
			...(hook.afterResponse === undefined ? {} : { afterResponse: [hook.afterResponse] }),
			...(hook.afterSuccess === undefined ? {} : { afterSuccess: [hook.afterSuccess] }),
			...(hook.afterFailure === undefined ? {} : { afterFailure: [hook.afterFailure] }),
			...(hook.onError === undefined ? {} : { onError: [hook.onError] }),
			...(hook.onCancel === undefined ? {} : { onCancel: [hook.onCancel] }),
			...(hook.onStreamEvent === undefined ? {} : { onStreamEvent: [hook.onStreamEvent] }),
			...(hook.onFinalize === undefined ? {} : { onFinalize: [hook.onFinalize] }),
		})),
	) as HookSet<unknown, any>

const findById = <A extends { readonly id: string }>(
	values: readonly A[],
	id: string,
): A | undefined => values.find((value) => value.id === id)
const strategyOf = (id: string | undefined): Policies.Strategy | undefined =>
	id === undefined
		? undefined
		: Result.match(Policies.strategyRegistry, {
				onFailure: () => undefined,
				onSuccess: (registry) => registry.get(id),
			})
const policyOf = (
	route: Contributions.ModelRouteConfig,
	snapshot: Snapshot,
	context: Routing.RoutingContext,
): Routing.RoutingPolicy<any> | undefined => {
	const declaration =
		route.policy === undefined ? undefined : findById(snapshot.policies, route.policy)
	return declaration?.rank === undefined
		? undefined
		: {
				id: declaration.id,
				rank: (request, candidates, policyContext) =>
					declaration.rank!(request, candidates, policyContext, context),
			}
}
const strategyFor = (
	route: Contributions.ModelRouteConfig,
	snapshot: Snapshot,
): Policies.Strategy | undefined =>
	strategyOf(
		route.strategy ??
			(route.policy === undefined
				? undefined
				: findById(snapshot.policies, route.policy)?.strategy),
	)

const pipelines = (
	context: Routing.RoutingContext,
	route: Contributions.ModelRouteConfig,
	snapshot: Snapshot,
): Effect.Effect<
	Routing.RoutingContext,
	HookFailed | InvalidRequest | Routing.InvalidCandidates,
	any
> =>
	(route.pipelines ?? []).reduce<
		Effect.Effect<
			Routing.RoutingContext,
			HookFailed | InvalidRequest | Routing.InvalidCandidates,
			any
		>
	>(
		(current, id) =>
			current.pipe(
				Effect.flatMap((value) => {
					const pipeline = findById(snapshot.pipelines, id)
					return pipeline === undefined
						? Effect.fail(hookError(`pipeline:${id}`, `Unknown pipeline ${id}`))
						: Effect.suspend(() => pipeline.run(value)).pipe(
								Effect.mapError((cause) => hookError(`pipeline:${id}`, cause)),
								Effect.flatMap((next) => normalizeContext(next, value)),
							)
				}),
			),
		Effect.succeed(context),
	)

const attempt = (
	entry: RuntimeEntry,
	request: GenerationRequest,
	publicModel: string,
	context: Routing.RoutingContext,
	index: number,
	runtime: RuntimeService,
	budget: Contributions.BudgetConfig | undefined,
	retry: Contributions.RetryConfig | undefined,
	hooks: HookSet<unknown, any>,
	selectedAttempt: Ref.Ref<Option.Option<Hooks.AttemptHookContext>>,
): Effect.Effect<Stream.Stream<GenerationEvent, unknown, any>, unknown, any> =>
	Effect.gen(function* () {
		const attemptContext = {
			request,
			model: publicModel,
			metadata: context.metadata,
			signals: context.signals,
			deployment: deploymentRef(entry.deployment, entry.capabilities),
			attempt: index + 1,
		}
		const ownerScope = yield* Effect.scope
		const environment = yield* Effect.context<any>()
		const reservation = yield* Ref.make<Option.Option<AttemptReservation>>(Option.none())
		const opened = yield* Ref.make<Option.Option<Process<unknown, any>>>(Option.none())
		const observed = yield* Ref.make(false)
		const terminalResponse = yield* Ref.make<Option.Option<GenerationResponse>>(Option.none())
		const usage = yield* Ref.make<Option.Option<GenerationResponse["usage"]>>(Option.none())
		const finalize = (exit: Exit.Exit<unknown, unknown>): Effect.Effect<void, unknown, any> =>
			Effect.gen(function* () {
				const response = yield* Ref.get(terminalResponse)
				const sawEvent = yield* Ref.get(observed)
				const failedResponse = Option.isSome(response) && response.value.status === "failed"
				const interrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
				const error = Exit.isFailure(exit)
					? Cause.findErrorOption(exit.cause).pipe(Option.getOrUndefined)
					: failedResponse && Option.isSome(response)
						? response.value.error
						: undefined
				const outcome: ReservationOutcome["_tag"] = interrupted
					? "cancelled"
					: Exit.isFailure(exit) || failedResponse || Option.isNone(response)
						? "failure"
						: "success"
				const active = yield* Ref.get(reservation)
				const actualUsage = yield* Ref.get(usage)
				const provider = yield* Ref.get(opened)
				const providerExit = yield* Effect.exit(
					Option.match(provider, {
						onNone: () => Effect.void,
						onSome: (process) => process.cancel,
					}),
				)
				const accounting = Option.match(active, {
					onNone: () => Effect.void,
					onSome: (value) =>
						runtime.finish(value, {
							_tag: outcome,
							...(retry?.cooldownMillis === undefined || outcome !== "failure"
								? {}
								: { cooldownMillis: retry.cooldownMillis }),
							...(Option.isNone(actualUsage) ? {} : { usage: actualUsage.value }),
						}),
				})
				const callback =
					outcome === "failure"
						? runHook(
								"afterFailure",
								Hooks.runAfterFailure(hooks, {
									...attemptContext,
									error,
									firstEventObserved: sawEvent,
								}),
							)
						: Effect.void
				const accountingExit = yield* Effect.exit(accounting)
				const callbackExit = yield* Effect.exit(callback)
				const exits: readonly Exit.Exit<void, unknown>[] = [
					providerExit as Exit.Exit<void, unknown>,
					accountingExit as Exit.Exit<void, unknown>,
					callbackExit as Exit.Exit<void, unknown>,
				]
				const failures: readonly Cause.Cause<unknown>[] = exits.flatMap((value) =>
					Exit.isFailure(value) ? [value.cause as Cause.Cause<unknown>] : [],
				)
				yield* completeLifecycle(
					failures.length === 0
						? Effect.void
						: Effect.failCause(
								failures.reduce((all, cause) => Cause.combine(all, cause)),
							),
					() =>
						runHook(
							"onFinalize",
							Hooks.runOnFinalize(hooks, {
								...attemptContext,
								outcome,
								error,
							}),
						),
				)
			})
		const run = (emit: (event: GenerationEvent) => Effect.Effect<void>) =>
			Effect.gen(function* () {
				yield* Ref.set(selectedAttempt, Option.some(attemptContext))
				yield* runHook("beforeAttempt", Hooks.runBeforeAttempt(hooks, attemptContext))
				yield* runtime
					.reserve(entry.deployment, request, budget)
					.pipe(Effect.flatMap((value) => Ref.set(reservation, Option.some(value))))
				const provider = yield* entry.runtime.generate({
					...request,
					model: entry.deployment.model,
				})
				yield* Ref.set(opened, Option.some(provider))
				yield* Stream.runForEach(provider.events, (incoming) =>
					Effect.gen(function* () {
						const event = publicEvent(incoming, publicModel)
						yield* Ref.set(observed, true)
						if (terminal(event)) {
							const response = responseOf(event)!
							const previous = yield* Ref.get(terminalResponse)
							if (Option.isSome(previous))
								return yield* Effect.fail(
									ProviderError.make({
										kind: "unknown",
										message: "Provider emitted multiple terminal responses",
										retryable: false,
									}),
								)
							yield* Ref.set(terminalResponse, Option.some(response))
							yield* Ref.set(usage, Option.fromNullishOr(response.usage))
							if (response.status !== "failed")
								yield* runHook(
									"afterSuccess",
									Hooks.runAfterSuccess(hooks, { ...attemptContext, response }),
								)
						}
						yield* runHook(
							"onStreamEvent",
							Hooks.runOnStreamEvent(hooks, { ...attemptContext, event }),
						)
						yield* emit(event)
					}),
				)
				if (Option.isNone(yield* Ref.get(terminalResponse)))
					return yield* Effect.fail(
						ProviderError.make({
							kind: "unknown",
							message: "Provider ended without a terminal response",
							retryable: !(yield* Ref.get(observed)),
						}),
					)
			})
		const process = yield* RoutingProcess.makeFromProducer(
			(emit) => completeLifecycle(run(emit), finalize),
			environment,
			ownerScope,
		)
		return process.events
	})

const middleware = (
	context: Routing.RoutingContext,
	route: Contributions.ModelRouteConfig,
	snapshot: Snapshot,
	next: Contributions.Handler<any>,
): Effect.Effect<Process<unknown, any>, unknown, any> =>
	(route.middleware ?? []).reduceRight<Contributions.Handler<any>>((current, id) => {
		const value = findById(snapshot.middleware, id)
		return value === undefined ? current : value.wrap(current)
	}, next)(context)

const entriesOf = (
	route: Contributions.ModelRouteConfig,
	runtimes: RuntimeMap,
): readonly RuntimeEntry[] =>
	[...route.deployments, ...(route.fallback ?? [])].flatMap((id) => {
		const value = runtimes[id]
		return value === undefined ? [] : [value]
	})

const isRouteFailure = (value: unknown): value is RouteError | ProviderError | RuntimeError =>
	typeof value === "object" &&
	value !== null &&
	"_tag" in value &&
	typeof value._tag === "string" &&
	[
		"RouteUnknownModel",
		"RouteInvalidRequest",
		"RouteHandlerFailed",
		"RouteHookFailed",
		"RouteProviderRuntimeMissing",
		"RoutingNoCandidates",
		"RoutingInvalidCandidates",
		"RoutingPolicyFailed",
		"RoutingFallbackExhausted",
		"RoutingAccessDenied",
		"ProviderError",
		"RoutingRuntimeError",
	].includes(value._tag)

const service = (
	snapshot: Snapshot,
	runtimes: RuntimeMap,
	runtime: RuntimeService,
	environment: Context.Context<any>,
	ownerScope: Scope.Scope,
): Service => {
	const hooks = hooksOf(snapshot)
	return {
		generate: (rawRequest) =>
			decodeRequest(rawRequest).pipe(
				Effect.flatMap((request) => {
					const route = snapshot.modelRoutes.find(
						(value) => value.model === request.model,
					)
					return route === undefined
						? Effect.fail(UnknownModel.make({ model: request.model }))
						: Effect.gen(function* () {
								const entries = entriesOf(route, runtimes)
								const refs = entries.map((entry) =>
									deploymentRef(entry.deployment, entry.capabilities),
								)
								const metrics = yield* runtime.metrics
								const sample = yield* Random.next
								const initial = yield* Effect.fromResult(
									Routing.makeContext(
										request,
										refs,
										request.metadata ?? {},
										{ "routing:random": sample },
										metrics,
									),
								)
								const requestContext = { ...initial, rawRequest }
								const latest = yield* Ref.make(requestContext)
								const observed = yield* Ref.make(false)
								const terminalResponse = yield* Ref.make<
									Option.Option<GenerationResponse>
								>(Option.none())
								const selectedAttempt = yield* Ref.make<
									Option.Option<Hooks.AttemptHookContext>
								>(Option.none())
								const finalized = yield* Ref.make(false)
								const finalizeRequest = (
									exit: Exit.Exit<unknown, unknown>,
								): Effect.Effect<void, HookFailed, any> =>
									Ref.modify(finalized, (done) => [!done, true]).pipe(
										Effect.flatMap((claimed) =>
											claimed
												? Effect.gen(function* () {
														const current = yield* Ref.get(latest)
														const hookContext: Hooks.RequestHookContext =
															{
																request: current.structuredRequest,
																model: request.model,
																metadata: current.metadata,
																signals: current.signals,
															}
														const response =
															yield* Ref.get(terminalResponse)
														if (
															Exit.isFailure(exit) &&
															Cause.hasInterrupts(exit.cause)
														)
															return yield* runHook(
																"onCancel",
																Hooks.runOnCancel(
																	hooks,
																	hookContext,
																),
															)
														if (
															Exit.isFailure(exit) ||
															(Option.isSome(response) &&
																response.value.status === "failed")
														)
															return yield* runHook(
																"onError",
																Hooks.runOnError(hooks, {
																	...hookContext,
																	firstEventObserved:
																		yield* Ref.get(observed),
																	error: Exit.isFailure(exit)
																		? Option.getOrElse(
																				Cause.findErrorOption(
																					exit.cause,
																				),
																				() => exit.cause,
																			)
																		: Option.isSome(response)
																			? response.value.error
																			: undefined,
																}),
															)
													})
												: Effect.void,
										),
									)
								const invoke: Contributions.Handler<any> = (modified) =>
									Effect.gen(function* () {
										const normalized = yield* normalizeContext(
											modified,
											requestContext,
										)
										const piped = yield* pipelines(normalized, route, snapshot)
										yield* Ref.set(latest, piped)
										if (route.access !== undefined) {
											const value = piped.metadata[route.access.metadataKey]
											if (
												value === undefined ||
												!route.access.allow.includes(value)
											)
												return yield* Effect.fail(
													Routing.AccessDenied.make({
														model: request.model,
														message: "Request is not allowed",
													}),
												)
										}
										const filtered = Routing.filterCandidates(
											piped.candidateDeployments,
											{
												includeTags: route.requiredTags,
												requiredCapabilities: route.requiredCapabilities,
											},
										)
										const available = yield* runtime.available(filtered)
										if (available.length === 0)
											return yield* Effect.fail(
												Routing.NoCandidates.make({
													model: request.model,
													message: "No healthy deployments",
												}),
											)
										const selected = yield* Routing.rankCandidates(
											piped.structuredRequest,
											{ ...piped, candidateDeployments: available },
											strategyFor(route, snapshot),
											policyOf(route, snapshot, piped),
										)
										const selectedEntries = selected.flatMap((value) => {
											const entry = runtimes[value.id]
											return entry === undefined ? [] : [entry]
										})
										const attempts = selectedEntries.flatMap((entry) =>
											Array.from(
												{
													length:
														1 +
														(route.retry?.retriesPerDeployment ?? 0),
												},
												() => entry,
											),
										)
										const events = yield* Routing.executeWithFallback(
											piped.structuredRequest,
											attempts.map((entry, index) => ({
												...deploymentRef(
													entry.deployment,
													entry.capabilities,
												),
												execute: () =>
													(index === 0 ||
													route.retry?.delayMillis === undefined
														? Effect.void
														: Effect.sleep(route.retry.delayMillis)
													).pipe(
														Effect.andThen(
															attempt(
																entry,
																piped.structuredRequest,
																request.model,
																piped,
																index,
																runtime,
																route.budget,
																route.retry,
																hooks,
																selectedAttempt,
															),
														),
													),
											})),
											{
												...(route.retry?.maxAttempts === undefined
													? {}
													: { maxAttempts: route.retry.maxAttempts }),
												shouldFallback: (error) =>
													typeof error === "object" &&
													error !== null &&
													"retryable" in error &&
													error.retryable === true &&
													(route.retry?.retryableKinds === undefined ||
														("kind" in error &&
															typeof error.kind === "string" &&
															route.retry.retryableKinds.includes(
																error.kind,
															))),
											},
										)
										return yield* RoutingProcess.make(
											events,
											environment,
											ownerScope,
										)
									})
								const setup = runHook(
									"beforeRequest",
									Hooks.runBeforeRequest(hooks, {
										request,
										model: request.model,
										metadata: requestContext.metadata,
										signals: requestContext.signals,
									}),
								).pipe(
									Effect.andThen(
										Effect.suspend(() =>
											middleware(requestContext, route, snapshot, invoke),
										),
									),
								)
								const process = yield* completeLifecycle(setup, (exit) =>
									Exit.isFailure(exit) ? finalizeRequest(exit) : Effect.void,
								)
								const shared = yield* RoutingProcess.makeFromProducer(
									(emit) =>
										completeLifecycle(
											Stream.runForEach(process.events, (event) =>
												Effect.gen(function* () {
													yield* Ref.set(observed, true)
													if (terminal(event)) {
														const response = responseOf(event)!
														const first = yield* Ref.modify(
															terminalResponse,
															(previous) => [
																Option.isNone(previous),
																Option.orElse(previous, () =>
																	Option.some(response),
																),
															],
														)
														if (first) {
															const current = yield* Ref.get(latest)
															const selected =
																yield* Ref.get(selectedAttempt)
															yield* runHook(
																"afterResponse",
																Hooks.runAfterResponse(hooks, {
																	request:
																		current.structuredRequest,
																	model: request.model,
																	metadata: current.metadata,
																	signals: current.signals,
																	...(Option.isSome(selected)
																		? selected.value
																		: {}),
																	response,
																}),
															)
														}
													}
													yield* emit(event)
												}),
											),
											(exit) =>
												completeLifecycle(process.cancel, () =>
													finalizeRequest(exit),
												),
										),
									environment,
									ownerScope,
									{
										onCancelBeforeStart: completeLifecycle(process.cancel, () =>
											finalizeRequest(Exit.interrupt()),
										).pipe(Effect.provideContext(environment)),
									},
								)
								return shared
							})
				}),
				Effect.provideContext(environment),
				Effect.mapError((cause) =>
					isRouteFailure(cause)
						? cause
						: HandlerFailed.make({
								model:
									typeof rawRequest === "object" &&
									rawRequest !== null &&
									"model" in rawRequest
										? String(rawRequest.model)
										: "unknown",
								cause,
							}),
				),
			),
	}
}

const runtimesOf = (
	snapshot: Snapshot,
	context: Context.Context<any>,
): Effect.Effect<RuntimeMap, unknown, any> => {
	const effects = snapshot.deployments.map((deployment) => {
		const contract = snapshot.providerContracts.find(
			(value) => value.id === deployment.provider,
		)
		return contract?.runtime === undefined
			? Effect.fail(
					ProviderRuntimeMissing.make({
						provider: deployment.provider,
						deployment: deployment.id,
					}),
				)
			: contract.runtime(deployment).pipe(
					Effect.provideContext(context),
					Effect.map((runtime) => ({
						[deployment.id]: {
							deployment,
							runtime,
							capabilities: capabilitiesForDeployment(contract, deployment),
						},
					})),
				)
	})
	return Effect.all(effects).pipe(
		Effect.map((values) =>
			values.reduce<RuntimeMap>((all, value) => ({ ...all, ...value }), {}),
		),
	)
}

export const make = (
	snapshot: Snapshot,
): Effect.Effect<Service, unknown, RoutingRuntime | Scope.Scope> =>
	Effect.gen(function* () {
		const runtime = yield* RoutingRuntime
		const scope = yield* Effect.scope
		const context = yield* Effect.context<any>()
		return service(snapshot, yield* runtimesOf(snapshot, context), runtime, context, scope)
	})

export const layer = (snapshot: Snapshot): Layer.Layer<Route, unknown, RoutingRuntime> =>
	Layer.effect(Route, make(snapshot))

export const generate = (
	request: unknown,
): Effect.Effect<
	Process<unknown, never>,
	RouteError | ProviderError | Routing.RoutingError | RuntimeError,
	Route
> => Effect.flatMap(Route, (route) => route.generate(request))
