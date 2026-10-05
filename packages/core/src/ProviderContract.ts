import { Context, Effect, Layer, Result, Schema } from "effect"
import type { Redacted } from "effect"
import * as Capability from "./Capability.js"
import type { Capability as CapabilityType } from "./Capability.js"
import type { DeploymentConfig } from "./Deployment.js"
import type { GenerationRequest } from "./Generation.js"
import type { Process } from "./GenerationProcess.js"
import type { ProviderError, Service as ProviderService } from "./Provider.js"

/** A provider-facing endpoint and its supported parameter/stream matrix. */
export const Endpoint = Schema.Struct({
	id: Schema.NonEmptyString,
	parameters: Schema.Array(Schema.NonEmptyString),
	streaming: Schema.Boolean,
	capabilities: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})

export type Endpoint = typeof Endpoint.Type

export const CapabilityReference = Schema.Struct({
	id: Schema.NonEmptyString,
	version: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})

export type CapabilityReference = typeof CapabilityReference.Type

export const Issue = Schema.Struct({
	path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
	message: Schema.String,
})

export type Issue = typeof Issue.Type

export class Error extends Schema.TaggedError<Error>()("ProviderContractError", {
	provider: Schema.String,
	message: Schema.String,
	deployment: Schema.optional(Schema.String),
	protocol: Schema.optional(Schema.String),
	issues: Schema.optional(Schema.Array(Issue)),
}) {}

export type ProviderContractError = typeof Error.Type

/** One host-owned credential service can serve any number of deployments. */
export class CredentialResolver extends Context.Service<
	CredentialResolver,
	{
		readonly resolve: (
			reference: string,
		) => Effect.Effect<Redacted.Redacted<string>, ProviderError>
	}
>()("BetterRouterCredentialResolver") {}

export type ResolveCredential = (
	reference: string,
) => Effect.Effect<Redacted.Redacted<string>, ProviderError>

export const credentialResolverLayer = (
	resolve: ResolveCredential,
): Layer.Layer<CredentialResolver> => Layer.succeed(CredentialResolver, { resolve })

export interface RequestContext {
	readonly deployment: DeploymentConfig
	readonly request: GenerationRequest
	readonly metadata: Readonly<Record<string, unknown>>
}

export interface ProviderRequest {
	readonly url: string
	readonly method: string
	readonly headers: Readonly<Record<string, string>>
	readonly body: unknown
}

export interface ProviderResponse {
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	readonly body: unknown
}

export interface ProviderRuntime<Requirements = never> {
	readonly generate: (
		request: GenerationRequest,
	) => Effect.Effect<Process<ProviderError, Requirements>, ProviderError, Requirements>
}

export type RuntimeFactory<Requirements = never> = (
	deployment: DeploymentConfig,
) => Effect.Effect<ProviderRuntime<Requirements>, ProviderContractError, Requirements>

const FunctionSchema = Schema.declare(
	(value): value is (...arguments_: readonly unknown[]) => unknown => typeof value === "function",
)

const DeploymentSchema = Schema.declare(
	(value): value is Schema.ConstraintDecoder<DeploymentConfig> => Schema.isSchema(value),
)

const CapabilityRef = Schema.Union([Capability.SchemaDefinition, CapabilityReference])

/** Static provider contract. Runtime state and credentials are supplied by Layers. */
export interface ProviderContract<Id extends string = string, Requirements = never> {
	readonly id: Id
	readonly capabilities?: readonly (CapabilityType | CapabilityReference)[] | undefined
	readonly endpoints: readonly Endpoint[]
	readonly protocols?: readonly string[] | undefined
	/** Pure Schema for provider-specific static deployment fields. */
	readonly deploymentSchema?: Schema.Constraint | undefined
	readonly runtime?: RuntimeFactory<Requirements> | undefined
	readonly encode?:
		| ((context: RequestContext) => Result.Result<ProviderRequest, ProviderContractError>)
		| undefined
	readonly decode?:
		| ((
				context: RequestContext,
				response: ProviderResponse,
		  ) => Result.Result<ProviderResponse, ProviderContractError>)
		| undefined
	readonly validateEnvironment?:
		((deployment: DeploymentConfig) => Result.Result<void, ProviderContractError>) | undefined
}

export const ProviderContractSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	capabilities: Schema.optional(Schema.Array(CapabilityRef)),
	endpoints: Schema.Array(Endpoint).check(Schema.isMinLength(1)),
	protocols: Schema.optional(Schema.Array(Schema.NonEmptyString)),
	deploymentSchema: Schema.optional(DeploymentSchema),
	runtime: Schema.optional(FunctionSchema),
	encode: Schema.optional(FunctionSchema),
	decode: Schema.optional(FunctionSchema),
	validateEnvironment: Schema.optional(FunctionSchema),
})

export const make = <const Id extends string, const Requirements = never>(
	definition: ProviderContract<Id, Requirements>,
): ProviderContract<Id, Requirements> => {
	const capabilities = definition.capabilities?.map((capability) =>
		"kind" in capability ? Capability.make(capability) : { ...capability },
	)
	return {
		id: definition.id,
		...(capabilities === undefined ? {} : { capabilities }),
		endpoints: definition.endpoints.map((endpoint) => ({
			...endpoint,
			parameters: [...endpoint.parameters],
			...(endpoint.capabilities === undefined
				? {}
				: { capabilities: [...endpoint.capabilities] }),
		})),
		...(definition.protocols === undefined ? {} : { protocols: [...definition.protocols] }),
		...(definition.deploymentSchema === undefined
			? {}
			: { deploymentSchema: definition.deploymentSchema }),
		...(definition.runtime === undefined ? {} : { runtime: definition.runtime }),
		...(definition.encode === undefined ? {} : { encode: definition.encode }),
		...(definition.decode === undefined ? {} : { decode: definition.decode }),
		...(definition.validateEnvironment === undefined
			? {}
			: { validateEnvironment: definition.validateEnvironment }),
	}
}

/** Decode only validates a boundary; Registry retains the trusted declaration callbacks. */
export const decode = (value: unknown): Result.Result<ProviderContract, Schema.SchemaError> =>
	Schema.decodeUnknownResult(ProviderContractSchema, { onExcessProperty: "error" })(value).pipe(
		Result.map((decoded) =>
			make({
				id: decoded.id,
				endpoints: decoded.endpoints,
				...(decoded.capabilities === undefined
					? {}
					: { capabilities: decoded.capabilities }),
				...(decoded.protocols === undefined ? {} : { protocols: decoded.protocols }),
				...(decoded.deploymentSchema === undefined
					? {}
					: { deploymentSchema: decoded.deploymentSchema }),
				...(decoded.runtime === undefined
					? {}
					: { runtime: decoded.runtime as RuntimeFactory }),
				...(decoded.encode === undefined
					? {}
					: { encode: decoded.encode as ProviderContract["encode"] }),
				...(decoded.decode === undefined
					? {}
					: { decode: decoded.decode as ProviderContract["decode"] }),
				...(decoded.validateEnvironment === undefined
					? {}
					: {
							validateEnvironment:
								decoded.validateEnvironment as ProviderContract["validateEnvironment"],
						}),
			}),
		),
	)

const capabilityId = (value: CapabilityType | CapabilityReference): string => value.id

const endpointSupportsProtocol = (endpoint: Endpoint, deployment: DeploymentConfig): boolean =>
	(endpoint.id === "generation" || endpoint.id === deployment.protocol) &&
	(deployment.endpoint === undefined || endpoint.id === deployment.endpoint)

const supportsParameters = (endpoint: Endpoint, deployment: DeploymentConfig): boolean =>
	(deployment.parameters ?? []).every((parameter) => endpoint.parameters.includes(parameter))

const supportsStreaming = (endpoint: Endpoint, deployment: DeploymentConfig): boolean =>
	deployment.streaming !== true || endpoint.streaming

const supportsCapabilities = (
	contract: ProviderContract<any, any>,
	endpoint: Endpoint,
	deployment: DeploymentConfig,
): boolean => {
	const available =
		endpoint.capabilities === undefined
			? (contract.capabilities ?? []).map(capabilityId)
			: endpoint.capabilities
	return (deployment.capabilities ?? []).every((capability) => available.includes(capability))
}

/** Return the capability inventory of the endpoint selected for one deployment. */
export const capabilitiesForDeployment = (
	contract: ProviderContract<any, any>,
	deployment: DeploymentConfig,
): readonly string[] =>
	contract.endpoints
		.filter(
			(endpoint) =>
				endpointSupportsProtocol(endpoint, deployment) &&
				supportsParameters(endpoint, deployment) &&
				supportsStreaming(endpoint, deployment) &&
				supportsCapabilities(contract, endpoint, deployment),
		)
		.flatMap((endpoint) =>
			endpoint.capabilities === undefined
				? (contract.capabilities ?? []).map(capabilityId)
				: endpoint.capabilities,
		)
		.reduce<readonly string[]>(
			(current, id) => (current.includes(id) ? current : [...current, id]),
			[],
		)

/** Determine whether the provider contract can execute one static deployment. */
export const supports = (
	contract: ProviderContract<any, any>,
	deployment: DeploymentConfig,
): boolean =>
	deployment.provider === contract.id &&
	(contract.protocols === undefined || contract.protocols.includes(deployment.protocol)) &&
	contract.endpoints.some(
		(endpoint) =>
			endpointSupportsProtocol(endpoint, deployment) &&
			supportsParameters(endpoint, deployment) &&
			supportsStreaming(endpoint, deployment) &&
			supportsCapabilities(contract, endpoint, deployment),
	)

/** Check a deployment before credentials, clients or plugin Layers are acquired. */
export const validateDeployment = (
	contract: ProviderContract<any, any>,
	deployment: DeploymentConfig,
): Result.Result<void, ProviderContractError> =>
	supports(contract, deployment)
		? contract.validateEnvironment === undefined
			? Result.succeed(void 0)
			: Result.try({
					try: () => contract.validateEnvironment?.(deployment) ?? Result.succeed(void 0),
					catch: (cause) =>
						Error.make({
							provider: contract.id,
							deployment: deployment.id,
							protocol: deployment.protocol,
							message:
								cause instanceof globalThis.Error
									? cause.message
									: "Provider environment validation failed",
						}),
				}).pipe(
					Result.flatMap((result) =>
						Result.isResult(result)
							? result
							: Result.fail(
									Error.make({
										provider: contract.id,
										deployment: deployment.id,
										protocol: deployment.protocol,
										message:
											"Provider environment validation returned an invalid result",
									}),
								),
					),
				)
		: Result.fail(
				Error.make({
					provider: contract.id,
					deployment: deployment.id,
					protocol: deployment.protocol,
					message: `Provider ${contract.id} does not support protocol, endpoint, parameter or capability demand for ${deployment.protocol}`,
				}),
			)

export const runtimeService = <Requirements>(
	runtime: ProviderRuntime<Requirements>,
): ProviderService<GenerationRequest, Requirements> => ({
	generate: runtime.generate,
})
