import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import {
	Cause,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Result,
	Schema,
} from "effect"
import { HttpApi as EffectHttpApi } from "effect/http-api"
import * as Capability from "@better-router/core/Capability"
import * as Api from "@better-router/core/Api"
import * as Persistence from "@better-router/core/Persistence"
import * as Plugin from "@better-router/core/Plugin"
import * as Router from "@better-router/core/Router"

class LifecycleService extends Context.Service<LifecycleService, { readonly value: string }>()(
	"BetterRouterLifecycleFixture",
) {}

class ProducedService extends Context.Service<ProducedService, { readonly value: string }>()(
	"BetterRouterProducedFixture",
) {}

const declaration = Capability.make({
	id: "lifecycle.declaration",
	version: 1,
	kind: "routing",
	projections: [],
} as const)

const append = (seen: Ref.Ref<readonly string[]>, message: string) =>
	Ref.update(seen, (values) => [...values, message])

it.effect("builds plugin Layers in declaration order for sibling services", () =>
	Effect.gen(function* () {
		const producer = Plugin.make({
			id: "layer-producer",
			capabilities: [] as const,
			config: {},
			layer: Layer.succeed(ProducedService, { value: "produced" }),
		})
		const consumer = Plugin.make({
			id: "layer-consumer",
			capabilities: [] as const,
			config: {},
			layer: Layer.effect(
				LifecycleService,
				Effect.map(ProducedService, ({ value }) => ({ value })),
			),
			init: () => Effect.map(LifecycleService, ({ value }) => `initialized:${value}`),
		})
		const router = yield* Effect.fromResult(
			Router.make({ plugins: [producer, consumer] as const }),
		)
		const runtime = yield* Router.runtime(router)

		assert.deepEqual(runtime.plugins, [
			{ id: "layer-producer", runtime: undefined },
			{ id: "layer-consumer", runtime: "initialized:produced" },
		])
	}),
)

it.effect("supplies default memory persistence to plugin Layers and init", () =>
	Effect.gen(function* () {
		const state = {
			namespace: "router-lifecycle-startup",
			schema: Schema.Struct({ marker: Schema.String }),
		} as const
		const plugin = Plugin.make({
			id: "default-persistence",
			capabilities: [] as const,
			config: { persistence: [state] as const },
			layer: Layer.effect(
				LifecycleService,
				Effect.gen(function* () {
					const persistence = yield* Persistence.Persistence
					yield* persistence.state(state).set("entry", { marker: "layer-created" })
					return { value: "provided" }
				}),
			),
			init: () =>
				Effect.gen(function* () {
					const service = yield* LifecycleService
					const persistence = yield* Persistence.Persistence
					const stored = yield* persistence.state(state).get("entry")
					assert.equal(service.value, "provided")
					assert.deepEqual(Option.getOrUndefined(stored), { marker: "layer-created" })
					return stored
				}),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		const runtime = yield* Router.runtime(router)

		assert.deepEqual(runtime.plugins, [
			{ id: "default-persistence", runtime: Option.some({ marker: "layer-created" }) },
		])
	}),
)

it.effect("runs persistence migrations after Layer binding and before plugin init", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const state = {
			namespace: "router-migration-order",
			schema: Schema.Struct({ value: Schema.String }),
			migrations: [
				{
					id: 1,
					name: "ready",
					run: Effect.asVoid(LifecycleService).pipe(
						Effect.andThen(append(seen, "migration")),
					),
				},
			] as const,
		} as const
		const plugin = Plugin.make({
			id: "migration-order",
			capabilities: [] as const,
			config: { persistence: [state] as const },
			layer: Layer.effect(
				LifecycleService,
				append(seen, "layer").pipe(Effect.as({ value: "provided" })),
			),
			init: () => append(seen, "init"),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		yield* Router.runtime(router)

		assert.deepEqual(yield* Ref.get(seen), ["layer", "migration", "init"])
	}),
)

it.effect("runs migrations in plugin declaration order before any init callback", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const migration = (namespace: string, id: string) => ({
			namespace,
			schema: Schema.String,
			migrations: [
				{
					id: 1,
					name: id,
					run: append(seen, `migration:${id}`),
				},
			] as const,
		})
		const first = Plugin.make({
			id: "migration-first",
			capabilities: [] as const,
			config: { persistence: [migration("router-migration-first", "first")] as const },
			init: () => append(seen, "init:first"),
		})
		const second = Plugin.make({
			id: "migration-second",
			capabilities: [] as const,
			config: { persistence: [migration("router-migration-second", "second")] as const },
			init: () => append(seen, "init:second"),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [first, second] as const }))
		yield* Router.runtime(router)

		assert.deepEqual(yield* Ref.get(seen), [
			"migration:first",
			"migration:second",
			"init:first",
			"init:second",
		])
	}),
)

it.effect("rolls back Layer resources when a startup migration fails", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const plugin = Plugin.make({
			id: "migration-failure",
			capabilities: [] as const,
			config: {
				persistence: [
					{
						namespace: "router-migration-failure",
						schema: Schema.String,
						migrations: [
							{ id: 1, name: "fail", run: Effect.fail("migration rejected") },
						],
					},
				] as const,
			},
			layer: Layer.effect(
				LifecycleService,
				Effect.acquireRelease(
					append(seen, "acquire").pipe(Effect.as({ value: "owned" })),
					() => append(seen, "release"),
				),
			),
			init: () => append(seen, "must-not-init"),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		const error = yield* Effect.flip(Router.runtime(router))

		assert.equal(error._tag, "RouterCompositionError")
		if (error._tag === "RouterCompositionError") {
			assert.equal(error.phase, "persistence")
			assert.equal(error.plugin, "migration-failure")
		}
		assert.deepEqual(yield* Ref.get(seen), ["acquire", "release"])
	}),
)

it.effect("initializes plugins in order with their services and the complete snapshot", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const first = Plugin.make({
			id: "first",
			capabilities: [] as const,
			config: {},
			layer: Layer.succeed(LifecycleService, { value: "provided" }),
			init: (snapshot: Plugin.PluginInitContext) =>
				Effect.gen(function* () {
					const service = yield* LifecycleService
					assert.deepEqual(
						snapshot.plugins.map(({ id }) => id),
						["first", "second"],
					)
					assert.equal(
						snapshot.capabilities.some(({ id }) => id === declaration.id),
						true,
					)
					yield* append(seen, `first:${service.value}`)
					return "first-runtime"
				}),
		})
		const second = Plugin.make({
			id: "second",
			capabilities: [declaration] as const,
			config: {},
			init: () => append(seen, "second").pipe(Effect.as("second-runtime")),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [first, second] as const }))
		const runtime = yield* Router.runtime(router)

		assert.deepEqual(yield* Ref.get(seen), ["first:provided", "second"])
		assert.deepEqual(runtime.plugins, [
			{ id: "first", runtime: "first-runtime" },
			{ id: "second", runtime: "second-runtime" },
		])
		assert.equal(runtime.registry, router.registry)
	}),
)

it.effect("keeps successful resources alive until the caller's Scope closes", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const plugin = Plugin.make({
			id: "owned-resource",
			capabilities: [] as const,
			config: {},
			layer: Layer.effect(
				LifecycleService,
				Effect.acquireRelease(
					append(seen, "acquire").pipe(Effect.as({ value: "owned" })),
					() => append(seen, "release"),
				),
			),
			init: () =>
				Effect.addFinalizer(() => append(seen, "init-release")).pipe(
					Effect.andThen(append(seen, "init")),
				),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		yield* Effect.scoped(
			Router.runtime(router).pipe(
				Effect.andThen(
					Ref.get(seen).pipe(
						Effect.map((values) => assert.deepEqual(values, ["acquire", "init"])),
					),
				),
			),
		)

		assert.deepEqual(yield* Ref.get(seen), ["acquire", "init", "init-release", "release"])
	}),
)

it.effect("immediately rolls back resources when a later plugin init fails", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const first = Plugin.make({
			id: "acquired",
			capabilities: [] as const,
			config: {},
			layer: Layer.effect(
				LifecycleService,
				Effect.acquireRelease(
					append(seen, "layer-acquire").pipe(Effect.as({ value: "owned" })),
					() => append(seen, "layer-release"),
				),
			),
			init: () => Effect.addFinalizer(() => append(seen, "init-release")),
		})
		const failed = Plugin.make({
			id: "failed",
			capabilities: [] as const,
			config: {},
			init: () => Effect.fail("initialization rejected"),
		})
		const skipped = Plugin.make({
			id: "skipped",
			capabilities: [] as const,
			config: {},
			init: () => append(seen, "must-not-init"),
		})
		const router = yield* Effect.fromResult(
			Router.make({ plugins: [first, failed, skipped] as const }),
		)
		const error = yield* Effect.flip(Router.runtime(router))

		assert.equal(error._tag, "RouterPluginStartFailed")
		if (error._tag === "RouterPluginStartFailed") assert.equal(error.plugin, "failed")
		assert.deepEqual(yield* Ref.get(seen), ["layer-acquire", "init-release", "layer-release"])
	}),
)

it.effect("labels init defects and releases resources acquired by earlier plugins", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const owned = Plugin.make({
			id: "defect-resource",
			capabilities: [] as const,
			config: {},
			layer: Layer.effect(
				LifecycleService,
				Effect.acquireRelease(
					append(seen, "acquire").pipe(Effect.as({ value: "owned" })),
					() => append(seen, "release"),
				),
			),
		})
		const failed = Plugin.make({
			id: "defective-init",
			capabilities: [] as const,
			config: {},
			init: () => Effect.die("initialization defect"),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [owned, failed] as const }))
		const error = yield* Effect.flip(Router.runtime(router))

		assert.equal(error._tag, "RouterPluginStartFailed")
		if (error._tag === "RouterPluginStartFailed") {
			assert.equal(error.plugin, "defective-init")
			assert.deepEqual(
				Cause.findDefect(error.cause as Cause.Cause<unknown>),
				Result.succeed("initialization defect"),
			)
		}
		assert.deepEqual(yield* Ref.get(seen), ["acquire", "release"])
	}),
)

it.effect("suspends synchronous init factory defects inside startup error handling", () =>
	Effect.gen(function* () {
		const plugin = Plugin.make({
			id: "sync-defective-init",
			capabilities: [] as const,
			config: {},
			init: () => JSON.parse("{") as never,
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		const error = yield* Effect.flip(Router.runtime(router))

		assert.equal(error._tag, "RouterPluginStartFailed")
		if (error._tag === "RouterPluginStartFailed") {
			assert.equal(error.plugin, "sync-defective-init")
			const defect = Cause.findDefect(error.cause as Cause.Cause<unknown>)
			assert.equal(Result.isSuccess(defect), true)
			if (Result.isSuccess(defect)) assert.ok(defect.success instanceof SyntaxError)
		}
	}),
)

it.effect("labels Layer defects and releases previously acquired resources", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const acquired = yield* Deferred.make<void>()
		const owned = Plugin.make({
			id: "layer-defect-resource",
			capabilities: [] as const,
			config: {},
			layer: Layer.effect(
				LifecycleService,
				Effect.acquireRelease(
					append(seen, "acquire").pipe(
						Effect.andThen(Deferred.succeed(acquired, void 0)),
						Effect.as({ value: "owned" }),
					),
					() => append(seen, "release"),
				),
			),
		})
		const failed = Plugin.make({
			id: "defective-layer",
			capabilities: [] as const,
			config: {},
			layer: Layer.effectDiscard(
				Deferred.await(acquired).pipe(Effect.andThen(Effect.die("Layer defect"))),
			),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [owned, failed] as const }))
		const error = yield* Effect.flip(Router.runtime(router))

		assert.equal(error._tag, "RouterPluginStartFailed")
		if (error._tag === "RouterPluginStartFailed") assert.equal(error.plugin, "defective-layer")
		assert.deepEqual(yield* Ref.get(seen), ["acquire", "release"])
	}),
)

it.effect("labels synchronous HTTP contract construction defects", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const api = EffectHttpApi.make("router-lifecycle-failing-http")
		const plugin = Plugin.make({
			id: "defective-http-contract",
			capabilities: [] as const,
			config: {
				http: [
					{
						id: "defective-http-contract",
						api,
						contract: Api.make({
							api,
							layer: () => JSON.parse("{") as never,
						}),
					},
				] as const,
			},
			layer: Layer.effect(
				LifecycleService,
				Effect.acquireRelease(
					append(seen, "acquire").pipe(Effect.as({ value: "owned" })),
					() => append(seen, "release"),
				),
			),
			init: () => Effect.addFinalizer(() => append(seen, "init-release")),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		const exit = yield* Effect.exit(Router.runtime(router))

		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) {
			const failure = Cause.findError(exit.cause)
			assert.equal(Result.isSuccess(failure), true)
			if (Result.isSuccess(failure)) {
				assert.equal(failure.success._tag, "RouterCompositionError")
				if (failure.success._tag === "RouterCompositionError")
					assert.equal(failure.success.phase, "http")
			}
		}
		assert.deepEqual(yield* Ref.get(seen), ["acquire", "init-release", "release"])
	}),
)

it.effect("labels plugin Layer startup failure and releases earlier Layers", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const acquired = yield* Deferred.make<void>()
		const first = Plugin.make({
			id: "layer-resource",
			capabilities: [] as const,
			config: {},
			layer: Layer.effect(
				LifecycleService,
				Effect.acquireRelease(
					append(seen, "acquire").pipe(
						Effect.andThen(Deferred.succeed(acquired, void 0)),
						Effect.as({ value: "owned" }),
					),
					() => append(seen, "release"),
				),
			),
		})
		const failure = Plugin.make({
			id: "failed-layer",
			capabilities: [] as const,
			config: {},
			layer: Layer.effectDiscard(
				Deferred.await(acquired).pipe(Effect.andThen(Effect.fail("layer rejected"))),
			),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [first, failure] as const }))
		const error = yield* Effect.flip(Router.runtime(router))

		assert.equal(error._tag, "RouterPluginStartFailed")
		if (error._tag === "RouterPluginStartFailed") assert.equal(error.plugin, "failed-layer")
		assert.deepEqual(yield* Ref.get(seen), ["acquire", "release"])
	}),
)

it.effect("preserves interruption and finalizes resources while init is suspended", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const started = yield* Deferred.make<void>()
		const plugin = Plugin.make({
			id: "cancelled-init",
			capabilities: [] as const,
			config: {},
			layer: Layer.effect(
				LifecycleService,
				Effect.acquireRelease(
					append(seen, "acquire").pipe(Effect.as({ value: "owned" })),
					() => append(seen, "release"),
				),
			),
			init: () =>
				Effect.addFinalizer(() => append(seen, "init-release")).pipe(
					Effect.andThen(Deferred.succeed(started, void 0)),
					Effect.andThen(Effect.never),
				),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		const fiber = yield* Router.runtime(router).pipe(Effect.forkChild)
		yield* Deferred.await(started)
		yield* Fiber.interrupt(fiber)
		const exit = yield* Fiber.await(fiber)

		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) assert.equal(Cause.hasInterruptsOnly(exit.cause), true)
		assert.deepEqual(yield* Ref.get(seen), ["acquire", "init-release", "release"])
	}),
)

it.effect("turns an untyped missing init service into a plugin-labelled failure", () =>
	Effect.gen(function* () {
		const plugin = {
			id: "missing-service",
			capabilities: [],
			config: {},
			init: () => Effect.asVoid(Effect.service(LifecycleService)),
		} as unknown as Plugin.AnyPlugin
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		const exit = yield* Effect.exit(
			Router.runtime(router) as unknown as Effect.Effect<
				Router.Service,
				Router.StartupError,
				never
			>,
		)

		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) {
			const failure = Cause.findError(exit.cause)
			assert.equal(Result.isSuccess(failure), true)
			if (Result.isSuccess(failure)) {
				assert.equal(failure.success._tag, "RouterPluginStartFailed")
				if (failure.success._tag === "RouterPluginStartFailed")
					assert.equal(failure.success.plugin, "missing-service")
			}
		}
	}),
)

it.effect("releases a running router when its owning program is interrupted", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const ready = yield* Deferred.make<void>()
		const plugin = Plugin.make({
			id: "running-router",
			capabilities: [] as const,
			config: {},
			layer: Layer.effect(
				LifecycleService,
				Effect.acquireRelease(
					append(seen, "acquire").pipe(Effect.as({ value: "owned" })),
					() => append(seen, "release"),
				),
			),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		const owner = yield* Effect.scoped(
			Router.runtime(router).pipe(
				Effect.andThen(Deferred.succeed(ready, void 0)),
				Effect.andThen(Effect.never),
			),
		).pipe(Effect.forkChild)
		yield* Deferred.await(ready)
		assert.deepEqual(yield* Ref.get(seen), ["acquire"])
		yield* Fiber.interrupt(owner)

		assert.deepEqual(yield* Ref.get(seen), ["acquire", "release"])
	}),
)

it.effect("exposes the same acquired runtime through Router.layer", () =>
	Effect.gen(function* () {
		const plugin = Plugin.make({
			id: "layer-runtime",
			capabilities: [] as const,
			config: {},
			init: () => Effect.succeed({ service: "ready" }),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		const runtime = yield* Router.RouterRuntime.pipe(Effect.provide(Router.layer(router)))

		assert.equal(runtime.registry, router.registry)
		assert.deepEqual(runtime.plugins, [{ id: "layer-runtime", runtime: { service: "ready" } }])
	}),
)
