import type { Effect } from "effect"
import { HttpApi } from "effect/http-api"
import type { Schema } from "effect"
import type { Contract } from "./Api.js"
import type { Capability } from "./Capability.js"
import type { DeploymentConfig, DeploymentRef } from "./Deployment.js"
import type { GenerationEvent, GenerationRequest } from "./Generation.js"
import type {
	AttemptHookContext,
	ErrorHookContext,
	FinalizeHookContext,
	HookEffect,
	RequestHookContext,
	RequestErrorHookContext,
	ResponseHookContext,
	SuccessHookContext,
} from "./Hooks.js"
import type { Declaration } from "./Persistence.js"
import type { PolicyContext } from "./Policies.js"
import type { ProviderContract } from "./ProviderContract.js"
import type { Process } from "./GenerationProcess.js"
import type { RoutingContext } from "./Routing.js"

/** Retry limits are static policy declarations; counters belong to RoutingRuntime. */
export interface RetryConfig {
	readonly maxAttempts?: number | undefined
	readonly retriesPerDeployment?: number | undefined
	readonly delayMillis?: number | undefined
	readonly cooldownMillis?: number | undefined
	readonly retryableKinds?: readonly string[] | undefined
}

/** A budget declaration names a host-owned ledger; the ledger itself is runtime state. */
export interface BudgetConfig {
	readonly key?: string | undefined
	readonly limit: number
	readonly reservation?: number | undefined
}

export interface AccessConfig {
	readonly metadataKey: string
	readonly allow: readonly string[]
}

/** A public model alias and its ordered private deployment candidates. */
export interface ModelRouteConfig<
	Model extends string = string,
	Deployment extends string = string,
	Policy extends string = string,
> {
	readonly id?: string | undefined
	readonly model: Model
	readonly deployments: readonly Deployment[]
	readonly policy?: Policy | undefined
	readonly strategy?: string | undefined
	readonly pipelines?: readonly string[] | undefined
	readonly middleware?: readonly string[] | undefined
	readonly fallback?: readonly Deployment[] | undefined
	readonly retry?: RetryConfig | undefined
	readonly requiredTags?: readonly string[] | undefined
	readonly requiredCapabilities?: readonly string[] | undefined
	readonly requiredParameters?: readonly string[] | undefined
	readonly streaming?: boolean | undefined
	readonly budget?: BudgetConfig | undefined
	readonly access?: AccessConfig | undefined
}

/** A policy may rank an already preflighted candidate set. */
export interface RoutingPolicy<Id extends string = string, Requirements = never> {
	readonly id: Id
	readonly strategy?: string | undefined
	readonly rank?: (
		request: GenerationRequest,
		candidates: readonly DeploymentRef[],
		context: PolicyContext,
		routing?: RoutingContext,
	) => Effect.Effect<readonly DeploymentRef[], unknown, Requirements>
}

export interface Pipeline<Id extends string = string, Requirements = never> {
	readonly id: Id
	readonly run: (context: RoutingContext) => Effect.Effect<RoutingContext, unknown, Requirements>
}

export type Handler<Requirements = never> = (
	context: RoutingContext,
) => Effect.Effect<Process<unknown, Requirements>, unknown, Requirements>

/** Middleware is a declaration. It cannot mutate the registry or static config. */
export interface Middleware<Id extends string = string, Requirements = never> {
	readonly id: Id
	readonly wrap: <R>(next: Handler<R>) => Handler<R | Requirements>
}

/** Request and attempt hooks have separate contexts and deterministic host ordering. */
export interface Hook<Id extends string = string, Requirements = never, ErrorType = unknown> {
	readonly id: Id
	readonly beforeRequest?: HookEffect<RequestHookContext, ErrorType, Requirements> | undefined
	readonly beforeAttempt?: HookEffect<AttemptHookContext, ErrorType, Requirements> | undefined
	readonly afterResponse?: HookEffect<ResponseHookContext, ErrorType, Requirements> | undefined
	readonly afterSuccess?: HookEffect<SuccessHookContext, ErrorType, Requirements> | undefined
	readonly afterFailure?:
		HookEffect<ErrorHookContext<ErrorType>, ErrorType, Requirements> | undefined
	readonly onError?:
		HookEffect<RequestErrorHookContext<ErrorType>, ErrorType, Requirements> | undefined
	readonly onCancel?: HookEffect<RequestHookContext, ErrorType, Requirements> | undefined
	readonly onStreamEvent?:
		| HookEffect<
				AttemptHookContext & { readonly event: GenerationEvent },
				ErrorType,
				Requirements
		  >
		| undefined
	readonly onFinalize?:
		HookEffect<FinalizeHookContext<ErrorType>, ErrorType, Requirements> | undefined
}

export interface Projection<
	Id extends string = string,
	Protocol extends string = string,
	CapabilityId extends string = string,
> {
	readonly id: Id
	readonly protocol: Protocol
	readonly capability: CapabilityId
	readonly decode?: ((value: unknown) => unknown) | undefined
	readonly encode?: ((value: unknown) => unknown) | undefined
}

/** Context passed to plugin-owned HTTP handlers after transport decoding. */
export interface HttpContext {
	readonly method: string
	readonly path: string
	readonly headers: Readonly<Record<string, string>>
}

export type HttpHandler<Requirements = never, Input = unknown, Output = unknown> = (
	input: Input,
	context: HttpContext,
) => Effect.Effect<Output, unknown, Requirements>

export interface HttpMiddleware<Requirements = never> {
	readonly id: string
	readonly wrap: <R>(next: HttpHandler<R>) => HttpHandler<R | Requirements>
}

/** A protocol contribution supplies its Effect HTTP API and host adapter. */
export interface HttpContractContribution<
	Api extends HttpApi.Constraint = HttpApi.Constraint,
	Requirements = never,
> {
	readonly id: string
	readonly api: Api
	readonly contract: Contract<Api, Requirements>
}

/** A direct declaration is mounted by the core HTTP helper. */
export interface HttpEndpointContribution<
	Requirements = never,
	Input extends Schema.Constraint = Schema.Constraint,
	Output extends Schema.Constraint = Schema.Constraint,
> {
	readonly id: string
	readonly method: string
	readonly path: string
	readonly input: Input
	readonly output: Output
	readonly handler: HttpHandler<Requirements, Input["Type"], Output["Type"]>
	readonly middleware?: readonly HttpMiddleware<Requirements>[] | undefined
}

export type HttpContribution<
	Api extends HttpApi.Constraint = HttpApi.Constraint,
	Requirements = never,
> = HttpContractContribution<Api, Requirements> | HttpEndpointContribution<Requirements, any, any>

/** Persistence declarations are static schemas and migrations; stores are runtime services. */
export type PersistenceContribution<Requirements = never> = Declaration<
	Schema.Constraint,
	Requirements
>

/** Static declarations collected from one object plugin. */
export interface PluginConfig<Requirements = never> {
	readonly providers?: readonly ProviderContract<any, any>[] | undefined
	/** Optional plugin-local Schema for provider-specific deployment declarations. */
	readonly deploymentSchema?: Schema.Constraint | undefined
	readonly deployments?: readonly DeploymentConfig[] | undefined
	readonly modelRoutes?: readonly ModelRouteConfig[] | undefined
	readonly policies?: readonly RoutingPolicy<any, Requirements>[] | undefined
	readonly pipelines?: readonly Pipeline<any, Requirements>[] | undefined
	readonly projections?: readonly Projection[] | undefined
	readonly middleware?: readonly Middleware<any, Requirements>[] | undefined
	readonly hooks?: readonly Hook<any, Requirements, any>[] | undefined
	readonly http?: readonly HttpContribution<any, Requirements>[] | undefined
	readonly persistence?: readonly PersistenceContribution<Requirements>[] | undefined
}

export type PluginContributions<Requirements = never> = PluginConfig<Requirements>

/** Fully populated immutable declaration view used by Registry reducers. */
export interface NormalizedPluginContributions {
	readonly providers: readonly ProviderContract<any, any>[]
	readonly deployments: readonly DeploymentConfig[]
	readonly modelRoutes: readonly ModelRouteConfig[]
	readonly policies: readonly RoutingPolicy<any, any>[]
	readonly pipelines: readonly Pipeline<any, any>[]
	readonly projections: readonly Projection[]
	readonly middleware: readonly Middleware<any, any>[]
	readonly hooks: readonly Hook<any, any, any>[]
	readonly http: readonly HttpContribution<any, any>[]
	readonly persistence: readonly PersistenceContribution<any>[]
}

export const empty = (): PluginConfig => ({})

/** Capability declarations can be named in config without importing a runtime executor. */
export type CapabilityContribution = Capability
