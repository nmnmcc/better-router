import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Stream } from "effect"
import type { DeploymentConfig } from "../src/Deployment.js"
import type { GenerationEvent, GenerationResponse } from "../src/Generation.js"
import { Process } from "../src/GenerationProcess.js"
import type { ResponseHookContext } from "../src/Hooks.js"
import * as Persistence from "../src/Persistence.js"
import * as Plugin from "../src/Plugin.js"
import type { PluginConfig } from "../src/PluginContributions.js"
import * as Policies from "../src/Policies.js"
import { Error as ProviderError } from "../src/Provider.js"
import * as ProviderContract from "../src/ProviderContract.js"
import * as Registry from "../src/Registry.js"
import * as Route from "../src/Route.js"
import * as RoutingRuntime from "../src/RoutingRuntime.js"

const response = (model: string, status = "completed"): GenerationResponse => ({
	id: `response-${model}`,
	object: "response",
	created_at: 0,
	completed_at: status === "completed" ? 0 : null,
	status,
	incomplete_details: null,
	model,
	previous_response_id: null,
	instructions: null,
	output: [],
	error: null,
	tools: [],
	tool_choice: "auto",
	truncation: "disabled",
	parallel_tool_calls: true,
	text: { format: { type: "text" } },
	top_p: 1,
	presence_penalty: 0,
	frequency_penalty: 0,
	top_logprobs: 0,
	temperature: 1,
	reasoning: null,
	usage: {
		input_tokens: 2,
		output_tokens: 3,
		total_tokens: 5,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens_details: { reasoning_tokens: 0 },
	},
	max_output_tokens: null,
	max_tool_calls: null,
	store: false,
	background: false,
	service_tier: "default",
	metadata: null,
	safety_identifier: null,
	prompt_cache_key: null,
})

const completed = (model: string): GenerationEvent => ({
	type: "response.completed",
	sequence_number: 1,
	response: response(model),
})

const created = (model: string): GenerationEvent => ({
	type: "response.created",
	sequence_number: 0,
	response: response(model, "in_progress"),
})

const deployment = (id: string): DeploymentConfig => ({
	id,
	provider: "fixture",
	model: `private-${id}`,
	protocol: "generation",
	pricing: { inputPerToken: 1, outputPerToken: 2 },
})

const record = (log: Ref.Ref<readonly string[]>, value: string) =>
	Ref.update(log, (values) => [...values, value])

const snapshot = (config: PluginConfig) =>
	Effect.fromResult(
		Registry.fromPlugins([Plugin.make({ id: "fixture-plugin", capabilities: [], config })]),
	)

const acquire = (declarations: Registry.Snapshot) =>
	Effect.gen(function* () {
		const runtime = yield* RoutingRuntime.make(declarations.deployments)
		const route = yield* Route.make(declarations).pipe(
			Effect.provideService(RoutingRuntime.RoutingRuntime, runtime),
		)
		return { route, runtime }
	})

it.effect(
	"isolates provider runtimes by deployment and shares each request across process views",
	() =>
		Effect.gen(function* () {
			const opened = yield* Ref.make<readonly DeploymentConfig[]>([])
			const calls = yield* Ref.make<readonly string[]>([])
			const responseHooks = yield* Ref.make(0)
			const contract = ProviderContract.make({
				id: "fixture",
				endpoints: [{ id: "generation", parameters: [], streaming: true }],
				runtime: (config) =>
					Ref.update(opened, (values) => [...values, config]).pipe(
						Effect.as({
							generate: (request) =>
								record(calls, `${config.id}:${request.model}`).pipe(
									Effect.flatMap(() =>
										Process.make(Stream.succeed(completed(request.model))),
									),
								),
						} satisfies ProviderContract.ProviderRuntime),
					),
			})
			const first = {
				...deployment("first"),
				credentialRef: "first-key",
				baseUrl: "https://first.example",
			}
			const second = {
				...deployment("second"),
				credentialRef: "second-key",
				baseUrl: "https://second.example",
			}
			const declarations = yield* snapshot({
				providers: [contract],
				deployments: [first, second],
				modelRoutes: [
					{ model: "chat", deployments: ["first"] },
					{ model: "fast", deployments: ["second"] },
				],
				hooks: [
					{ id: "observe", afterResponse: () => Ref.update(responseHooks, (n) => n + 1) },
				],
			})
			const { route, runtime } = yield* acquire(declarations)
			assert.deepEqual(yield* Ref.get(opened), [first, second])

			const process = yield* route.generate({ model: "chat", input: [] })
			const events = yield* Stream.runCollect(process.events)
			const terminal = yield* process.response
			const replayed = yield* Stream.runCollect(process.events)
			assert.equal(terminal.model, "chat")
			assert.deepEqual(replayed, events)
			assert.equal(events[0]?.type, "response.completed")
			assert.equal(yield* Ref.get(responseHooks), 1)
			assert.deepEqual(yield* Ref.get(calls), ["first:private-first"])

			const another = yield* route.generate({ model: "chat", input: [] })
			yield* another.response
			const fast = yield* route.generate({ model: "fast", input: [] })
			assert.equal((yield* fast.response).model, "fast")
			assert.deepEqual(yield* Ref.get(opened), [first, second])
			assert.deepEqual(yield* Ref.get(calls), [
				"first:private-first",
				"first:private-first",
				"second:private-second",
			])
			const firstState = yield* runtime.state("first")
			const secondState = yield* runtime.state("second")
			assert.equal(firstState.activeRequests, 0)
			assert.equal(firstState.successCount, 2)
			assert.equal(secondState.successCount, 1)
		}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("runs contributed pipelines, policies, middleware and hooks in declaration order", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: () =>
				Effect.succeed({
					generate: (request) =>
						record(log, `provider:${request.model}`).pipe(
							Effect.flatMap(() =>
								Process.make(Stream.succeed(completed(request.model))),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("chosen")],
			modelRoutes: [
				{
					model: "chat",
					deployments: ["primary", "chosen"],
					pipelines: ["first", "second"],
					policy: "prefer-chosen",
					middleware: ["outer", "inner"],
				},
			],
			pipelines: [
				{
					id: "first",
					run: (context) =>
						record(log, "pipeline:first").pipe(
							Effect.as({
								...context,
								candidateDeployments: context.candidateDeployments.filter(
									(item) => item.id === "chosen",
								),
								signals: { ...context.signals, tenant: "one" },
							}),
						),
				},
				{
					id: "second",
					run: (context) =>
						record(log, "pipeline:second").pipe(
							Effect.tap(() =>
								Effect.sync(() => assert.equal(context.signals.tenant, "one")),
							),
							Effect.as(context),
						),
				},
			],
			policies: [
				{
					id: "prefer-chosen",
					rank: (_request, candidates, context) =>
						record(log, "policy").pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									assert.deepEqual(
										candidates.map((item) => item.id),
										["chosen"],
									)
									assert.equal(context.signals.tenant, "one")
								}),
							),
							Effect.as(candidates),
						),
				},
			],
			middleware: ["outer", "inner"].map((id) => ({
				id,
				wrap: (next) => (context) =>
					record(log, `${id}:before`).pipe(
						Effect.andThen(next(context)),
						Effect.tap(() => record(log, `${id}:after`)),
					),
			})),
			hooks: ["first", "second"].map((id) => ({
				id,
				beforeRequest: () => record(log, `beforeRequest:${id}`),
				beforeAttempt: ({ deployment: selected }) =>
					record(log, `beforeAttempt:${id}:${selected.id}`),
				afterSuccess: () => record(log, `afterSuccess:${id}`),
				afterResponse: () => record(log, `afterResponse:${id}`),
				onStreamEvent: () => record(log, `event:${id}`),
				onFinalize: ({ outcome }) => record(log, `finalize:${id}:${outcome}`),
			})),
		})
		const { route } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		yield* process.response
		const observed = yield* Ref.get(log)
		const before = (first: string, second: string) => {
			assert.ok(observed.includes(first), first)
			assert.ok(observed.includes(second), second)
			assert.ok(
				observed.indexOf(first) < observed.indexOf(second),
				`${first} precedes ${second}`,
			)
		}
		before("beforeRequest:first", "beforeRequest:second")
		before("pipeline:first", "pipeline:second")
		before("pipeline:second", "policy")
		before("outer:before", "inner:before")
		before("inner:after", "outer:after")
		before("beforeAttempt:first:chosen", "beforeAttempt:second:chosen")
		before("beforeAttempt:second:chosen", "provider:private-chosen")
		before("afterResponse:first", "afterResponse:second")
		before("afterSuccess:first", "afterSuccess:second")
		before("afterSuccess:second", "afterResponse:first")
		before("event:first", "event:second")
		before("finalize:first:success", "finalize:second:success")
		assert.equal(observed.includes("provider:private-primary"), false)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("falls back before output and finalizes each attempted deployment once", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const responses = yield* Ref.make<readonly ResponseHookContext[]>([])
		const failure = ProviderError.make({
			kind: "unavailable",
			message: "retry",
			retryable: true,
		})
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(
									(config.id === "primary"
										? Stream.fail(failure)
										: Stream.succeed(completed(request.model))
									).pipe(Stream.ensuring(record(log, `close:${config.id}`))),
								),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [{ model: "chat", deployments: ["primary"], fallback: ["fallback"] }],
			hooks: [
				{
					id: "observe",
					afterResponse: (context) =>
						Ref.update(responses, (values) => [...values, context]),
					afterFailure: ({ deployment: config, firstEventObserved }) =>
						record(log, `failure:${config.id}:${firstEventObserved}`),
					afterSuccess: ({ deployment: config }) => record(log, `success:${config.id}`),
					onFinalize: ({ deployment: config, outcome }) =>
						record(log, `finalize:${config.id}:${outcome}`),
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		assert.equal((yield* process.response).model, "chat")
		const responseContexts = yield* Ref.get(responses)
		assert.equal(responseContexts.length, 1)
		assert.equal(responseContexts[0]?.model, "chat")
		assert.equal(responseContexts[0]?.response.model, "chat")
		assert.equal(responseContexts[0]?.request.model, "chat")
		assert.equal(responseContexts[0]?.deployment?.id, "fallback")
		assert.equal(responseContexts[0]?.attempt, 2)
		const observed = yield* Ref.get(log)
		assert.equal(observed.filter((item) => item === "open:primary").length, 1)
		assert.equal(observed.filter((item) => item === "open:fallback").length, 1)
		assert.ok(observed.indexOf("close:primary") < observed.indexOf("open:fallback"))
		assert.ok(observed.includes("failure:primary:false"))
		assert.equal(observed.filter((item) => item === "finalize:primary:failure").length, 1)
		assert.equal(observed.filter((item) => item === "finalize:fallback:success").length, 1)
		assert.equal((yield* runtime.state("primary")).failureCount, 1)
		assert.equal((yield* runtime.state("primary")).activeRequests, 0)
		assert.equal((yield* runtime.state("fallback")).successCount, 1)
		assert.equal((yield* runtime.state("fallback")).activeRequests, 0)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("forwards failures after the first event without replaying to a fallback", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const failure = ProviderError.make({
			kind: "unavailable",
			message: "late failure",
			retryable: true,
		})
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(
									config.id === "primary"
										? Stream.concat(
												Stream.succeed(created(request.model)),
												Stream.fail(failure),
											)
										: Stream.succeed(completed(request.model)),
								),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [
				{
					model: "chat",
					deployments: ["primary"],
					fallback: ["fallback"],
					retry: {
						retriesPerDeployment: 2,
						maxAttempts: 6,
						retryableKinds: ["unavailable"],
					},
				},
			],
			hooks: [
				{
					id: "observe",
					afterFailure: ({ firstEventObserved }) =>
						record(log, `failure:${firstEventObserved}`),
					onFinalize: ({ outcome }) => record(log, `finalize:${outcome}`),
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		assert.equal(yield* Stream.runCollect(process.events).pipe(Effect.flip), failure)
		const observed = yield* Ref.get(log)
		assert.deepEqual(
			observed.filter((item) => item.startsWith("open:")),
			["open:primary"],
		)
		assert.ok(observed.includes("failure:true"))
		assert.equal(observed.filter((item) => item === "finalize:failure").length, 1)
		assert.equal((yield* runtime.state("primary")).activeRequests, 0)
		assert.equal((yield* runtime.state("primary")).failureCount, 1)
		assert.equal((yield* runtime.state("fallback")).successCount, 0)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("cancels a suspended provider stream and releases accounting and hooks once", () =>
	Effect.gen(function* () {
		const emitted = yield* Deferred.make<void>()
		const closed = yield* Deferred.make<void>()
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(
									Stream.concat(
										Stream.succeed(created(request.model)),
										Stream.fromEffect(Deferred.succeed(emitted, void 0)).pipe(
											Stream.flatMap(() => Stream.never),
										),
									).pipe(
										Stream.ensuring(
											record(log, "provider:closed").pipe(
												Effect.andThen(Deferred.succeed(closed, void 0)),
											),
										),
									),
								),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [{ model: "chat", deployments: ["primary"], fallback: ["fallback"] }],
			hooks: [
				{
					id: "observe",
					afterResponse: () => record(log, "response"),
					onCancel: () => record(log, "cancel"),
					onFinalize: ({ outcome }) => record(log, `finalize:${outcome}`),
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		const eventsFiber = yield* Stream.runDrain(process.events).pipe(Effect.forkChild)
		const responseFiber = yield* process.response.pipe(Effect.forkChild)
		yield* Deferred.await(emitted)
		assert.equal((yield* runtime.state("primary")).activeRequests, 1)
		yield* process.cancel
		yield* process.cancel
		yield* Deferred.await(closed)
		yield* Fiber.await(eventsFiber)
		const responseExit = yield* Fiber.await(responseFiber)
		assert.equal(Exit.isFailure(responseExit), true)
		if (Exit.isFailure(responseExit))
			assert.equal(Cause.hasInterruptsOnly(responseExit.cause), true)
		const observed = yield* Ref.get(log)
		assert.equal(observed.filter((item) => item === "open:primary").length, 1)
		assert.equal(observed.includes("open:fallback"), false)
		assert.equal(observed.filter((item) => item === "provider:closed").length, 1)
		assert.equal(observed.filter((item) => item === "cancel").length, 1)
		assert.equal(observed.includes("response"), false)
		assert.equal(observed.filter((item) => item === "finalize:cancelled").length, 1)
		const state = yield* runtime.state("primary")
		assert.equal(state.activeRequests, 0)
		assert.equal(state.successCount, 0)
		assert.equal(state.failureCount, 0)
		assert.equal(state.reservedCost, 0)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("releases a reservation when cancellation interrupts provider opening", () =>
	Effect.gen(function* () {
		const opened = yield* Deferred.make<void>()
		const closed = yield* Deferred.make<void>()
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: () =>
						record(log, `open:${config.id}`).pipe(
							Effect.andThen(Deferred.succeed(opened, void 0)),
							Effect.andThen(Effect.never),
							Effect.ensuring(
								record(log, `close:${config.id}`).pipe(
									Effect.andThen(Deferred.succeed(closed, void 0)),
								),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [{ model: "chat", deployments: ["primary"], fallback: ["fallback"] }],
			hooks: [
				{
					id: "observe",
					onCancel: () => record(log, "cancel"),
					onFinalize: ({ outcome }) => record(log, `finalize:${outcome}`),
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		const eventsFiber = yield* Stream.runDrain(process.events).pipe(Effect.forkChild)
		yield* Deferred.await(opened)
		assert.equal((yield* runtime.state("primary")).activeRequests, 1)
		yield* process.cancel
		yield* process.cancel
		yield* Deferred.await(closed)
		yield* Fiber.await(eventsFiber)
		const observed = yield* Ref.get(log)
		assert.deepEqual(
			observed.filter((item) => item.startsWith("open:")),
			["open:primary"],
		)
		assert.equal(observed.filter((item) => item === "close:primary").length, 1)
		assert.equal(observed.filter((item) => item === "cancel").length, 1)
		assert.equal(observed.filter((item) => item === "finalize:cancelled").length, 1)
		const state = yield* runtime.state("primary")
		assert.equal(state.activeRequests, 0)
		assert.equal(state.successCount, 0)
		assert.equal(state.failureCount, 0)
		assert.equal(state.reservedTokens, 0)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("reserves capacity at execution when two processes were created before consumption", () =>
	Effect.gen(function* () {
		const started = yield* Deferred.make<void>()
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(
									config.id === "primary"
										? Stream.fromEffect(Deferred.succeed(started, void 0)).pipe(
												Stream.flatMap(() => Stream.never),
											)
										: Stream.succeed(completed(request.model)),
								),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const primary = { ...deployment("primary"), limits: { maxConcurrent: 1 } }
		const fallback = deployment("fallback")
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [primary, fallback],
			modelRoutes: [{ model: "chat", deployments: ["primary"], fallback: ["fallback"] }],
		})
		const { route, runtime } = yield* acquire(declarations)
		const first = yield* route.generate({ model: "chat", input: [] })
		const second = yield* route.generate({ model: "chat", input: [] })
		const fiber = yield* Stream.runDrain(first.events).pipe(Effect.forkChild)
		yield* Deferred.await(started)
		assert.equal((yield* runtime.state("primary")).activeRequests, 1)
		assert.equal((yield* second.response).model, "chat")
		assert.deepEqual(yield* Ref.get(log), ["open:primary", "open:fallback"])
		yield* first.cancel
		yield* Fiber.await(fiber)
		assert.equal((yield* runtime.state("primary")).activeRequests, 0)
		assert.deepEqual(
			(yield* runtime.available([primary])).map((value) => value.id),
			["primary"],
		)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("persists terminal usage and cost once and restores them in a new runtime", () =>
	Effect.gen(function* () {
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: () =>
				Effect.succeed({
					generate: (request) => Process.make(Stream.succeed(completed(request.model))),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary")],
			modelRoutes: [{ model: "chat", deployments: ["primary"] }],
		})
		const { route, runtime } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: "hello" })
		yield* process.response
		yield* process.terminal
		yield* Stream.runCollect(process.events)
		const state = yield* runtime.state("primary")
		assert.equal(state.successCount, 1)
		assert.equal(state.inputTokens, 2)
		assert.equal(state.outputTokens, 3)
		assert.equal(state.totalCost, 8)
		assert.equal(state.activeRequests, 0)
		assert.equal(state.reservedTokens, 0)
		const restored = yield* RoutingRuntime.make(declarations.deployments)
		assert.equal((yield* restored.state("primary")).successCount, 1)
		assert.equal((yield* restored.state("primary")).totalCost, 8)
		const persistence = yield* Persistence.Persistence
		const stored = yield* persistence.state(RoutingRuntime.declaration).get("snapshot")
		assert.equal(Option.isSome(stored), true)
		if (Option.isSome(stored)) assert.deepEqual(stored.value.reservations, {})
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect(
	"decodes request fields before invoking a provider and preserves nested issue paths",
	() =>
		Effect.gen(function* () {
			const calls = yield* Ref.make(0)
			const contract = ProviderContract.make({
				id: "fixture",
				endpoints: [{ id: "generation", parameters: [], streaming: true }],
				runtime: () =>
					Effect.succeed({
						generate: (request) =>
							Ref.update(calls, (count) => count + 1).pipe(
								Effect.flatMap(() =>
									Process.make(Stream.succeed(completed(request.model))),
								),
							),
					} satisfies ProviderContract.ProviderRuntime),
			})
			const declarations = yield* snapshot({
				providers: [contract],
				deployments: [deployment("primary")],
				modelRoutes: [{ model: "chat", deployments: ["primary"] }],
			})
			const { route } = yield* acquire(declarations)
			const invalid = yield* route
				.generate({
					model: "chat",
					input: [{ type: "message", role: "not-a-role", content: "hello" }],
				})
				.pipe(Effect.flip)
			assert.equal(invalid._tag, "RouteInvalidRequest")
			if (invalid._tag === "RouteInvalidRequest")
				assert.ok(
					invalid.issues?.some(
						(issue) =>
							issue.path[0] === "input" &&
							issue.path[1] === 0 &&
							issue.path.includes("role"),
					),
				)
			const unknown = yield* route.generate({ model: "missing", input: [] }).pipe(Effect.flip)
			assert.equal(unknown._tag, "RouteUnknownModel")
			assert.equal(yield* Ref.get(calls), 0)
		}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("settles a failed attempt when its failure hook fails and prevents provider replay", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const failure = ProviderError.make({
			kind: "unavailable",
			message: "upstream",
			retryable: true,
		})
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(
									(config.id === "primary"
										? Stream.fail(failure)
										: Stream.succeed(completed(request.model))
									).pipe(Stream.ensuring(record(log, `close:${config.id}`))),
								),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [{ model: "chat", deployments: ["primary"], fallback: ["fallback"] }],
			hooks: [
				{
					id: "broken",
					afterFailure: () =>
						record(log, "failure-hook").pipe(
							Effect.andThen(Effect.fail("hook failure")),
						),
					onFinalize: ({ outcome }) => record(log, `finalize:${outcome}`),
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const failed = yield* route.generate({ model: "chat", input: [] }).pipe(
			Effect.flatMap((process) => process.response),
			Effect.flip,
		)
		assert.equal((failed as { readonly _tag?: string })._tag, "RouteHookFailed")
		const observed = yield* Ref.get(log)
		assert.deepEqual(
			observed.filter((item) => item.startsWith("open:")),
			["open:primary"],
		)
		assert.equal(observed.filter((item) => item === "close:primary").length, 1)
		assert.equal(observed.filter((item) => item === "finalize:failure").length, 1)
		const state = yield* runtime.state("primary")
		assert.equal(state.activeRequests, 0)
		assert.equal(state.reservedTokens, 0)
		assert.equal(state.failureCount, 1)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("finalizes a before-attempt hook failure without opening a provider", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: () =>
				Effect.succeed({
					generate: () =>
						record(log, "provider").pipe(
							Effect.flatMap(() =>
								Process.make(Stream.succeed(completed("private-primary"))),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary")],
			modelRoutes: [{ model: "chat", deployments: ["primary"] }],
			hooks: [
				{
					id: "block",
					beforeAttempt: () => Effect.fail("blocked"),
					onFinalize: ({ outcome }) => record(log, `finalize:${outcome}`),
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const failure = yield* route.generate({ model: "chat", input: [] }).pipe(
			Effect.flatMap((process) => process.response),
			Effect.flip,
		)
		assert.equal((failure as { readonly _tag?: string })._tag, "RouteHookFailed")
		assert.equal((yield* Ref.get(log)).includes("provider"), false)
		assert.equal((yield* Ref.get(log)).filter((item) => item === "finalize:failure").length, 1)
		assert.equal((yield* runtime.state("primary")).activeRequests, 0)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("runs request error once only after all fallback attempts fail", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const failure = ProviderError.make({
			kind: "unavailable",
			message: "down",
			retryable: true,
		})
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: () =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() => Process.make(Stream.fail(failure))),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [{ model: "chat", deployments: ["primary"], fallback: ["fallback"] }],
			hooks: [
				{
					id: "observe",
					onError: () => record(log, "request-error"),
				},
			],
		})
		const { route } = yield* acquire(declarations)
		yield* route.generate({ model: "chat", input: [] }).pipe(
			Effect.flatMap((process) => process.response),
			Effect.flip,
		)
		const observed = yield* Ref.get(log)
		assert.deepEqual(
			observed.filter((item) => item.startsWith("open:")),
			["open:primary", "open:fallback"],
		)
		assert.equal(observed.filter((item) => item === "request-error").length, 1)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("does not run request error during a successful fallback", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const failure = ProviderError.make({
			kind: "unavailable",
			message: "down",
			retryable: true,
		})
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(
									config.id === "primary"
										? Stream.fail(failure)
										: Stream.succeed(completed(request.model)),
								),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [{ model: "chat", deployments: ["primary"], fallback: ["fallback"] }],
			hooks: [{ id: "observe", onError: () => record(log, "request-error") }],
		})
		const { route } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		assert.equal((yield* process.response).model, "chat")
		assert.equal((yield* Ref.get(log)).includes("request-error"), false)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("accounts a response.failed terminal as a failed attempt without replay", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(
									Stream.succeed(
										config.id === "primary"
											? {
													type: "response.failed",
													sequence_number: 1,
													response: {
														...response(request.model, "failed"),
														error: {
															code: "upstream",
															message: "failed",
														},
													},
												}
											: completed(request.model),
									),
								),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [{ model: "chat", deployments: ["primary"], fallback: ["fallback"] }],
			hooks: [
				{
					id: "observe",
					afterResponse: ({ response }) => record(log, `response:${response.status}`),
					afterSuccess: () => record(log, "unexpected-success"),
					onError: () => record(log, "request-error"),
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		const result = yield* process.response
		assert.equal(result.status, "failed")
		assert.deepEqual(yield* Ref.get(log), ["open:primary", "response:failed", "request-error"])
		const state = yield* runtime.state("primary")
		assert.equal(state.failureCount, 1)
		assert.equal(state.successCount, 0)
		assert.equal(state.activeRequests, 0)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("cancels an idle process without opening a provider or reserving capacity", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: () =>
				Effect.succeed({
					generate: () =>
						record(log, "provider").pipe(
							Effect.flatMap(() => Process.make(Stream.never)),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary")],
			modelRoutes: [{ model: "chat", deployments: ["primary"] }],
			hooks: [
				{
					id: "observe",
					onCancel: () => record(log, "cancel"),
					onFinalize: () => record(log, "finalize"),
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		yield* process.cancel
		yield* process.cancel
		const responseExit = yield* Effect.exit(process.response)
		const eventsExit = yield* Effect.exit(Stream.runCollect(process.events))
		assert.equal(Exit.isFailure(responseExit), true)
		assert.equal(Exit.isSuccess(eventsExit), true)
		if (Exit.isSuccess(eventsExit)) assert.deepEqual(eventsExit.value, [])
		assert.deepEqual(yield* Ref.get(log), ["cancel"])
		const state = yield* runtime.state("primary")
		assert.equal(state.activeRequests, 0)
		assert.equal(state.reservedTokens, 0)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("settles accounting when an after-success hook fails", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: () =>
				Effect.succeed({
					generate: (request) => Process.make(Stream.succeed(completed(request.model))),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary")],
			modelRoutes: [{ model: "chat", deployments: ["primary"] }],
			hooks: [
				{
					id: "broken",
					afterSuccess: () => Effect.fail("after-success failed"),
					onFinalize: ({ outcome }) => record(log, `finalize:${outcome}`),
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const failure = yield* route.generate({ model: "chat", input: [] }).pipe(
			Effect.flatMap((process) => process.response),
			Effect.flip,
		)
		assert.equal((failure as { readonly _tag?: string })._tag, "RouteHookFailed")
		assert.equal((yield* Ref.get(log)).filter((item) => item === "finalize:failure").length, 1)
		const state = yield* runtime.state("primary")
		assert.equal(state.activeRequests, 0)
		assert.equal(state.reservedTokens, 0)
		assert.equal(state.failureCount, 1)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("checks access before policy ranking or provider execution", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: () =>
				Effect.succeed({
					generate: (request) =>
						record(log, `provider:${request.model}`).pipe(
							Effect.flatMap(() =>
								Process.make(Stream.succeed(completed(request.model))),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary")],
			modelRoutes: [
				{
					model: "chat",
					deployments: ["primary"],
					access: { metadataKey: "tenant", allow: ["allowed"] },
					policy: "rank",
				},
			],
			policies: [
				{
					id: "rank",
					rank: (_request, candidates) =>
						record(log, "policy").pipe(Effect.as(candidates)),
				},
			],
		})
		const { route } = yield* acquire(declarations)
		const failure = yield* route
			.generate({
				model: "chat",
				input: [],
				metadata: { tenant: "denied" },
			})
			.pipe(
				Effect.flatMap((process) => process.response),
				Effect.flip,
			)
		assert.equal((failure as { readonly _tag?: string })._tag, "RoutingAccessDenied")
		assert.deepEqual(yield* Ref.get(log), [])
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("rejects a pipeline that injects a deployment outside the route candidate set", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `provider:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(Stream.succeed(completed(request.model))),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("outside")],
			modelRoutes: [{ model: "chat", deployments: ["primary"], pipelines: ["inject"] }],
			pipelines: [
				{
					id: "inject",
					run: (context) =>
						Effect.succeed({
							...context,
							candidateDeployments: [
								...context.candidateDeployments,
								deployment("outside"),
							],
						}),
				},
			],
		})
		const { route } = yield* acquire(declarations)
		const failure = yield* route.generate({ model: "chat", input: [] }).pipe(
			Effect.flatMap((process) => process.response),
			Effect.flip,
		)
		assert.equal((failure as { readonly _tag?: string })._tag, "RoutingInvalidCandidates")
		assert.deepEqual(yield* Ref.get(log), [])
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("allows middleware to reject a request before pipelines and policy run", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const denied = ProviderError.make({
			kind: "unauthorized",
			message: "denied",
			retryable: false,
		})
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: () =>
				Effect.succeed({
					generate: (request) =>
						record(log, "provider").pipe(
							Effect.flatMap(() =>
								Process.make(Stream.succeed(completed(request.model))),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary")],
			modelRoutes: [
				{
					model: "chat",
					deployments: ["primary"],
					pipelines: ["prepare"],
					policy: "rank",
					middleware: ["auth"],
				},
			],
			middleware: [{ id: "auth", wrap: () => () => Effect.fail(denied) }],
			pipelines: [
				{
					id: "prepare",
					run: (context) => record(log, "pipeline").pipe(Effect.as(context)),
				},
			],
			policies: [
				{
					id: "rank",
					rank: (_request, candidates) =>
						record(log, "policy").pipe(Effect.as(candidates)),
				},
			],
		})
		const { route } = yield* acquire(declarations)
		const failure = yield* route.generate({ model: "chat", input: [] }).pipe(
			Effect.flatMap((process) => process.response),
			Effect.flip,
		)
		assert.equal(failure, denied)
		assert.deepEqual(yield* Ref.get(log), [])
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("runs request afterResponse for a middleware response without attempt context", () =>
	Effect.gen(function* () {
		const providerCalls = yield* Ref.make<readonly string[]>([])
		const responses = yield* Ref.make<readonly ResponseHookContext[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: () =>
				Effect.succeed({
					generate: (request) =>
						record(providerCalls, request.model).pipe(
							Effect.flatMap(() =>
								Process.make(Stream.succeed(completed(request.model))),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [],
			modelRoutes: [{ model: "chat", deployments: [], middleware: ["cache"] }],
			middleware: [
				{
					id: "cache",
					wrap: () => (context) => Process.make(Stream.succeed(completed(context.model))),
				},
			],
			hooks: [
				{
					id: "observe",
					afterSuccess: () => record(providerCalls, "unexpected-success"),
					afterResponse: (context) =>
						Ref.update(responses, (values) => [...values, context]),
				},
			],
		})
		const { route } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		assert.equal((yield* process.response).model, "chat")
		const observed = yield* Ref.get(responses)
		assert.equal(observed.length, 1)
		assert.equal(observed[0]?.model, "chat")
		assert.equal(observed[0]?.response.model, "chat")
		assert.equal(observed[0]?.deployment, undefined)
		assert.equal(observed[0]?.attempt, undefined)
		assert.deepEqual(yield* Ref.get(providerCalls), [])
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("fails afterResponse once without replaying a completed response", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const seenEvents = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(Stream.succeed(completed(request.model))),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [
				{
					model: "chat",
					deployments: ["primary"],
					fallback: ["fallback"],
					retry: { retriesPerDeployment: 1, maxAttempts: 4 },
				},
			],
			hooks: [
				{
					id: "observe",
					afterResponse: () =>
						record(log, "after-response").pipe(
							Effect.andThen(Effect.fail("response hook failed")),
						),
					onError: ({ firstEventObserved }) =>
						record(log, `request-error:${firstEventObserved}`),
				},
			],
		})
		const { route } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		const failure = yield* process.response.pipe(Effect.flip)
		const eventsExit = yield* Effect.exit(
			Stream.runForEach(process.events, (event) =>
				Ref.update(seenEvents, (events) => [...events, event.type]),
			),
		)
		assert.equal((failure as { readonly _tag?: string })._tag, "RouteHookFailed")
		assert.equal((failure as { readonly hook?: string }).hook, "afterResponse")
		assert.equal(Exit.isFailure(eventsExit), true)
		assert.deepEqual(yield* Ref.get(seenEvents), [])
		const observed = yield* Ref.get(log)
		assert.deepEqual(
			observed.filter((item) => item.startsWith("open:")),
			["open:primary"],
		)
		assert.equal(observed.filter((item) => item === "after-response").length, 1)
		assert.equal(observed.filter((item) => item === "request-error:true").length, 1)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect(
	"cancels a suspended request afterResponse hook once without replay or request error",
	() =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>()
			const released = yield* Deferred.make<void>()
			const log = yield* Ref.make<readonly string[]>([])
			const contract = ProviderContract.make({
				id: "fixture",
				endpoints: [{ id: "generation", parameters: [], streaming: true }],
				runtime: (config) =>
					Effect.succeed({
						generate: (request) =>
							record(log, `open:${config.id}`).pipe(
								Effect.flatMap(() =>
									Process.make(Stream.succeed(completed(request.model))),
								),
							),
					} satisfies ProviderContract.ProviderRuntime),
			})
			const declarations = yield* snapshot({
				providers: [contract],
				deployments: [deployment("primary"), deployment("fallback")],
				modelRoutes: [{ model: "chat", deployments: ["primary"], fallback: ["fallback"] }],
				hooks: [
					{
						id: "observe",
						afterResponse: () =>
							record(log, "after-response").pipe(
								Effect.andThen(Deferred.succeed(entered, void 0)),
								Effect.andThen(Effect.never),
								Effect.ensuring(
									record(log, "hook:released").pipe(
										Effect.andThen(Deferred.succeed(released, void 0)),
									),
								),
							),
						onCancel: () => record(log, "cancel"),
						onError: () => record(log, "request-error"),
					},
				],
			})
			const { route, runtime } = yield* acquire(declarations)
			const process = yield* route.generate({ model: "chat", input: [] })
			const fiber = yield* process.response.pipe(Effect.forkChild)
			yield* Deferred.await(entered)
			yield* process.cancel
			yield* process.cancel
			yield* Deferred.await(released)
			const responseExit = yield* Fiber.await(fiber)
			assert.equal(Exit.isFailure(responseExit), true)
			if (Exit.isFailure(responseExit))
				assert.equal(Cause.hasInterruptsOnly(responseExit.cause), true)
			const observed = yield* Ref.get(log)
			assert.deepEqual(
				observed.filter((item) => item.startsWith("open:")),
				["open:primary"],
			)
			assert.equal(observed.filter((item) => item === "after-response").length, 1)
			assert.equal(observed.filter((item) => item === "hook:released").length, 1)
			assert.equal(observed.filter((item) => item === "cancel").length, 1)
			assert.equal(observed.includes("request-error"), false)
			assert.equal((yield* runtime.state("primary")).activeRequests, 0)
			assert.equal((yield* runtime.state("primary")).reservedTokens, 0)
		}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("honors retries per deployment before switching to fallback", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const failure = ProviderError.make({
			kind: "unavailable",
			message: "primary unavailable",
			retryable: true,
		})
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(
									config.id === "primary"
										? Stream.fail(failure)
										: Stream.succeed(completed(request.model)),
								),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [
				{
					model: "chat",
					deployments: ["primary"],
					fallback: ["fallback"],
					retry: { retriesPerDeployment: 1 },
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		assert.equal((yield* process.response).model, "chat")
		assert.deepEqual(yield* Ref.get(log), ["open:primary", "open:primary", "open:fallback"])
		assert.equal((yield* runtime.state("primary")).failureCount, 2)
		assert.equal((yield* runtime.state("fallback")).successCount, 1)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("stops retries and fallback at maxAttempts", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const failure = ProviderError.make({
			kind: "unavailable",
			message: "primary unavailable",
			retryable: true,
		})
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: () =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() => Process.make(Stream.fail(failure))),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [
				{
					model: "chat",
					deployments: ["primary"],
					fallback: ["fallback"],
					retry: { retriesPerDeployment: 2, maxAttempts: 2 },
				},
			],
		})
		const { route, runtime } = yield* acquire(declarations)
		const failed = yield* route.generate({ model: "chat", input: [] }).pipe(
			Effect.flatMap((process) => process.response),
			Effect.flip,
		)
		assert.equal((failed as { readonly _tag?: string })._tag, "ProviderError")
		assert.equal((failed as { readonly kind?: string }).kind, "unavailable")
		assert.deepEqual(yield* Ref.get(log), ["open:primary", "open:primary"])
		assert.equal((yield* runtime.state("primary")).failureCount, 2)
		assert.equal((yield* runtime.state("fallback")).failureCount, 0)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("honors retryableKinds before replaying a provider failure", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const failure = ProviderError.make({
			kind: "invalid_request",
			message: "cannot retry this kind",
			retryable: true,
		})
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(
									config.id === "primary"
										? Stream.fail(failure)
										: Stream.succeed(completed(request.model)),
								),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [deployment("primary"), deployment("fallback")],
			modelRoutes: [
				{
					model: "chat",
					deployments: ["primary"],
					fallback: ["fallback"],
					retry: { retriesPerDeployment: 2, retryableKinds: ["unavailable"] },
				},
			],
		})
		const { route } = yield* acquire(declarations)
		const failed = yield* route.generate({ model: "chat", input: [] }).pipe(
			Effect.flatMap((process) => process.response),
			Effect.flip,
		)
		assert.equal((failed as { readonly _tag?: string })._tag, "ProviderError")
		assert.equal((failed as { readonly kind?: string }).kind, "invalid_request")
		assert.deepEqual(yield* Ref.get(log), ["open:primary"])
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("ranks cost using both pricing field spellings", () =>
	Effect.sync(() => {
		const aliasCheap = { ...deployment("alias-cheap"), pricing: { input: 1, output: 1 } }
		const perTokenExpensive = {
			...deployment("per-token-expensive"),
			pricing: { inputPerToken: 3, outputPerToken: 3 },
		}
		const first = Policies.cost.rank(
			{ model: "chat", input: [] },
			[aliasCheap, perTokenExpensive],
			{ signals: {}, metrics: {} },
		)
		assert.deepEqual(
			first.map((candidate) => candidate.id),
			["alias-cheap", "per-token-expensive"],
		)
		const perTokenCheap = {
			...deployment("per-token-cheap"),
			pricing: { inputPerToken: 1, outputPerToken: 1 },
		}
		const aliasExpensive = {
			...deployment("alias-expensive"),
			pricing: { input: 3, output: 3 },
		}
		const second = Policies.cost.rank(
			{ model: "chat", input: [] },
			[aliasExpensive, perTokenCheap],
			{ signals: {}, metrics: {} },
		)
		assert.deepEqual(
			second.map((candidate) => candidate.id),
			["per-token-cheap", "alias-expensive"],
		)
	}),
)

it.effect("composes policy narrowing with the selected strategy", () =>
	Effect.gen(function* () {
		const log = yield* Ref.make<readonly string[]>([])
		const contract = ProviderContract.make({
			id: "fixture",
			endpoints: [{ id: "generation", parameters: [], streaming: true }],
			runtime: (config) =>
				Effect.succeed({
					generate: (request) =>
						record(log, `open:${config.id}`).pipe(
							Effect.flatMap(() =>
								Process.make(Stream.succeed(completed(request.model))),
							),
						),
				} satisfies ProviderContract.ProviderRuntime),
		})
		const declarations = yield* snapshot({
			providers: [contract],
			deployments: [
				{ ...deployment("slow"), pricing: { input: 4, output: 4 } },
				{ ...deployment("cheap"), pricing: { inputPerToken: 1, outputPerToken: 1 } },
				{ ...deployment("excluded"), pricing: { input: 0, output: 0 } },
			],
			modelRoutes: [
				{
					model: "chat",
					deployments: ["slow", "cheap", "excluded"],
					policy: "narrow",
				},
			],
			policies: [
				{
					id: "narrow",
					strategy: "cost",
					rank: (_request, candidates) =>
						Effect.sync(() =>
							candidates.filter((candidate) => candidate.id !== "excluded"),
						),
				},
			],
		})
		const { route } = yield* acquire(declarations)
		const process = yield* route.generate({ model: "chat", input: [] })
		yield* process.response
		assert.deepEqual(yield* Ref.get(log), ["open:cheap"])
	}).pipe(Effect.provide(Persistence.layerMemory)),
)
