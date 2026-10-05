import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Option,
	Ref,
	Result,
	Schema,
	SchemaIssue,
} from "effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import * as Persistence from "@better-router/core/Persistence"

const State = Schema.Struct({ count: Schema.Int })
const declaration = { namespace: "deployments", schema: State } as const

type DeclarationIssue = {
	readonly path: readonly (string | number)[]
}

const malformedDeclaration = (input: unknown): Persistence.PersistenceError => {
	const result = Persistence.makeDeclaration(input as Persistence.AnyDeclaration)
	assert.equal(Result.isFailure(result), true)
	if (Result.isFailure(result)) return result.failure
	return assert.fail("Expected makeDeclaration to reject malformed input")
}

const declarationIssuePaths = (failure: Persistence.PersistenceError) =>
	(
		failure as Persistence.PersistenceError & {
			readonly issues?: readonly DeclarationIssue[]
		}
	).issues?.map(({ path }) => path) ?? []

const issuePaths = (error: Persistence.StoreError) => {
	assert.ok(Schema.isSchemaError(error), "Expected SchemaError")
	if (!Schema.isSchemaError(error)) return assert.fail("Expected SchemaError")
	return SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map(
		(issue) => issue.path,
	)
}

it.effect("stores and decodes namespaced state through the memory layer", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		const missing = yield* store.get("primary")

		assert.equal(Option.isNone(missing), true)
		yield* store.set("primary", { count: 1 })
		const loaded = yield* store.get("primary")

		assert.deepEqual(Option.getOrUndefined(loaded), { count: 1 })
		assert.equal(yield* store.size, 1)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("rejects stale compare-and-set updates as typed conflicts", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		yield* store.set("primary", { count: 1 })
		const failure = yield* store
			.compareAndSet("primary", Option.some({ count: 0 }), Option.some({ count: 2 }))
			.pipe(Effect.flip)

		assert.equal((failure as { readonly _tag?: string })._tag, "PersistenceConflict")
		assert.equal((failure as { readonly namespace?: string }).namespace, "deployments")
		assert.equal((failure as { readonly key?: string }).key, "primary")
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it("rejects duplicate migration identifiers before a backend is touched", () => {
	const result = Persistence.makeDeclaration({
		namespace: "deployments",
		schema: State,
		migrations: [
			{ id: 1, name: "create", run: Effect.void },
			{ id: 1, name: "repeated", run: Effect.void },
		],
	})

	assert.equal(result._tag, "Failure")
	if (Result.isFailure(result)) {
		assert.equal((result.failure as { readonly _tag?: string })._tag, "PersistenceError")
		assert.equal((result.failure as { readonly kind?: string }).kind, "migration")
	}
})

it("rejects malformed persistence declarations with structured nested issue paths", () => {
	const cases = [
		{ input: null, path: [] },
		{ input: { namespace: "bad-schema", schema: "not-a-schema" }, path: ["schema"] },
		{ input: { schema: State }, path: ["namespace"] },
		{
			input: { namespace: "null-migration", schema: State, migrations: [null] },
			path: ["migrations", 0],
		},
		{
			input: {
				namespace: "bad-run",
				schema: State,
				migrations: [{ id: 1, name: "bad", run: "not-an-effect" }],
			},
			path: ["migrations", 0, "run"],
		},
		{ input: { namespace: "bad-version", schema: State, version: 0 }, path: ["version"] },
	] as const

	cases.forEach(({ input, path }) => {
		const failure = malformedDeclaration(input)
		assert.equal(failure._tag, "PersistenceError")
		assert.equal(typeof failure.namespace, "string")
		assert.ok(failure.message.length > 0)
		assert.ok(
			declarationIssuePaths(failure).some(
				(issuePath) =>
					issuePath.length === path.length &&
					issuePath.every((segment, index) => segment === path[index]),
			),
			`Expected issue path ${JSON.stringify(path)}`,
		)
	})
})

it.effect("rejects empty keys without creating a record", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		const failure = yield* store.get("").pipe(Effect.flip)

		assert.equal((failure as { readonly _tag?: string })._tag, "PersistenceError")
		assert.equal((failure as { readonly kind?: string }).kind, "invalid_key")
		assert.equal(yield* store.size, 0)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("atomically accumulates concurrent updates without losing writes", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		yield* Effect.forEach(
			Array.from({ length: 100 }, (_, index) => index),
			() =>
				store.update("primary", (current) =>
					Option.some({
						count: Option.getOrElse(current, () => ({ count: 0 })).count + 1,
					}),
				),
			{ concurrency: "unbounded", discard: true },
		)

		assert.deepEqual(Option.getOrUndefined(yield* store.get("primary")), { count: 100 })
		assert.equal(yield* store.size, 1)
		const removed = yield* store.update("primary", () => Option.none())
		assert.equal(Option.isNone(removed), true)
		assert.equal(yield* store.size, 0)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("allows exactly one concurrent compare-and-set to create an absent entry", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		const results = yield* Effect.forEach(
			Array.from({ length: 32 }, (_, count) => ({ count })),
			(state) => store.cas("primary", Option.none(), Option.some(state)).pipe(Effect.result),
			{ concurrency: "unbounded" },
		)
		const successes = results.filter(Result.isSuccess)
		const conflicts = results.filter(Result.isFailure)

		assert.equal(successes.length, 1)
		assert.equal(conflicts.length, 31)
		assert.ok(conflicts.every(({ failure }) => failure._tag === "PersistenceConflict"))
		assert.equal(yield* store.size, 1)
		const stored = yield* store.get("primary")
		assert.ok(Option.isSome(stored))
		if (Option.isSome(stored)) assert.ok(stored.value.count >= 0 && stored.value.count < 32)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("compares record values independently of insertion order and preserves inputs", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state({
			namespace: "usage",
			schema: Schema.Record(Schema.String, Schema.Int),
		})
		const initial = { input: 3, output: 5 } as const
		const expected = { output: 5, input: 3 } as const
		const next = { input: 4, output: 6 } as const
		const before = JSON.stringify({ initial, expected, next })

		yield* store.set("primary", initial)
		yield* store.compareAndSet("primary", Option.some(expected), Option.some(next))

		assert.deepEqual(Option.getOrUndefined(yield* store.get("primary")), next)
		assert.equal(JSON.stringify({ initial, expected, next }), before)
		yield* store.cas("primary", Option.some({ output: 6, input: 4 }), Option.none())
		assert.equal(Option.isNone(yield* store.get("primary")), true)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("rolls back a failed nested transaction while committing the outer transaction", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const first = persistence.state(declaration)
		const second = persistence.state({ ...declaration, namespace: "usage" })
		yield* persistence.transaction(
			Effect.gen(function* () {
				yield* first.set("primary", { count: 1 })
				const nested = yield* first
					.transaction(
						Effect.gen(function* () {
							yield* first.set("primary", { count: 2 })
							yield* second.set("primary", { count: 3 })
							return yield* Effect.fail("nested rollback")
						}),
					)
					.pipe(Effect.result)
				assert.ok(Result.isFailure(nested))
				if (Result.isFailure(nested)) assert.equal(nested.failure, "nested rollback")
				assert.deepEqual(Option.getOrUndefined(yield* first.get("primary")), { count: 1 })
				assert.equal(Option.isNone(yield* second.get("primary")), true)
				yield* second.set("primary", { count: 4 })
			}),
		)

		assert.deepEqual(Option.getOrUndefined(yield* first.get("primary")), { count: 1 })
		assert.deepEqual(Option.getOrUndefined(yield* second.get("primary")), { count: 4 })
		const rollback = yield* persistence
			.transaction(
				Effect.gen(function* () {
					yield* first.clear
					yield* second.set("primary", { count: 5 })
					return yield* Effect.fail("outer rollback")
				}),
			)
			.pipe(Effect.result)
		assert.ok(Result.isFailure(rollback))
		assert.deepEqual(Option.getOrUndefined(yield* first.get("primary")), { count: 1 })
		assert.deepEqual(Option.getOrUndefined(yield* second.get("primary")), { count: 4 })
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("rolls back interrupted transactions and releases the transaction lock", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		const started = yield* Deferred.make<void>()
		yield* store.set("primary", { count: 1 })
		const fiber = yield* store
			.transaction(
				Effect.gen(function* () {
					yield* store.set("primary", { count: 2 })
					yield* store.set("uncommitted", { count: 3 })
					yield* Deferred.succeed(started, void 0)
					return yield* Effect.never
				}),
			)
			.pipe(Effect.forkChild)
		yield* Deferred.await(started)
		yield* Fiber.interrupt(fiber)
		const exit = yield* Fiber.await(fiber)

		assert.ok(Exit.isFailure(exit))
		if (Exit.isFailure(exit)) assert.equal(Cause.hasInterruptsOnly(exit.cause), true)
		assert.deepEqual(Option.getOrUndefined(yield* store.get("primary")), { count: 1 })
		assert.equal(Option.isNone(yield* store.get("uncommitted")), true)
		yield* store.set("primary", { count: 4 })
		assert.deepEqual(Option.getOrUndefined(yield* store.get("primary")), { count: 4 })
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("commits concurrent transaction children before making their state visible", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		yield* persistence.transaction(
			Effect.forEach(
				Array.from({ length: 32 }, (_, index) => index),
				() =>
					store.update("primary", (current) =>
						Option.some({
							count: Option.getOrElse(current, () => ({ count: 0 })).count + 1,
						}),
					),
				{ concurrency: "unbounded", discard: true },
			),
		)

		assert.deepEqual(Option.getOrUndefined(yield* store.get("primary")), { count: 32 })
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("expires entries at the TTL boundary and purges expired entries from size", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		yield* store.set("permanent", { count: 1 })
		yield* store.set("temporary", { count: 2 }, { ttl: "10 seconds" })
		assert.equal(yield* store.size, 2)
		yield* TestClock.adjust("9 seconds")
		assert.deepEqual(Option.getOrUndefined(yield* store.get("temporary")), { count: 2 })
		yield* TestClock.adjust("1 second")

		assert.equal(yield* store.size, 1)
		assert.equal(Option.isNone(yield* store.get("temporary")), true)
		yield* store.cas("temporary", Option.none(), Option.some({ count: 3 }), { ttl: "1 second" })
		yield* TestClock.adjust("1 second")
		assert.equal(Option.isNone(yield* store.get("temporary")), true)
		yield* store.set("immediate", { count: 4 }, { ttl: 0 })
		assert.equal(Option.isNone(yield* store.get("immediate")), true)
		assert.equal(yield* store.size, 1)
	}).pipe(Effect.provide(Persistence.layerMemory), Effect.provide(TestClock.layer())),
)

it.effect("preserves nested Schema field paths when encoding or decoding stored state", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const numeric = Schema.Struct({
			deployment: Schema.Struct({ usage: Schema.Struct({ tokens: Schema.Int }) }),
		})
		const strings = Schema.Struct({
			deployment: Schema.Struct({ usage: Schema.Struct({ tokens: Schema.String }) }),
		})
		const writer = persistence.state({ namespace: "schema-boundary", schema: strings })
		const reader = persistence.state({ namespace: "schema-boundary", schema: numeric })
		const malformed = { deployment: { usage: { tokens: "many" } } } as const
		const encodeFailure = yield* reader
			.set("primary", malformed as unknown as typeof numeric.Type)
			.pipe(Effect.flip)

		assert.deepEqual(issuePaths(encodeFailure), [["deployment", "usage", "tokens"]])
		assert.equal(yield* reader.size, 0)
		yield* writer.set("primary", malformed)
		const decodeFailure = yield* reader.get("primary").pipe(Effect.flip)
		assert.deepEqual(issuePaths(decodeFailure), [["deployment", "usage", "tokens"]])
		assert.deepEqual(Option.getOrUndefined(yield* writer.get("primary")), malformed)
		assert.deepEqual(malformed, { deployment: { usage: { tokens: "many" } } })
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("isolates colliding namespace prefixes and arbitrary UTF-16 keys", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const entries = [
			{ namespace: "a", key: "b/c", count: 1 },
			{ namespace: "a/b", key: "c", count: 2 },
			{ namespace: "a", key: "__better_router_keys", count: 3 },
			{ namespace: "a", key: "\ud800", count: 4 },
			{ namespace: "a", key: "\ufffd", count: 5 },
			{ namespace: "\ud800", key: "x", count: 6 },
			{ namespace: "\ufffd", key: "x", count: 7 },
		] as const
		yield* Effect.forEach(
			entries,
			({ namespace, key, count }) =>
				persistence.state({ ...declaration, namespace }).set(key, { count }),
			{ discard: true },
		)
		yield* Effect.forEach(
			entries,
			({ namespace, key, count }) =>
				persistence
					.state({ ...declaration, namespace })
					.get(key)
					.pipe(
						Effect.map((value) =>
							assert.deepEqual(Option.getOrUndefined(value), { count }),
						),
					),
			{ discard: true },
		)
		const first = persistence.state({ ...declaration, namespace: "a" })
		assert.equal(yield* first.size, 4)
		yield* first.delete("b/c")
		assert.equal(yield* first.size, 3)
		yield* first.clear
		assert.equal(yield* first.size, 0)
		assert.deepEqual(
			Option.getOrUndefined(
				yield* persistence.state({ ...declaration, namespace: "a/b" }).get("c"),
			),
			{ count: 2 },
		)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("validates declarations before accepting an empty namespace", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const empty = {
			namespace: "",
			schema: State,
		} as Persistence.Declaration<typeof State, never>
		const failure = yield* persistence.initialize([empty]).pipe(Effect.flip)

		assert.equal(failure._tag, "PersistenceError")
		assert.equal(failure.kind, "invalid_namespace")
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("rejects an empty state namespace before reading or writing records", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state({ namespace: "", schema: State })
		const write = yield* store.set("primary", { count: 1 }).pipe(Effect.flip)
		const read = yield* store.get("primary").pipe(Effect.flip)

		assert.equal(write._tag, "PersistenceError")
		assert.equal(read._tag, "PersistenceError")
		if (write._tag === "PersistenceError") assert.equal(write.kind, "invalid_namespace")
		if (read._tag === "PersistenceError") assert.equal(read.kind, "invalid_namespace")
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect(
	"runs memory migrations in declaration order exactly once across repeated initialization",
	() =>
		Effect.gen(function* () {
			const persistence = yield* Persistence.Persistence
			const seen = yield* Ref.make<readonly string[]>([])
			const migration = (name: string): Persistence.Migration<never> => ({
				id: name === "first" ? 1 : 2,
				name,
				run: Ref.update(seen, (entries) => [...entries, name]),
			})
			const declarationWithMigrations: Persistence.Declaration<typeof State, never> = {
				namespace: "migration-order",
				schema: State,
				migrations: [migration("first"), migration("second")],
			}

			yield* persistence.initialize([declarationWithMigrations])
			yield* persistence.initialize([declarationWithMigrations])
			yield* Effect.forEach(
				Array.from({ length: 16 }, (_, index) => index),
				() => persistence.initialize([declarationWithMigrations]),
				{ concurrency: "unbounded", discard: true },
			)
			assert.deepEqual(yield* Ref.get(seen), ["first", "second"])
		}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("retries failed memory migrations without repeating successful migrations", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const seen = yield* Ref.make<readonly string[]>([])
		const attempts = yield* Ref.make(0)
		const declarationWithRetry: Persistence.Declaration<typeof State, never> = {
			namespace: "migration-retry",
			schema: State,
			migrations: [
				{
					id: 1,
					name: "before",
					run: Ref.update(seen, (entries) => [...entries, "before"]),
				},
				{
					id: 2,
					name: "retry",
					run: Effect.gen(function* () {
						const attempt = yield* Ref.updateAndGet(attempts, (count) => count + 1)
						yield* Ref.update(seen, (entries) => [...entries, `attempt:${attempt}`])
						return yield* attempt === 1 ? Effect.fail("retry migration") : Effect.void
					}),
				},
				{
					id: 3,
					name: "after",
					run: Ref.update(seen, (entries) => [...entries, "after"]),
				},
			],
		}
		const failure = yield* persistence.initialize([declarationWithRetry]).pipe(Effect.flip)

		assert.equal(failure.kind, "migration")
		assert.equal(failure.namespace, "migration-retry")
		assert.deepEqual(yield* Ref.get(seen), ["before", "attempt:1"])
		yield* persistence.initialize([declarationWithRetry])
		yield* persistence.initialize([declarationWithRetry])
		assert.deepEqual(yield* Ref.get(seen), ["before", "attempt:1", "attempt:2", "after"])
		assert.equal(yield* Ref.get(attempts), 2)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("requires no environment for declarations without migrations", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const initialize = persistence.initialize([{ namespace: "no-migrations", schema: State }])
		const withoutServices: Effect.Effect<void, Persistence.PersistenceError> = initialize
		yield* withoutServices
		assert.equal(
			yield* persistence.state({ namespace: "no-migrations", schema: State }).size,
			0,
		)
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("wraps a failed memory migration and stops subsequent migrations", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const seen = yield* Ref.make<readonly string[]>([])
		const declarationWithFailure: Persistence.Declaration<typeof State, never> = {
			namespace: "migration-failure",
			schema: State,
			migrations: [
				{
					id: 1,
					name: "before",
					run: Ref.update(seen, (entries) => [...entries, "before"]),
				},
				{ id: 2, name: "failed", run: Effect.fail("migration failed") },
				{ id: 3, name: "after", run: Ref.update(seen, (entries) => [...entries, "after"]) },
			],
		}
		const failure = yield* persistence.initialize([declarationWithFailure]).pipe(Effect.flip)

		assert.equal(failure._tag, "PersistenceError")
		assert.equal(failure.kind, "migration")
		assert.equal(failure.namespace, "migration-failure")
		assert.deepEqual(yield* Ref.get(seen), ["before"])
	}).pipe(Effect.provide(Persistence.layerMemory)),
)

it.effect("runs migration finalizers when the scoped memory layer closes", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		yield* Effect.scoped(
			Effect.gen(function* () {
				const persistence = yield* Persistence.Persistence
				const declarationWithFinalizer: Persistence.Declaration<typeof State, Scope.Scope> =
					{
						namespace: "migration-finalizer",
						schema: State,
						migrations: [
							{
								id: 1,
								name: "resource",
								run: Effect.addFinalizer(() =>
									Ref.update(seen, (entries) => [...entries, "release"]),
								).pipe(
									Effect.andThen(
										Ref.update(seen, (entries) => [...entries, "acquire"]),
									),
								),
							},
						],
					}
				yield* persistence.initialize([declarationWithFinalizer])
				assert.deepEqual(yield* Ref.get(seen), ["acquire"])
			}).pipe(Effect.provide(Persistence.layerMemory)),
		)

		assert.deepEqual(yield* Ref.get(seen), ["acquire", "release"])
	}).pipe(Effect.provide(Persistence.layerMemory)),
)
