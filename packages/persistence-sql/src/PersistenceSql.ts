import { Cause, Context, Effect, Layer, Option, Ref, Result, Schema, Semaphore } from "effect"
import * as KeyValueStore from "effect/persistence/KeyValueStore"
import * as Migrator from "effect/sql/Migrator"
import * as SqlClient from "effect/sql/SqlClient"
import * as SqlError from "effect/sql/SqlError"
import {
	Error as PersistenceError,
	makeBackendService,
	makeDeclaration,
	Persistence,
} from "@better-router/core/Persistence"
import type { Backend, Declaration, Migration, Service } from "@better-router/core/Persistence"

export {
	ConflictError,
	DeclarationSchema,
	Error,
	Key,
	makeDeclaration,
	Namespace,
	Persistence,
	PersistenceError,
} from "@better-router/core/Persistence"
export type {
	Conflict,
	Declaration,
	Migration,
	Service,
	StateStore,
	StoreError,
} from "@better-router/core/Persistence"

export interface SqlOptions {
	readonly table?: string
	readonly lockTable?: string
	readonly migrationTable?: string
}

const metadataKey = "__better_router_keys"

const mapSqlError = <E>(cause: E | SqlError.SqlError): E | PersistenceError =>
	SqlError.isSqlError(cause)
		? PersistenceError.make({
				kind: "backend",
				namespace: "sql",
				message: "SQL persistence operation failed",
				cause,
			})
		: cause

const backendError = (cause: unknown): PersistenceError =>
	PersistenceError.make({
		kind: "backend",
		namespace: "sql",
		message: "SQL persistence operation failed",
		cause,
	})

interface TransactionFrame {
	readonly sql: SqlClient.SqlClient
	readonly open: Ref.Ref<boolean>
	readonly lock: Semaphore.Semaphore
}

const marker = Context.Reference<Option.Option<TransactionFrame>>(
	"better-router/persistence/sql-transaction",
	{ defaultValue: Option.none },
)

const encodeName = (value: string) =>
	Array.from({ length: value.length }, (_, index) =>
		value.charCodeAt(index).toString(16).padStart(4, "0"),
	).join("")

const initialize =
	(sql: SqlClient.SqlClient, options: SqlOptions): Service["initialize"] =>
	<Requirements = never>(declarations: readonly Declaration<Schema.Constraint, Requirements>[]) =>
		Effect.gen(function* () {
			const context = yield* Effect.context<Requirements>()
			yield* Effect.forEach(
				declarations,
				(declaration) =>
					Result.match(makeDeclaration(declaration), {
						onFailure: Effect.fail,
						onSuccess: (decoded) =>
							Migrator.make({})({
								loader: Migrator.fromRecord(
									(decoded.migrations ?? []).reduce<
										Record<
											string,
											Effect.Effect<void, unknown, SqlClient.SqlClient>
										>
									>(
										(record, migration) => ({
											...record,
											[`${migration.id}_${migration.name}`]:
												Effect.provideContext(
													migration.run,
													Context.add(context, SqlClient.SqlClient, sql),
												),
										}),
										{},
									),
								),
								table: `${options.migrationTable ?? "better_router_migrations"}_${encodeName(decoded.namespace)}`,
							}).pipe(
								Effect.provideService(SqlClient.SqlClient, sql),
								Effect.catchCause((cause) =>
									Cause.hasInterruptsOnly(cause)
										? Effect.failCause(cause as Cause.Cause<never>)
										: Effect.fail(
												PersistenceError.make({
													kind: "migration",
													namespace: declaration.namespace,
													message: "SQL migration failed",
													cause,
												}),
											),
								),
							),
					}),
				{ discard: true },
			)
		})

/** A migration whose requirements are provided by an SQL client layer. */
export type SqlMigration = Migration<SqlClient.SqlClient>

const migrationRecord = (
	migrations: readonly SqlMigration[],
): Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> =>
	migrations.reduce<Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>>(
		(record, migration) => ({
			...record,
			[`${migration.id}_${migration.name}`]: migration.run,
		}),
		{},
	)

/** Run validated SQL migrations through Effect SQL's monotonic migrator. */
export const runMigrations = (
	migrations: readonly SqlMigration[],
	options: Pick<SqlOptions, "migrationTable"> = {},
): Effect.Effect<
	ReadonlyArray<readonly [id: number, name: string]>,
	PersistenceError,
	SqlClient.SqlClient
> =>
	Result.match(makeDeclaration({ namespace: "sql", schema: Schema.Unknown, migrations }), {
		onFailure: Effect.fail,
		onSuccess: (declaration) =>
			Migrator.make({})({
				loader: Migrator.fromRecord(migrationRecord(declaration.migrations ?? [])),
				table: options.migrationTable ?? "better_router_migrations",
			}).pipe(
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.failCause(cause as Cause.Cause<never>)
						: Effect.fail(
								PersistenceError.make({
									kind: "migration",
									namespace: "sql",
									message: "SQL migration failed",
									cause,
								}),
							),
				),
			),
	})

const makeSqlBackend = (
	options: SqlOptions,
): Effect.Effect<Backend, PersistenceError, SqlClient.SqlClient | KeyValueStore.KeyValueStore> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient
		const keyValueStore = yield* KeyValueStore.KeyValueStore
		const lockTable = options.lockTable ?? "better_router_persistence_lock"
		const lockIdentifier = sql(lockTable)
		const prepare = sql.onDialectOrElse({
			mssql: () =>
				sql`IF OBJECT_ID(${lockTable}, N'U') IS NULL CREATE TABLE ${lockIdentifier} (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)`,
			orElse: () =>
				sql`CREATE TABLE IF NOT EXISTS ${lockIdentifier} (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)`,
		})
		const seed = sql.onDialectOrElse({
			mssql: () =>
				sql`IF NOT EXISTS (SELECT id FROM ${lockIdentifier} WHERE id = 1) INSERT INTO ${lockIdentifier} (id, version) VALUES (1, 0)`,
			pg: () =>
				sql`INSERT INTO ${lockIdentifier} (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING`,
			mysql: () =>
				sql`INSERT INTO ${lockIdentifier} (id, version) VALUES (1, 0) ON DUPLICATE KEY UPDATE id = id`,
			orElse: () => sql`INSERT OR IGNORE INTO ${lockIdentifier} (id, version) VALUES (1, 0)`,
		})
		yield* prepare.pipe(Effect.mapError(backendError))
		yield* seed.pipe(Effect.mapError(backendError))
		const namespacePrefix = (namespace: string) =>
			`better_router/state/${encodeName(namespace)}/`
		const dataKey = (key: string) => encodeName(key)
		const scoped = (namespace: string) =>
			KeyValueStore.prefix(keyValueStore, namespacePrefix(namespace))
		const metadata = (namespace: string) =>
			KeyValueStore.toSchemaStore(
				KeyValueStore.prefix(
					keyValueStore,
					`better_router/metadata/${encodeName(namespace)}/`,
				),
				Schema.Array(Schema.String),
			)
		const readKeys = (namespace: string) =>
			metadata(namespace)
				.get(metadataKey)
				.pipe(Effect.map(Option.getOrElse(() => [] as readonly string[])))
		const lock = yield* Semaphore.make(1)
		const transaction: Backend["transaction"] = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			Effect.withFiber<A, E | PersistenceError, R>((fiber) => {
				const parent = Option.filter(fiber.getRef(marker), (frame) => frame.sql === sql)
				const ambient = Context.getOption(fiber.context, sql.transactionService)
				if (Option.isSome(ambient) && Option.isNone(parent))
					return Effect.fail(
						PersistenceError.make({
							kind: "backend",
							namespace: "sql",
							message: "Persistence cannot join an unrelated SQL transaction",
						}),
					)
				const semaphore = Option.isSome(parent) ? parent.value.lock : lock
				return semaphore.withPermit(
					Effect.gen(function* () {
						const parentOpen = Option.isSome(parent)
							? yield* Ref.get(parent.value.open)
							: true
						if (!parentOpen)
							return yield* Effect.fail(
								PersistenceError.make({
									kind: "backend",
									namespace: "sql",
									message: "Transaction has already closed",
								}),
							)
						const childLock = yield* Semaphore.make(1)
						const open = yield* Ref.make(true)
						return yield* sql
							.withTransaction(
								Effect.gen(function* () {
									yield* sql`UPDATE ${lockIdentifier} SET version = version + 1 WHERE id = 1`.pipe(
										Effect.mapError(backendError),
									)
									return yield* Effect.provideService(
										Effect.awaitAllChildren(effect),
										marker,
										Option.some({ sql, open, lock: childLock }),
									)
								}),
							)
							.pipe(
								Effect.mapError(mapSqlError<E | PersistenceError>),
								Effect.onExit(() => Ref.set(open, false)),
							)
					}),
				)
			})
		const backend: Backend = {
			get: (namespace, key) =>
				scoped(namespace)
					.get(dataKey(key))
					.pipe(Effect.map(Option.fromUndefinedOr), Effect.mapError(backendError)),
			set: (namespace, key, value) =>
				scoped(namespace)
					.set(dataKey(key), value)
					.pipe(
						Effect.flatMap(() => readKeys(namespace)),
						Effect.flatMap((keys) =>
							keys.includes(key)
								? Effect.void
								: metadata(namespace).set(metadataKey, [...keys, key]),
						),
						Effect.mapError(backendError),
					),
			remove: (namespace, key) =>
				scoped(namespace)
					.remove(dataKey(key))
					.pipe(
						Effect.flatMap(() => readKeys(namespace)),
						Effect.flatMap((keys) =>
							metadata(namespace).set(
								metadataKey,
								keys.filter((entry) => entry !== key),
							),
						),
						Effect.mapError(backendError),
					),
			clear: (namespace) =>
				readKeys(namespace).pipe(
					Effect.flatMap((keys) =>
						Effect.forEach(keys, (key) => scoped(namespace).remove(dataKey(key)), {
							discard: true,
						}),
					),
					Effect.flatMap(() => metadata(namespace).remove(metadataKey)),
					Effect.mapError(backendError),
				),
			size: (namespace) =>
				readKeys(namespace).pipe(
					Effect.map((keys) => keys.length),
					Effect.mapError(backendError),
				),
			keys: (namespace) => readKeys(namespace).pipe(Effect.mapError(backendError)),
			transaction,
		}
		return backend
	})

export const layerSql = (
	options: SqlOptions = {},
): Layer.Layer<Persistence, PersistenceError, SqlClient.SqlClient> =>
	Layer.effect(
		Persistence,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient
			const backend = yield* makeSqlBackend(options)
			return makeBackendService(backend, initialize(sql, options))
		}),
	).pipe(
		Layer.provide(
			KeyValueStore.layerSql(
				options.table === undefined ? {} : { table: options.table },
			).pipe(
				Layer.catchCause((cause) =>
					Layer.effect(
						KeyValueStore.KeyValueStore,
						Cause.hasInterruptsOnly(cause)
							? Effect.failCause(cause as Cause.Cause<never>)
							: Effect.fail(backendError(cause)),
					),
				),
			),
		),
	)

export const layerSqlWithMigrations = (
	migrations: readonly SqlMigration[],
	options: SqlOptions = {},
): Layer.Layer<Persistence, PersistenceError, SqlClient.SqlClient> =>
	Layer.effect(
		Persistence,
		Effect.gen(function* () {
			yield* runMigrations(migrations, options)
			const backend = yield* makeSqlBackend(options)
			const sql = yield* SqlClient.SqlClient
			return makeBackendService(backend, initialize(sql, options))
		}),
	).pipe(
		Layer.provide(
			KeyValueStore.layerSql(
				options.table === undefined ? {} : { table: options.table },
			).pipe(
				Layer.catchCause((cause) =>
					Layer.effect(
						KeyValueStore.KeyValueStore,
						Cause.hasInterruptsOnly(cause)
							? Effect.failCause(cause as Cause.Cause<never>)
							: Effect.fail(backendError(cause)),
					),
				),
			),
		),
	)

export type SqlMigrationError = PersistenceError
