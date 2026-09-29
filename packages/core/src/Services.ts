import {
	Context,
	Effect,
	HashMap,
	Layer,
	Option,
	Ref,
	Result,
	Schema,
	Stream,
	SubscriptionRef,
} from "effect"

export interface CredentialResolverService {
	readonly resolve: (name: string) => Effect.Effect<unknown, unknown>
}
export class CredentialResolver extends Context.Service<
	CredentialResolver,
	CredentialResolverService
>()("CredentialResolver") {}

export interface ModelCatalogService {
	readonly contains: (model: string) => Effect.Effect<boolean>
	readonly models: Effect.Effect<readonly string[]>
}
export class ModelCatalog extends Context.Service<ModelCatalog, ModelCatalogService>()(
	"ModelCatalog",
) {}

export const modelCatalogMemory = (models: readonly string[]): Layer.Layer<ModelCatalog> =>
	Layer.succeed(ModelCatalog, {
		contains: (model) => Effect.succeed(models.includes(model)),
		models: Effect.succeed(models),
	})

export interface HealthStateService {
	readonly isHealthy: (deployment: string) => Effect.Effect<boolean>
	readonly changes: Stream.Stream<Readonly<Record<string, boolean>>>
}
export class HealthState extends Context.Service<HealthState, HealthStateService>()(
	"HealthState",
) {}

export const healthMemory = (
	initial: Readonly<Record<string, boolean>> = {},
): Layer.Layer<HealthState> =>
	Layer.effect(
		HealthState,
		Effect.map(SubscriptionRef.make(initial), (state) => ({
			isHealthy: (deployment: string) =>
				Effect.map(SubscriptionRef.get(state), (values) => values[deployment] ?? false),
			changes: SubscriptionRef.changes(state),
		})),
	)

export interface CacheService {
	readonly get: (key: string) => Effect.Effect<Option.Option<unknown>, unknown>
	readonly set: (key: string, value: unknown, ttlMillis?: number) => Effect.Effect<void, unknown>
	readonly remove: (key: string) => Effect.Effect<void, unknown>
}
export class Cache extends Context.Service<Cache, CacheService>()("Cache") {}

export const cacheMemory: Layer.Layer<Cache> = Layer.effect(
	Cache,
	Effect.map(Ref.make(HashMap.empty<string, unknown>()), (state) => ({
		get: (key: string) => Effect.map(Ref.get(state), (values) => HashMap.get(values, key)),
		set: (key: string, value: unknown) =>
			Ref.update(state, (values) => HashMap.set(values, key, value)),
		remove: (key: string) => Ref.update(state, (values) => HashMap.remove(values, key)),
	})),
)

const makeMemoryStore = (): Effect.Effect<{
	readonly get: (key: string) => Effect.Effect<Option.Option<unknown>, unknown>
	readonly set: (key: string, value: unknown) => Effect.Effect<void, unknown>
	readonly remove: (key: string) => Effect.Effect<void, unknown>
}> =>
	Effect.map(Ref.make(HashMap.empty<string, unknown>()), (state) => ({
		get: (key: string) => Effect.map(Ref.get(state), (values) => HashMap.get(values, key)),
		set: (key: string, value: unknown) =>
			Ref.update(state, (values) => HashMap.set(values, key, value)),
		remove: (key: string) => Ref.update(state, (values) => HashMap.remove(values, key)),
	}))

export interface BudgetLedgerService {
	readonly reserve: (tenant: string, amount: number) => Effect.Effect<void, BudgetError>
	readonly settle: (tenant: string, amount: number) => Effect.Effect<void, BudgetError>
}
export class BudgetLedger extends Context.Service<BudgetLedger, BudgetLedgerService>()(
	"BudgetLedger",
) {}

export class BudgetError extends Schema.TaggedError<BudgetError>()("BudgetError", {
	tenant: Schema.String,
	message: Schema.String,
}) {}

export const budgetMemory = (
	limits: Readonly<Record<string, number>> = {},
): Layer.Layer<BudgetLedger> =>
	Layer.effect(
		BudgetLedger,
		Effect.map(Ref.make(HashMap.empty<string, number>()), (state) => ({
			reserve: (tenant: string, amount: number) =>
				Ref.modify(
					state,
					(
						used,
					): readonly [
						Result.Result<void, BudgetError>,
						HashMap.HashMap<string, number>,
					] => {
						const current = HashMap.get(used, tenant).pipe(Option.getOrElse(() => 0))
						const limit = limits[tenant]
						const next = current + amount
						const decision: Result.Result<void, BudgetError> =
							limit !== undefined && next > limit
								? (Result.fail(
										BudgetError.make({
											tenant,
											message: "Budget limit exceeded",
										}),
									) as Result.Result<void, BudgetError>)
								: (Result.succeed(void 0) as Result.Result<void, BudgetError>)
						return decision._tag === "Failure"
							? [decision, used]
							: [decision, HashMap.set(used, tenant, next)]
					},
				).pipe(Effect.flatMap((result) => Effect.fromResult(result))),
			settle: (tenant: string, amount: number) =>
				Ref.update(state, (used) =>
					HashMap.set(
						used,
						tenant,
						Math.max(
							0,
							HashMap.get(used, tenant).pipe(Option.getOrElse(() => 0)) - amount,
						),
					),
				),
		})),
	)

export interface ResponseStoreService {
	readonly get: (id: string) => Effect.Effect<Option.Option<unknown>, unknown>
	readonly put: (id: string, value: unknown) => Effect.Effect<void, unknown>
}
export class ResponseStore extends Context.Service<ResponseStore, ResponseStoreService>()(
	"ResponseStore",
) {}

const makeObjectStore = (): Effect.Effect<ResponseStoreService> =>
	Effect.map(Ref.make(HashMap.empty<string, unknown>()), (state) => ({
		get: (key: string) => Effect.map(Ref.get(state), (values) => HashMap.get(values, key)),
		put: (key: string, value: unknown) =>
			Ref.update(state, (values) => HashMap.set(values, key, value)),
	}))

export const responseMemory: Layer.Layer<ResponseStore> = Layer.effect(
	ResponseStore,
	makeObjectStore(),
)

export interface JobStoreService {
	readonly get: (id: string) => Effect.Effect<Option.Option<unknown>, unknown>
	readonly put: (id: string, value: unknown) => Effect.Effect<void, unknown>
}
export class JobStore extends Context.Service<JobStore, JobStoreService>()("JobStore") {}

export const jobMemory: Layer.Layer<JobStore> = Layer.effect(JobStore, makeObjectStore())

export interface ProviderTransportService {
	readonly request: (provider: string, input: unknown) => Effect.Effect<unknown, unknown>
}
export class ProviderTransport extends Context.Service<
	ProviderTransport,
	ProviderTransportService
>()("ProviderTransport") {}

export interface HttpClientService {
	readonly execute: (request: unknown) => Effect.Effect<unknown, unknown>
}
export class HttpClient extends Context.Service<HttpClient, HttpClientService>()(
	"RouterHttpClient",
) {}

export interface FileSystemService {
	readonly read: (path: string) => Effect.Effect<Uint8Array, unknown>
	readonly write: (path: string, data: Uint8Array) => Effect.Effect<void, unknown>
}
export class FileSystem extends Context.Service<FileSystem, FileSystemService>()(
	"RouterFileSystem",
) {}

export interface ClockService {
	readonly now: Effect.Effect<number>
}
export class Clock extends Context.Service<Clock, ClockService>()("RouterClock") {}

export interface RandomService {
	readonly next: Effect.Effect<number>
}
export class Random extends Context.Service<Random, RandomService>()("RouterRandom") {}

export interface LifecycleObserverService {
	readonly record: (event: unknown) => Effect.Effect<void>
}
export class LifecycleObserver extends Context.Service<
	LifecycleObserver,
	LifecycleObserverService
>()("LifecycleObserver") {}

export interface TracerService {
	readonly span: <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}
export class Tracer extends Context.Service<Tracer, TracerService>()("Tracer") {}

export interface MetricsService {
	readonly increment: (name: string, amount?: number) => Effect.Effect<void>
}
export class Metrics extends Context.Service<Metrics, MetricsService>()("Metrics") {}

export interface KeyValueStoreService {
	readonly get: (key: string) => Effect.Effect<Option.Option<unknown>, unknown>
	readonly set: (key: string, value: unknown) => Effect.Effect<void, unknown>
	readonly remove: (key: string) => Effect.Effect<void, unknown>
}
export class KeyValueStore extends Context.Service<KeyValueStore, KeyValueStoreService>()(
	"KeyValueStore",
) {}

export const keyValueMemory: Layer.Layer<KeyValueStore> = Layer.effect(
	KeyValueStore,
	makeMemoryStore(),
)
