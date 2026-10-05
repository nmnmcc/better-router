import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Ref,
	Result,
	Schema,
	SchemaIssue,
} from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as Persistence from "@better-router/core/Persistence"
import * as Plugin from "@better-router/core/Plugin"
import * as Router from "@better-router/core/Router"
import { layerSql, layerSqlWithMigrations, runMigrations } from "../src/index.js"

const State = Schema.Struct({ metrics: Schema.Struct({ count: Schema.Natural }) })
const declaration = { namespace: "deployments", schema: State } as const
const value = (count: number): typeof State.Type => ({ metrics: { count } })

const sqlite = (filename = ":memory:") =>
	layerSql({ table: "test_state" }).pipe(Layer.provideMerge(SqliteClient.layer({ filename })))

const temporaryDirectory = Effect.acquireRelease(
	Effect.tryPromise(() => mkdtemp(join(tmpdir(), "better-router-sqlite-test-"))),
	(target) =>
		Effect.tryPromise(() => rm(target, { recursive: true, force: true })).pipe(Effect.orDie),
)

const issuePaths = (error: unknown) => {
	assert.ok(Schema.isSchemaError(error), "Expected a typed SchemaError")
	if (!Schema.isSchemaError(error)) return assert.fail("Expected a typed SchemaError")
	return SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map(
		(issue) => issue.path,
	)
}

it.effect(
	"stores, updates and deletes typed SQLite state without crossing namespace boundaries",
	() =>
		Effect.gen(function* () {
			const persistence = yield* Persistence.Persistence
			const first = persistence.state(declaration)
			const second = persistence.state({ namespace: "deployments/backup", schema: State })

			assert.equal(Option.isNone(yield* first.get("primary")), true)
			yield* first.set("primary", value(1))
			yield* second.set("primary", value(10))
			const updated = yield* first.update("primary", (current) =>
				Option.map(current, (state) => value(state.metrics.count + 1)),
			)

			assert.deepEqual(Option.getOrUndefined(updated), value(2))
			assert.deepEqual(Option.getOrUndefined(yield* second.get("primary")), value(10))
			assert.equal(yield* first.size, 1)
			yield* first.delete("primary")
			assert.equal(Option.isNone(yield* first.get("primary")), true)
			assert.equal(yield* first.size, 0)
			assert.equal(yield* second.size, 1)
			yield* second.clear
			assert.equal(yield* second.size, 0)
		}).pipe(Effect.provide(sqlite())),
)

it.effect("isolates metadata-like keys and distinct UTF-16 namespace and key values", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const first = persistence.state({ namespace: "unicode/\ud800", schema: State })
		const second = persistence.state({ namespace: "unicode/\ud801", schema: State })
		const keys = [
			"__better_router_keys",
			"7:primary",
			"primary",
			"�",
			"\ud800",
			"\ud801",
		] as const
		yield* Effect.forEach(keys, (key, index) => first.set(key, value(index)))
		yield* Effect.forEach(keys, (key, index) => second.set(key, value(index + 10)))
		const firstValues = yield* Effect.forEach(keys, (key) => first.get(key))
		const secondValues = yield* Effect.forEach(keys, (key) => second.get(key))

		assert.deepEqual(
			firstValues.map(Option.getOrUndefined),
			keys.map((_, index) => value(index)),
		)
		assert.deepEqual(
			secondValues.map(Option.getOrUndefined),
			keys.map((_, index) => value(index + 10)),
		)
		assert.equal(yield* first.size, keys.length)
		assert.equal(yield* second.size, keys.length)
		yield* first.clear
		assert.equal(yield* first.size, 0)
		assert.equal(yield* second.size, keys.length)
	}).pipe(Effect.provide(sqlite())),
)

it.effect("runs namespaced declaration migrations in numeric order exactly once", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const sql = yield* SqlClient.SqlClient
		const declarations = [
			{
				namespace: "first",
				schema: State,
				migrations: [
					{
						id: 2,
						name: "insert_second",
						run: Effect.gen(function* () {
							const client = yield* SqlClient.SqlClient
							yield* client`INSERT INTO migration_log (message) VALUES (${"first:second"})`
						}),
					},
					{
						id: 1,
						name: "create_log",
						run: Effect.gen(function* () {
							const client = yield* SqlClient.SqlClient
							yield* client`CREATE TABLE migration_log (id INTEGER PRIMARY KEY, message TEXT NOT NULL)`
							yield* client`INSERT INTO migration_log (message) VALUES (${"first:first"})`
						}),
					},
				],
			},
			{
				namespace: "second",
				schema: State,
				migrations: [
					{
						id: 1,
						name: "append_log",
						run: Effect.gen(function* () {
							const client = yield* SqlClient.SqlClient
							yield* client`INSERT INTO migration_log (message) VALUES (${"second:first"})`
						}),
					},
				],
			},
		] as const
		yield* persistence.initialize(declarations)
		yield* persistence.initialize(declarations)
		const rows = yield* sql<{
			readonly message: string
		}>`SELECT message FROM migration_log ORDER BY id`

		assert.deepEqual(
			rows.map(({ message }) => message),
			["first:first", "first:second", "second:first"],
		)
	}).pipe(Effect.provide(sqlite())),
)

it.effect("rolls back failed declaration migrations and retries the uncommitted migration", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const sql = yield* SqlClient.SqlClient
		const create = {
			id: 1,
			name: "create_table",
			run: Effect.gen(function* () {
				const client = yield* SqlClient.SqlClient
				yield* client`CREATE TABLE recovered_migration (count INTEGER NOT NULL)`
			}),
		} as const
		const failed = yield* persistence
			.initialize([
				{
					namespace: "recoverable",
					schema: State,
					migrations: [
						create,
						{ id: 2, name: "reject", run: Effect.fail("migration rejected") },
					],
				},
			])
			.pipe(Effect.flip)

		assert.equal(failed._tag, "PersistenceError")
		assert.equal(failed.kind, "migration")
		assert.equal(failed.namespace, "recoverable")
		const absent = yield* sql<{
			readonly name: string
		}>`SELECT name FROM sqlite_master WHERE name = ${"recovered_migration"}`
		assert.deepEqual(absent, [])
		yield* persistence.initialize([
			{
				namespace: "recoverable",
				schema: State,
				migrations: [
					create,
					{
						id: 2,
						name: "insert_count",
						run: Effect.gen(function* () {
							const client = yield* SqlClient.SqlClient
							yield* client`INSERT INTO recovered_migration (count) VALUES (3)`
						}),
					},
				],
			},
		])
		const rows = yield* sql<{ readonly count: number }>`SELECT count FROM recovered_migration`
		assert.deepEqual(
			rows.map(({ count }) => count),
			[3],
		)
	}).pipe(Effect.provide(sqlite())),
)

it.effect("rolls back a transaction across typed namespaces", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const first = persistence.state(declaration)
		const second = persistence.state({ namespace: "usage", schema: State })
		yield* first.set("primary", value(1))
		const failure = yield* persistence
			.transaction(
				Effect.gen(function* () {
					yield* first.set("primary", value(2))
					yield* second.set("primary", value(10))
					return yield* Effect.fail("abort transaction")
				}),
			)
			.pipe(Effect.flip)

		assert.equal(failure, "abort transaction")
		assert.deepEqual(Option.getOrUndefined(yield* first.get("primary")), value(1))
		assert.equal(Option.isNone(yield* second.get("primary")), true)
		assert.equal(yield* second.size, 0)
	}).pipe(Effect.provide(sqlite())),
)

it.effect("rolls back a nested savepoint while committing the outer transaction", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const first = persistence.state(declaration)
		const second = persistence.state({ namespace: "usage", schema: State })
		yield* persistence.transaction(
			Effect.gen(function* () {
				yield* first.set("primary", value(1))
				const nested = yield* first
					.transaction(
						Effect.gen(function* () {
							yield* first.set("primary", value(2))
							yield* second.set("rolled-back", value(20))
							return yield* Effect.fail("abort savepoint")
						}),
					)
					.pipe(Effect.flip)
				assert.equal(nested, "abort savepoint")
				yield* second.set("committed", value(3))
			}),
		)

		assert.deepEqual(Option.getOrUndefined(yield* first.get("primary")), value(1))
		assert.equal(Option.isNone(yield* second.get("rolled-back")), true)
		assert.deepEqual(Option.getOrUndefined(yield* second.get("committed")), value(3))
		assert.equal(yield* second.size, 1)
	}).pipe(Effect.provide(sqlite())),
)

it.effect("permits exactly one concurrent compare-and-set winner", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		yield* store.set("primary", value(0))
		const attempts = yield* Effect.forEach(
			Array.from({ length: 12 }, (_, index) => index + 1),
			(count) =>
				store.cas("primary", Option.some(value(0)), Option.some(value(count))).pipe(
					Effect.result,
					Effect.map((result) => ({ count, result })),
				),
			{ concurrency: "unbounded" },
		)
		const successes = attempts.filter(({ result }) => Result.isSuccess(result))
		const failures = attempts.filter(({ result }) => Result.isFailure(result))

		assert.equal(successes.length, 1)
		assert.equal(failures.length, 11)
		assert.equal(
			failures.every(
				({ result }) =>
					Result.isFailure(result) && result.failure._tag === "PersistenceConflict",
			),
			true,
		)
		assert.deepEqual(
			Option.getOrUndefined(yield* store.get("primary")),
			value(successes[0]?.count ?? assert.fail("Expected one CAS winner")),
		)
	}).pipe(Effect.provide(sqlite())),
)

it.effect("coordinates compare-and-set across independently opened SQLite clients", () =>
	Effect.gen(function* () {
		const directory = yield* temporaryDirectory
		const filename = join(directory, "cas.sqlite")
		const seed = Effect.scoped(
			Effect.gen(function* () {
				const persistence = yield* Persistence.Persistence
				yield* persistence.state(declaration).set("primary", value(0))
			}).pipe(Effect.provide(sqlite(filename))),
		)
		yield* seed
		const attempt = (next: number) =>
			Effect.scoped(
				Effect.gen(function* () {
					const persistence = yield* Persistence.Persistence
					return yield* persistence
						.state(declaration)
						.cas("primary", Option.some(value(0)), Option.some(value(next)))
						.pipe(
							Effect.result,
							Effect.map((result) => ({ next, result })),
						)
				}).pipe(Effect.provide(sqlite(filename))),
			)
		const results = yield* Effect.all([attempt(101), attempt(102)], {
			concurrency: "unbounded",
		})
		const successes = results.filter(({ result }) => Result.isSuccess(result))
		const failures = results.filter(({ result }) => Result.isFailure(result))
		assert.equal(successes.length, 1)
		assert.equal(failures.length, 1)
		assert.equal(
			failures.every(
				({ result }) =>
					Result.isFailure(result) && result.failure._tag === "PersistenceConflict",
			),
			true,
		)

		const restored = yield* Effect.scoped(
			Effect.gen(function* () {
				const persistence = yield* Persistence.Persistence
				return yield* persistence.state(declaration).get("primary")
			}).pipe(Effect.provide(sqlite(filename))),
		)
		assert.deepEqual(
			Option.getOrUndefined(restored),
			value(successes[0]?.next ?? assert.fail("Expected one CAS winner")),
		)
	}),
)

it.effect("purges expired SQLite records when size is read with TestClock", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const sql = yield* SqlClient.SqlClient
		const store = persistence.state(declaration)
		yield* store.set("expiring", value(1), { ttl: "2 seconds" })
		yield* store.set("durable", value(2))
		assert.equal(yield* store.size, 2)
		yield* TestClock.adjust("2 seconds")
		assert.equal(yield* store.size, 1)
		assert.equal(Option.isNone(yield* store.get("expiring")), true)
		assert.deepEqual(Option.getOrUndefined(yield* store.get("durable")), value(2))
		const rows = yield* sql<{
			readonly count: number
		}>`SELECT COUNT(*) AS count FROM test_state WHERE id LIKE ${"better_router/state/%"}`
		assert.deepEqual(
			rows.map(({ count }) => count),
			[1],
		)
	}).pipe(Effect.provide(sqlite())),
)

it.effect("preserves nested Schema issue paths when SQLite payloads are corrupted", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const sql = yield* SqlClient.SqlClient
		const store = persistence.state(declaration)
		yield* store.set("primary", value(1))
		const encodedFailure = yield* store
			.set("invalid", { metrics: { count: "invalid" } } as unknown as typeof State.Type)
			.pipe(Effect.flip)
		assert.deepEqual(issuePaths(encodedFailure), [["metrics", "count"]])
		assert.equal(yield* store.size, 1)
		const rows = yield* sql<{
			readonly id: string
		}>`SELECT id FROM test_state WHERE id LIKE ${"better_router/state/%"}`
		assert.equal(rows.length, 1)
		const id = rows[0]?.id ?? assert.fail("Expected the persisted state row")
		const malformed = new TextEncoder().encode(
			JSON.stringify({
				value: JSON.stringify({ metrics: { count: "invalid" } }),
			}),
		)
		yield* sql`UPDATE test_state SET value = ${malformed} WHERE id = ${id}`
		const decodedFailure = yield* store.get("primary").pipe(Effect.flip)

		assert.deepEqual(issuePaths(decodedFailure), [["metrics", "count"]])
	}).pipe(Effect.provide(sqlite())),
)

it.effect("rolls back interrupted SQL work and releases the transaction lock", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const store = persistence.state(declaration)
		const started = yield* Deferred.make<void>()
		yield* store.set("primary", value(1))
		const fiber = yield* persistence
			.transaction(
				store
					.set("primary", value(2))
					.pipe(
						Effect.andThen(Deferred.succeed(started, void 0)),
						Effect.andThen(Effect.never),
					),
			)
			.pipe(Effect.forkChild)
		yield* Deferred.await(started)
		yield* Fiber.interrupt(fiber)
		const exit = yield* Fiber.await(fiber)

		assert.equal(Exit.isFailure(exit), true)
		if (Exit.isFailure(exit)) assert.equal(Cause.hasInterruptsOnly(exit.cause), true)
		assert.deepEqual(Option.getOrUndefined(yield* store.get("primary")), value(1))
		yield* store.set("primary", value(3))
		assert.deepEqual(Option.getOrUndefined(yield* store.get("primary")), value(3))
	}).pipe(Effect.provide(sqlite())),
)

it.effect("runs host-supplied SQL migrations before exposing the SQL layer", () =>
	Effect.gen(function* () {
		const migration = {
			id: 1,
			name: "create_host_table",
			run: Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				yield* sql`CREATE TABLE host_migration (count INTEGER NOT NULL)`
				yield* sql`INSERT INTO host_migration (count) VALUES (7)`
			}),
		} as const
		const program = Effect.gen(function* () {
			const persistence = yield* Persistence.Persistence
			const sql = yield* SqlClient.SqlClient
			const rows = yield* sql<{ readonly count: number }>`SELECT count FROM host_migration`
			assert.deepEqual(
				rows.map(({ count }) => count),
				[7],
			)
			assert.deepEqual(yield* runMigrations([migration]), [])
			yield* persistence.state(declaration).set("primary", value(1))
		})
		yield* program.pipe(
			Effect.provide(
				layerSqlWithMigrations([migration]).pipe(
					Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
				),
			),
		)
	}),
)

it.effect("maps a typed host migration failure without leaking a runtime defect", () =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const migration = {
			id: 1,
			name: "reject_host_migration",
			run: Effect.gen(function* () {
				const client = yield* SqlClient.SqlClient
				yield* client`CREATE TABLE failed_host_migration (count INTEGER NOT NULL)`
				yield* Effect.fail("host migration rejected")
			}),
		} as const
		const failure = yield* runMigrations([migration], {
			migrationTable: "host_failure_migrations",
		}).pipe(Effect.flip)

		assert.equal(failure._tag, "PersistenceError")
		assert.equal(failure.kind, "migration")
		assert.equal(failure.namespace, "sql")
		const table = yield* sql<{
			readonly name: string
		}>`SELECT name FROM sqlite_master WHERE name = ${"failed_host_migration"}`
		assert.deepEqual(
			table.map(({ name }) => name),
			[],
		)
		const records = yield* sql<{
			readonly migration_id: number
		}>`SELECT migration_id FROM host_failure_migrations`
		assert.deepEqual(
			records.map(({ migration_id }) => migration_id),
			[],
		)
	}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
)

it.effect(
	"preserves interruption while rolling back and finalizing a canceled host migration",
	() =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const started = yield* Deferred.make<void>()
			const finalized = yield* Ref.make(false)
			const migration = {
				id: 1,
				name: "cancel_host_migration",
				run: Effect.gen(function* () {
					const client = yield* SqlClient.SqlClient
					yield* client`CREATE TABLE canceled_host_migration (count INTEGER NOT NULL)`
					yield* client`INSERT INTO canceled_host_migration (count) VALUES (1)`
					yield* Deferred.succeed(started, void 0)
					yield* Effect.never
				}).pipe(Effect.ensuring(Ref.set(finalized, true))),
			} as const
			const fiber = yield* runMigrations([migration], {
				migrationTable: "host_cancel_migrations",
			}).pipe(Effect.forkChild)
			yield* Deferred.await(started)
			yield* Fiber.interrupt(fiber)
			const exit = yield* Fiber.await(fiber)

			assert.equal(Exit.isFailure(exit), true)
			if (Exit.isFailure(exit)) assert.equal(Cause.hasInterruptsOnly(exit.cause), true)
			assert.equal(yield* Ref.get(finalized), true)
			const table = yield* sql<{
				readonly name: string
			}>`SELECT name FROM sqlite_master WHERE name = ${"canceled_host_migration"}`
			assert.deepEqual(
				table.map(({ name }) => name),
				[],
			)
			const records = yield* sql<{
				readonly migration_id: number
			}>`SELECT migration_id FROM host_cancel_migrations`
			assert.deepEqual(
				records.map(({ migration_id }) => migration_id),
				[],
			)
		}).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
)

it.effect("restores typed state after closing and reopening a SQLite database", () =>
	Effect.gen(function* () {
		const directory = yield* temporaryDirectory
		const filename = join(directory, "state.sqlite")
		yield* Effect.scoped(
			Effect.gen(function* () {
				const persistence = yield* Persistence.Persistence
				yield* persistence.state(declaration).set("primary", value(42))
			}).pipe(Effect.provide(sqlite(filename))),
		)
		const restored = yield* Effect.scoped(
			Effect.gen(function* () {
				const persistence = yield* Persistence.Persistence
				const store = persistence.state(declaration)
				assert.equal(yield* store.size, 1)
				return yield* store.get("primary")
			}).pipe(Effect.provide(sqlite(filename))),
		)

		assert.deepEqual(Option.getOrUndefined(restored), value(42))
	}),
)

it.effect("reports SQL table setup failure through the typed layer error channel", () =>
	Effect.gen(function* () {
		const directory = yield* temporaryDirectory
		const filename = join(directory, "readonly.sqlite")
		yield* Effect.scoped(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				yield* sql`CREATE TABLE existing (id INTEGER PRIMARY KEY)`
			}).pipe(Effect.provide(SqliteClient.layer({ filename }))),
		)
		const error = yield* Effect.void.pipe(
			Effect.provide(
				layerSql().pipe(Layer.provide(SqliteClient.layer({ filename, readonly: true }))),
			),
			Effect.flip,
		)

		assert.equal(error._tag, "PersistenceError")
		assert.equal(error.kind, "backend")
		assert.equal(error.namespace, "sql")
	}),
)

it.effect("migrates an injected SQLite layer before plugin init reads persisted state", () =>
	Effect.gen(function* () {
		const persistence = yield* Persistence.Persistence
		const finalized = yield* Ref.make(false)
		yield* persistence.state(declaration).set("primary", value(4))
		const plugin = Plugin.make({
			id: "sqlite-state",
			capabilities: [] as const,
			config: {
				persistence: [
					{
						...declaration,
						migrations: [
							{
								id: 1,
								name: "create_plugin_table",
								run: Effect.gen(function* () {
									const sql = yield* SqlClient.SqlClient
									yield* sql`CREATE TABLE plugin_migration (count INTEGER NOT NULL)`
									yield* sql`INSERT INTO plugin_migration (count) VALUES (9)`
								}),
							},
						],
					},
				],
			},
			init: () =>
				Effect.gen(function* () {
					const state = yield* Persistence.Persistence
					const sql = yield* SqlClient.SqlClient
					const rows = yield* sql<{
						readonly count: number
					}>`SELECT count FROM plugin_migration`
					yield* Effect.addFinalizer(() => Ref.set(finalized, true))
					return {
						state: Option.getOrUndefined(
							yield* state.state(declaration).get("primary"),
						),
						migration: rows[0]?.count,
					}
				}),
		})
		const router = yield* Effect.fromResult(Router.make({ plugins: [plugin] as const }))
		yield* Effect.scoped(
			Router.RouterRuntime.pipe(
				Effect.provide(Router.layer(router)),
				Effect.tap((runtime) =>
					Effect.sync(() =>
						assert.deepEqual(runtime.plugins, [
							{
								id: "sqlite-state",
								runtime: { state: value(4), migration: 9 },
							},
						]),
					),
				),
			),
		)

		assert.equal(yield* Ref.get(finalized), true)
	}).pipe(Effect.provide(sqlite())),
)
