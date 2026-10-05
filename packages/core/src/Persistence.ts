import {
	Cause,
	Clock,
	Context,
	Duration,
	Effect,
	Exit,
	HashSet,
	Layer,
	Option,
	Ref,
	Result,
	Schema,
	SchemaIssue,
	Semaphore,
} from "effect"

/** A migration is a declaration. The host decides how to execute it. */
export interface Migration<Requirements = never> {
	readonly id: number
	readonly name: string
	readonly run: Effect.Effect<void, unknown, Requirements>
}

/** A versioned, typed state namespace contributed by a plugin. */
export interface Declaration<
	S extends Schema.Constraint = Schema.Constraint,
	Requirements = never,
> {
	readonly namespace: string
	readonly schema: S
	readonly version?: number
	readonly migrations?: readonly Migration<Requirements>[]
}

export type PersistenceDeclaration<
	S extends Schema.Constraint = Schema.Constraint,
	Requirements = never,
> = Declaration<S, Requirements>

export type AnyDeclaration = Declaration<Schema.Constraint, never>

/** Runtime failures raised at the persistence boundary. */
export class Error extends Schema.TaggedError<Error>()("PersistenceError", {
	kind: Schema.Literals(["invalid_namespace", "invalid_key", "conflict", "migration", "backend"]),
	namespace: Schema.String,
	key: Schema.optional(Schema.String),
	message: Schema.String,
	issues: Schema.optional(
		Schema.Array(
			Schema.Struct({
				path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
				message: Schema.String,
			}),
		),
	),
	cause: Schema.optional(Schema.Defect({ excludeCause: true })),
}) {}

export type PersistenceError = typeof Error.Type
export const PersistenceError = Error

/** A failed compare-and-set operation. */
export class ConflictError extends Schema.TaggedError<ConflictError>()("PersistenceConflict", {
	namespace: Schema.String,
	key: Schema.String,
	message: Schema.String,
}) {}

export type Conflict = typeof ConflictError.Type

export type StoreError = PersistenceError | ConflictError | Schema.SchemaError

export const Namespace = Schema.NonEmptyString
export const Key = Schema.NonEmptyString

const schemaValue = Schema.declare((value): value is Schema.Constraint => Schema.isSchema(value))
const effectValue = Schema.declare((value): value is Effect.Effect<void, unknown, unknown> =>
	Effect.isEffect(value),
)

/** The descriptor boundary; persisted values use the contributed Schema. */
export const DeclarationSchema = Schema.Struct({
	namespace: Namespace,
	schema: schemaValue,
	version: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	migrations: Schema.optional(
		Schema.Array(
			Schema.Struct({
				id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
				name: Schema.NonEmptyString,
				run: effectValue,
			}),
		),
	),
})

const decodeDeclaration = Schema.decodeUnknownResult(DeclarationSchema, { errors: "all" })
const decodeNamespace = Schema.decodeUnknownResult(
	Schema.Struct({ namespace: Schema.optional(Schema.String) }),
)

const declarationError = (declaration: unknown, cause: Schema.SchemaError): PersistenceError => {
	const issues = SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue).issues.map((issue) => ({
		path: (issue.path ?? []).map((part) =>
			typeof part === "number" ? part : typeof part === "string" ? part : String(part),
		),
		message: issue.message,
	}))
	return Error.make({
		kind: issues.some((issue) => issue.path[0] === "namespace")
			? "invalid_namespace"
			: "migration",
		namespace: Result.match(decodeNamespace(declaration), {
			onFailure: () => "unknown",
			onSuccess: (identity) => identity.namespace ?? "unknown",
		}),
		message: "Invalid persistence declaration",
		issues,
		cause,
	})
}

export interface SetOptions {
	readonly ttl?: Duration.Input
}

/**
 * Backend used by the core service. Values are already encoded JSON strings;
 * backend implementations own durability and transaction coordination.
 */
export interface Backend {
	readonly get: (
		namespace: string,
		key: string,
	) => Effect.Effect<Option.Option<string>, PersistenceError>
	readonly set: (
		namespace: string,
		key: string,
		value: string,
	) => Effect.Effect<void, PersistenceError>
	readonly remove: (namespace: string, key: string) => Effect.Effect<void, PersistenceError>
	readonly clear: (namespace: string) => Effect.Effect<void, PersistenceError>
	readonly size: (namespace: string) => Effect.Effect<number, PersistenceError>
	readonly keys: (namespace: string) => Effect.Effect<readonly string[], PersistenceError>
	readonly transaction: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | PersistenceError, R>
}

interface MemoryTransaction {
	readonly owner: Ref.Ref<Readonly<Record<string, string>>>
	readonly values: Ref.Ref<Readonly<Record<string, string>>>
	readonly lock: Semaphore.Semaphore
	readonly open: Ref.Ref<boolean>
}

const MemoryTransaction = Context.Reference<Option.Option<MemoryTransaction>>(
	"better-router/persistence/memory-transaction",
	{ defaultValue: Option.none },
)

const validName = (
	kind: "invalid_namespace" | "invalid_key",
	namespace: string,
	key?: string,
): Effect.Effect<void, PersistenceError> => {
	const value = kind === "invalid_namespace" ? namespace : (key ?? "")
	return value.length > 0
		? Effect.void
		: Effect.fail(
				Error.make({
					kind,
					namespace,
					...(key === undefined ? {} : { key }),
					message: `${kind === "invalid_namespace" ? "Namespace" : "Key"} must not be empty`,
				}),
			)
}

const validateMigrations = <Requirements>(
	namespace: string,
	migrations: readonly Migration<Requirements>[],
): Result.Result<readonly Migration<Requirements>[], PersistenceError> =>
	migrations.reduce<Result.Result<readonly Migration<Requirements>[], PersistenceError>>(
		(current, migration) =>
			Result.flatMap(current, (entries) =>
				migration.id < 1 || !Number.isInteger(migration.id) || migration.name.length === 0
					? Result.fail(
							Error.make({
								kind: "migration",
								namespace,
								message:
									"Migration ids must be positive integers and names must not be empty",
							}),
						)
					: entries.some((entry) => entry.id === migration.id)
						? Result.fail(
								Error.make({
									kind: "migration",
									namespace,
									message: `Duplicate migration id: ${String(migration.id)}`,
									issues: [
										{
											path: ["migrations", entries.length, "id"],
											message: "Duplicate migration id",
										},
									],
								}),
							)
						: Result.succeed([...entries, migration]),
			),
		Result.succeed([]),
	)

/** Validate static declaration metadata without touching a backend. */
export const makeDeclaration = <S extends Schema.Constraint, Requirements = never>(
	declaration: Declaration<S, Requirements>,
): Result.Result<Declaration<S, Requirements>, PersistenceError> =>
	decodeDeclaration(declaration).pipe(
		Result.mapError((cause) => declarationError(declaration, cause)),
		Result.map((decoded) => decoded as unknown as Declaration<S, Requirements>),
		Result.flatMap((decoded) =>
			validateMigrations(decoded.namespace, decoded.migrations ?? []).pipe(
				Result.map((migrations) => ({ ...decoded, migrations })),
			),
		),
	)

export interface StateStore<S extends Schema.Constraint = Schema.Constraint> {
	readonly namespace: string
	readonly schema: S
	readonly get: (
		key: string,
	) => Effect.Effect<Option.Option<S["Type"]>, StoreError, S["DecodingServices"]>
	readonly set: (
		key: string,
		value: S["Type"],
		options?: SetOptions,
	) => Effect.Effect<void, StoreError, S["EncodingServices"]>
	readonly update: (
		key: string,
		f: (current: Option.Option<S["Type"]>) => Option.Option<S["Type"]>,
		options?: SetOptions,
	) => Effect.Effect<
		Option.Option<S["Type"]>,
		StoreError,
		S["DecodingServices"] | S["EncodingServices"]
	>
	readonly compareAndSet: (
		key: string,
		expected: Option.Option<S["Type"]>,
		next: Option.Option<S["Type"]>,
		options?: SetOptions,
	) => Effect.Effect<void, StoreError, S["DecodingServices"] | S["EncodingServices"]>
	readonly cas: StateStore<S>["compareAndSet"]
	readonly remove: (key: string) => Effect.Effect<void, StoreError>
	readonly delete: StateStore<S>["remove"]
	readonly clear: Effect.Effect<void, StoreError>
	readonly size: Effect.Effect<number, StoreError>
	readonly transaction: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | PersistenceError, R>
}

export interface Service {
	readonly initialize: <Requirements = never>(
		declarations: readonly Declaration<Schema.Constraint, Requirements>[],
	) => Effect.Effect<void, PersistenceError, Requirements>
	readonly state: <S extends Schema.Constraint, Requirements>(
		declaration: Declaration<S, Requirements>,
	) => StateStore<S>
	readonly transaction: <A, E, R>(
		effect: Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | PersistenceError, R>
}

export class Persistence extends Context.Service<Persistence, Service>()(
	"BetterRouterPersistence",
) {}

const envelopeSchema = Schema.Struct({
	value: Schema.String,
	expiresAt: Schema.optional(Schema.Number),
})
const envelopeCodec = Schema.fromJsonString(Schema.toCodecJson(envelopeSchema))
const encodeEnvelope = Schema.encodeEffect(envelopeCodec)
const decodeEnvelope = Schema.decodeEffect(envelopeCodec)

const makeService = (backend: Backend, initialize: Service["initialize"]): Service => {
	const state = <S extends Schema.Constraint, Requirements>(
		declaration: Declaration<S, Requirements>,
	): StateStore<S> => {
		const codec = Schema.fromJsonString(Schema.toCodecJson(declaration.schema))
		const encode = Schema.encodeEffect(codec)
		const decode = Schema.decodeEffect(codec)
		const equivalent = Schema.toEquivalence(Schema.toType(declaration.schema))
		const run: Backend["transaction"] = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			validName("invalid_namespace", declaration.namespace).pipe(
				Effect.flatMap(() => backend.transaction(effect)),
			)
		const entry = (key: string) =>
			validName("invalid_key", declaration.namespace, key).pipe(
				Effect.flatMap(() => backend.get(declaration.namespace, key)),
				Effect.flatMap((raw) =>
					Clock.currentTimeMillis.pipe(Effect.map((now) => [raw, now] as const)),
				),
				Effect.flatMap(([raw, now]) =>
					Option.isNone(raw)
						? Effect.succeed(Option.none())
						: decodeEnvelope(raw.value).pipe(
								Effect.flatMap((decoded) =>
									decoded.expiresAt !== undefined && decoded.expiresAt <= now
										? backend
												.remove(declaration.namespace, key)
												.pipe(Effect.as(Option.none()))
										: Effect.succeed(Option.some(decoded.value)),
								),
							),
				),
			)
		const read = (key: string) =>
			entry(key).pipe(
				Effect.flatMap((raw) =>
					Option.isNone(raw)
						? Effect.succeed(Option.none())
						: decode(raw.value).pipe(Effect.map(Option.some)),
				),
			)
		const expiration = (options: SetOptions | undefined) => {
			const ttl = options?.ttl
			return ttl === undefined
				? Effect.succeed<number | undefined>(undefined)
				: Option.match(Duration.fromInput(ttl), {
						onNone: () =>
							Effect.fail(
								Error.make({
									kind: "backend",
									namespace: declaration.namespace,
									message: "TTL must be a finite, non-negative duration",
								}),
							),
						onSome: (duration) => {
							const milliseconds = Duration.toMillis(duration)
							return Number.isFinite(milliseconds) && milliseconds >= 0
								? Clock.currentTimeMillis.pipe(
										Effect.map((now) => now + milliseconds),
									)
								: Effect.fail(
										Error.make({
											kind: "backend",
											namespace: declaration.namespace,
											message: "TTL must be a finite, non-negative duration",
										}),
									)
						},
					})
		}
		const write = (key: string, value: S["Type"], options: SetOptions | undefined) =>
			Effect.all({ value: encode(value), expiresAt: expiration(options) }).pipe(
				Effect.flatMap((encoded) => encodeEnvelope(encoded)),
				Effect.flatMap((raw) => backend.set(declaration.namespace, key, raw)),
			)
		const get = (key: string) => run(read(key))
		const set = (key: string, value: S["Type"], options?: SetOptions) =>
			run(
				validName("invalid_key", declaration.namespace, key).pipe(
					Effect.flatMap(() => write(key, value, options)),
				),
			)
		const remove = (key: string) =>
			run(
				validName("invalid_key", declaration.namespace, key).pipe(
					Effect.flatMap(() => backend.remove(declaration.namespace, key)),
				),
			)
		const update: StateStore<S>["update"] = (
			key: string,
			f: (current: Option.Option<S["Type"]>) => Option.Option<S["Type"]>,
			options?: SetOptions,
		) =>
			run(
				read(key).pipe(
					Effect.flatMap((current) => {
						const next = f(current)
						return Option.isNone(next)
							? backend
									.remove(declaration.namespace, key)
									.pipe(Effect.as<Option.Option<S["Type"]>>(next))
							: write(key, next.value, options).pipe(
									Effect.as<Option.Option<S["Type"]>>(next),
								)
					}),
				),
			)
		const compareAndSet: StateStore<S>["compareAndSet"] = (
			key: string,
			expected: Option.Option<S["Type"]>,
			next: Option.Option<S["Type"]>,
			options?: SetOptions,
		) =>
			run(
				validName("invalid_key", declaration.namespace, key).pipe(
					Effect.flatMap(() => entry(key)),
					Effect.flatMap((current) =>
						Effect.all({
							actual: Option.isNone(current)
								? Effect.succeed(Option.none())
								: decode(current.value).pipe(Effect.map(Option.some)),
							expected: Option.isNone(expected)
								? Effect.succeed(Option.none())
								: encode(expected.value).pipe(
										Effect.flatMap(decode),
										Effect.map(Option.some),
									),
						}).pipe(
							Effect.flatMap(({ actual, expected: expectedEncoded }) => {
								const matches =
									(Option.isNone(actual) && Option.isNone(expectedEncoded)) ||
									(Option.isSome(actual) &&
										Option.isSome(expectedEncoded) &&
										equivalent(actual.value, expectedEncoded.value))
								return matches
									? Option.isNone(next)
										? backend.remove(declaration.namespace, key)
										: write(key, next.value, options)
									: Effect.fail<StoreError>(
											ConflictError.make({
												namespace: declaration.namespace,
												key,
												message:
													"Compare-and-set expectation did not match",
											}),
										)
							}),
						),
					),
				),
			)
		const clear: StateStore<S>["clear"] = run(backend.clear(declaration.namespace))
		const size: StateStore<S>["size"] = run(
			backend.keys(declaration.namespace).pipe(
				Effect.flatMap((keys) => Effect.forEach(keys, entry)),
				Effect.map((entries) => entries.filter(Option.isSome).length),
			),
		)
		const transaction: Backend["transaction"] = backend.transaction
		return {
			namespace: declaration.namespace,
			schema: declaration.schema,
			get,
			set,
			update,
			compareAndSet,
			cas: compareAndSet,
			remove,
			delete: remove,
			clear,
			size,
			transaction,
		}
	}
	return {
		initialize,
		state,
		transaction: backend.transaction,
	}
}

const makeMemoryBackend = Effect.gen(function* () {
	const state = yield* Ref.make<Readonly<Record<string, string>>>({})
	const lock = yield* Semaphore.make(1)
	const prefix = (namespace: string) => `${namespace.length}:${namespace}/`
	const scoped = (namespace: string, key: string) => `${prefix(namespace)}${key}`
	const current = Effect.withFiber((fiber) => {
		const frame = fiber.getRef(MemoryTransaction)
		return Option.isSome(frame) && frame.value.owner === state
			? Ref.get(frame.value.open).pipe(
					Effect.flatMap((open) =>
						open
							? Effect.succeed(frame.value.values)
							: Effect.fail(
									Error.make({
										kind: "backend",
										namespace: "memory",
										message: "Transaction has already closed",
									}),
								),
					),
				)
			: Effect.succeed(state)
	})
	const transaction: Backend["transaction"] = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
		Effect.withFiber((fiber) => {
			const parent = fiber.getRef(MemoryTransaction)
			const frame = Option.filter(parent, (entry) => entry.owner === state)
			const target = Option.isSome(frame) ? frame.value.values : state
			const semaphore = Option.isSome(frame) ? frame.value.lock : lock
			return semaphore.withPermit(
				Effect.uninterruptibleMask((restore) =>
					Effect.gen(function* () {
						const parentOpen = Option.isSome(frame)
							? yield* Ref.get(frame.value.open)
							: true
						if (!parentOpen)
							return yield* Effect.fail(
								Error.make({
									kind: "backend",
									namespace: "memory",
									message: "Transaction has already closed",
								}),
							)
						const snapshot = yield* Ref.get(target)
						const values = yield* Ref.make(snapshot)
						const childLock = yield* Semaphore.make(1)
						const open = yield* Ref.make(true)
						const exit = yield* Effect.exit(
							restore(
								Effect.provideService(
									Effect.awaitAllChildren(effect),
									MemoryTransaction,
									Option.some({ owner: state, values, lock: childLock, open }),
								),
							),
						)
						yield* childLock.withPermit(
							Ref.set(open, false).pipe(
								Effect.flatMap(() =>
									Exit.isSuccess(exit)
										? Ref.get(values).pipe(
												Effect.flatMap((next) => Ref.set(target, next)),
											)
										: Effect.void,
								),
							),
						)
						return yield* Effect.matchCauseEffect(exit, {
							onFailure: Effect.failCause,
							onSuccess: Effect.succeed,
						})
					}),
				),
			)
		})
	const keys = (namespace: string) =>
		current.pipe(
			Effect.flatMap(Ref.get),
			Effect.map((values) =>
				Object.keys(values)
					.filter((entry) => entry.startsWith(prefix(namespace)))
					.map((entry) => entry.slice(prefix(namespace).length)),
			),
		)
	const backend: Backend = {
		get: (namespace, key) =>
			current.pipe(
				Effect.flatMap(Ref.get),
				Effect.map((values) => Option.fromUndefinedOr(values[scoped(namespace, key)])),
			),
		set: (namespace, key, value) =>
			current.pipe(
				Effect.flatMap((ref) =>
					Ref.update(ref, (values) => ({ ...values, [scoped(namespace, key)]: value })),
				),
			),
		remove: (namespace, key) =>
			current.pipe(
				Effect.flatMap((ref) =>
					Ref.update(ref, (values) =>
						Object.fromEntries(
							Object.entries(values).filter(
								([entry]) => entry !== scoped(namespace, key),
							),
						),
					),
				),
			),
		clear: (namespace) =>
			current.pipe(
				Effect.flatMap((ref) =>
					Ref.update(ref, (values) =>
						Object.fromEntries(
							Object.entries(values).filter(
								([entry]) => !entry.startsWith(prefix(namespace)),
							),
						),
					),
				),
			),
		size: (namespace) => keys(namespace).pipe(Effect.map((entries) => entries.length)),
		keys,
		transaction,
	}
	return backend
})

const makeMemoryInitializer = (backend: Backend) =>
	Effect.gen(function* () {
		const completed = yield* Ref.make(HashSet.empty<string>())
		const lock = yield* Semaphore.make(1)
		const initialize: Service["initialize"] = <Requirements = never>(
			declarations: readonly Declaration<Schema.Constraint, Requirements>[],
		) =>
			lock.withPermit(
				Effect.forEach(
					declarations,
					(declaration) =>
						Result.match(makeDeclaration(declaration), {
							onFailure: Effect.fail,
							onSuccess: (validated) =>
								Effect.forEach(
									validated.migrations ?? [],
									(migration) =>
										Effect.gen(function* () {
											const key = `${validated.namespace.length}:${validated.namespace}/${String(migration.id)}`
											if (HashSet.has(yield* Ref.get(completed), key)) return
											yield* Effect.uninterruptibleMask((restore) =>
												restore(backend.transaction(migration.run)).pipe(
													Effect.catchCause((cause) =>
														Cause.hasInterruptsOnly(cause)
															? Effect.failCause(
																	cause as Cause.Cause<never>,
																)
															: Effect.fail(
																	Error.make({
																		kind: "migration",
																		namespace:
																			validated.namespace,
																		message: `Migration ${String(migration.id)} failed`,
																		cause,
																	}),
																),
													),
													Effect.flatMap(() =>
														Ref.update(completed, (entries) =>
															HashSet.add(entries, key),
														),
													),
												),
											)
										}),
									{ discard: true },
								),
						}),
					{ discard: true },
				),
			)
		return initialize
	})

const makeMemoryService = (backend: Backend) =>
	makeMemoryInitializer(backend).pipe(
		Effect.map((initialize) => makeService(backend, initialize)),
	)

export const layerMemory: Layer.Layer<Persistence> = Layer.effect(
	Persistence,
	makeMemoryBackend.pipe(Effect.flatMap(makeMemoryService)),
)

/** Build a core Persistence layer around an injected backend companion. */
export const layer = <E, Requirements>(backend: Effect.Effect<Backend, E, Requirements>) =>
	Layer.effect(Persistence, backend.pipe(Effect.flatMap(makeMemoryService)))

export const makeBackendService = (backend: Backend, initialize: Service["initialize"]): Service =>
	makeService(backend, initialize)
