import { Result, Schema, Stream } from "effect"
import type { Effect } from "effect"
import type { GenerationEvent, GenerationRequest } from "./Generation.js"
import type { Process } from "./GenerationProcess.js"
import type { ProviderError } from "./Provider.js"
import type { Identifier } from "./Identifier.js"

/** Stable identifiers never contain runtime health, counters or credentials. */
export type ProviderId<Value extends string = string> = Identifier<Value>
export type DeploymentId<Value extends string = string> = Identifier<Value>
export type ModelId<Value extends string = string> = Identifier<Value>
export type GenerationProtocol<Value extends string = string> = Identifier<Value>

const NonNegative = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Static cost metadata. It is safe to expose to routing policy code. */
export const Pricing = Schema.Struct({
	inputPerToken: Schema.optional(NonNegative),
	outputPerToken: Schema.optional(NonNegative),
	/** Short aliases are accepted for provider pricing tables. */
	input: Schema.optional(NonNegative),
	output: Schema.optional(NonNegative),
	currency: Schema.optional(Schema.NonEmptyString),
})

export type Pricing = typeof Pricing.Type

/** Static provider limits; live usage is kept in RoutingRuntime/Persistence. */
export const DeploymentLimits = Schema.Struct({
	maxConcurrent: Schema.optional(NonNegativeInt),
	maxConcurrency: Schema.optional(NonNegativeInt),
	rpm: Schema.optional(NonNegativeInt),
	requestsPerMinute: Schema.optional(NonNegativeInt),
	tpm: Schema.optional(NonNegativeInt),
	tokensPerMinute: Schema.optional(NonNegativeInt),
	maxTokens: Schema.optional(NonNegativeInt),
	maxInputTokens: Schema.optional(NonNegativeInt),
	maxOutputTokens: Schema.optional(NonNegativeInt),
})

export type DeploymentLimits = typeof DeploymentLimits.Type

export const DeploymentConfigSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	provider: Schema.NonEmptyString,
	model: Schema.NonEmptyString,
	protocol: Schema.NonEmptyString,
	credentialRef: Schema.optional(Schema.NonEmptyString),
	baseUrl: Schema.optional(Schema.NonEmptyString),
	weight: Schema.optional(NonNegative),
	pricing: Schema.optional(Pricing),
	limits: Schema.optional(DeploymentLimits),
	tags: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	/** Optional endpoint demand used by matrix preflight. */
	endpoint: Schema.optional(Schema.NonEmptyString),
	parameters: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	streaming: Schema.optional(Schema.Boolean),
	/** Required stable capabilities of the selected provider deployment. */
	capabilities: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})

export interface DeploymentConfig<
	Id extends string = string,
	Provider extends string = string,
	Model extends string = string,
	Protocol extends string = string,
> {
	readonly id: DeploymentId<Id>
	readonly provider: ProviderId<Provider>
	readonly model: ModelId<Model>
	readonly protocol: GenerationProtocol<Protocol>
	readonly credentialRef?: string | undefined
	readonly baseUrl?: string | undefined
	readonly weight?: number | undefined
	readonly pricing?: Pricing | undefined
	readonly limits?: DeploymentLimits | undefined
	readonly tags?: readonly string[] | undefined
	readonly endpoint?: string | undefined
	readonly parameters?: readonly string[] | undefined
	readonly streaming?: boolean | undefined
	readonly capabilities?: readonly string[] | undefined
}

/** Routing receives only static metadata and never receives credentials/base URLs. */
export const DeploymentRefSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	provider: Schema.NonEmptyString,
	model: Schema.NonEmptyString,
	protocol: Schema.NonEmptyString,
	weight: Schema.optional(NonNegative),
	pricing: Schema.optional(Pricing),
	limits: Schema.optional(DeploymentLimits),
	tags: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	endpoint: Schema.optional(Schema.NonEmptyString),
	parameters: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	streaming: Schema.optional(Schema.Boolean),
	capabilities: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})

export interface DeploymentRef<
	Id extends string = string,
	Provider extends string = string,
	Model extends string = string,
	Protocol extends string = string,
> {
	readonly id: DeploymentId<Id>
	readonly provider: ProviderId<Provider>
	readonly model: ModelId<Model>
	readonly protocol: GenerationProtocol<Protocol>
	readonly weight?: number | undefined
	readonly pricing?: Pricing | undefined
	readonly limits?: DeploymentLimits | undefined
	readonly tags?: readonly string[] | undefined
	readonly endpoint?: string | undefined
	readonly parameters?: readonly string[] | undefined
	readonly streaming?: boolean | undefined
	readonly capabilities?: readonly string[] | undefined
}

export const decodeConfig = (value: unknown): Result.Result<DeploymentConfig, Schema.SchemaError> =>
	Schema.decodeUnknownResult(DeploymentConfigSchema)(value).pipe(
		Result.map((decoded) => ({
			id: decoded.id,
			provider: decoded.provider,
			model: decoded.model,
			protocol: decoded.protocol,
			...(decoded.credentialRef === undefined
				? {}
				: { credentialRef: decoded.credentialRef }),
			...(decoded.baseUrl === undefined ? {} : { baseUrl: decoded.baseUrl }),
			...(decoded.weight === undefined ? {} : { weight: decoded.weight }),
			...(decoded.pricing === undefined ? {} : { pricing: decoded.pricing }),
			...(decoded.limits === undefined ? {} : { limits: decoded.limits }),
			...(decoded.tags === undefined ? {} : { tags: [...decoded.tags] }),
			...(decoded.endpoint === undefined ? {} : { endpoint: decoded.endpoint }),
			...(decoded.parameters === undefined ? {} : { parameters: [...decoded.parameters] }),
			...(decoded.streaming === undefined ? {} : { streaming: decoded.streaming }),
			...(decoded.capabilities === undefined
				? {}
				: { capabilities: [...decoded.capabilities] }),
		})),
	)

export const decodeRef = (value: unknown): Result.Result<DeploymentRef, Schema.SchemaError> =>
	Schema.decodeUnknownResult(DeploymentRefSchema)(value).pipe(
		Result.map((decoded) => ({
			id: decoded.id,
			provider: decoded.provider,
			model: decoded.model,
			protocol: decoded.protocol,
			...(decoded.weight === undefined ? {} : { weight: decoded.weight }),
			...(decoded.pricing === undefined ? {} : { pricing: decoded.pricing }),
			...(decoded.limits === undefined ? {} : { limits: decoded.limits }),
			...(decoded.tags === undefined ? {} : { tags: [...decoded.tags] }),
			...(decoded.endpoint === undefined ? {} : { endpoint: decoded.endpoint }),
			...(decoded.parameters === undefined ? {} : { parameters: [...decoded.parameters] }),
			...(decoded.streaming === undefined ? {} : { streaming: decoded.streaming }),
			...(decoded.capabilities === undefined
				? {}
				: { capabilities: [...decoded.capabilities] }),
		})),
	)

/** Ingress transport is independent from the selected upstream deployment. */
export type UpstreamTransport = "http" | "websocket"

export interface InvocationOptions {
	readonly upstream?: {
		readonly transport: UpstreamTransport
		readonly mode: "prefer" | "require"
	}
}

/**
 * Legacy executable aliases remain type-only helpers for provider adapters. A
 * DeploymentConfig itself never stores one of these functions.
 */
export type GenerationExecutor<Requirements = never> = (
	request: GenerationRequest,
) => Effect.Effect<Process<ProviderError, Requirements>, ProviderError, Requirements>

export type GenerationExecutors<Requirements = never> =
	| {
			readonly http: GenerationExecutor<Requirements>
			readonly websocket?: GenerationExecutor<Requirements>
	  }
	| {
			readonly http?: GenerationExecutor<Requirements>
			readonly websocket: GenerationExecutor<Requirements>
	  }

/** Static deployment declaration. Runtime executors are supplied by ProviderContract. */
export type Deployment<
	Id extends string = string,
	Provider extends string = string,
	Model extends string = string,
	Protocol extends string = string,
> = DeploymentConfig<Id, Provider, Model, Protocol>

/** Construct a declaration while cloning caller-owned arrays at the boundary. */
export const make = <
	const Id extends string,
	const Provider extends string,
	const Model extends string,
	const Protocol extends string,
>(
	definition: DeploymentConfig<Id, Provider, Model, Protocol>,
): DeploymentConfig<Id, Provider, Model, Protocol> => ({
	id: definition.id,
	provider: definition.provider,
	model: definition.model,
	protocol: definition.protocol,
	...(definition.credentialRef === undefined ? {} : { credentialRef: definition.credentialRef }),
	...(definition.baseUrl === undefined ? {} : { baseUrl: definition.baseUrl }),
	...(definition.weight === undefined ? {} : { weight: definition.weight }),
	...(definition.pricing === undefined ? {} : { pricing: { ...definition.pricing } }),
	...(definition.limits === undefined ? {} : { limits: { ...definition.limits } }),
	...(definition.tags === undefined ? {} : { tags: [...definition.tags] }),
	...(definition.endpoint === undefined ? {} : { endpoint: definition.endpoint }),
	...(definition.parameters === undefined ? {} : { parameters: [...definition.parameters] }),
	...(definition.streaming === undefined ? {} : { streaming: definition.streaming }),
	...(definition.capabilities === undefined
		? {}
		: { capabilities: [...definition.capabilities] }),
})

/** Convert a deployment into the redacted shape consumed by routing strategies. */
export const ref = <
	const Id extends string,
	const Provider extends string,
	const Model extends string,
	const Protocol extends string,
>(
	deployment: DeploymentConfig<Id, Provider, Model, Protocol>,
): DeploymentRef<Id, Provider, Model, Protocol> => ({
	id: deployment.id,
	provider: deployment.provider,
	model: deployment.model,
	protocol: deployment.protocol,
	...(deployment.weight === undefined ? {} : { weight: deployment.weight }),
	...(deployment.pricing === undefined ? {} : { pricing: { ...deployment.pricing } }),
	...(deployment.limits === undefined ? {} : { limits: { ...deployment.limits } }),
	...(deployment.tags === undefined ? {} : { tags: [...deployment.tags] }),
	...(deployment.endpoint === undefined ? {} : { endpoint: deployment.endpoint }),
	...(deployment.parameters === undefined ? {} : { parameters: [...deployment.parameters] }),
	...(deployment.streaming === undefined ? {} : { streaming: deployment.streaming }),
	...(deployment.capabilities === undefined
		? {}
		: { capabilities: [...deployment.capabilities] }),
})

export const validate = (value: unknown): Result.Result<DeploymentConfig, Schema.SchemaError> =>
	decodeConfig(value)

export type GenerationEvents = Stream.Stream<GenerationEvent, ProviderError>
