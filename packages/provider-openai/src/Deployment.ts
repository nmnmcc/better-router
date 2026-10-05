import { Effect, Redacted, Result, Schema, SchemaIssue } from "effect"
import { HttpClient, Url } from "effect/http"
import type { GenerationRequest } from "@better-router/core/Generation"
import type { Process } from "@better-router/core/GenerationProcess"
import { Error as ProviderError } from "@better-router/core/Provider"
import {
	CredentialResolver,
	Error as ProviderContractError,
	type ProviderContract as CoreProviderContract,
	type RuntimeFactory,
} from "@better-router/core/ProviderContract"
import {
	DeploymentConfigSchema as CoreDeploymentConfigSchema,
	type DeploymentConfig as CoreDeploymentConfig,
} from "@better-router/core/Deployment"
import type { Capability } from "@better-router/core/Capability"
import * as RouterPlugin from "@better-router/core/Plugin"
import type { ModelRouteConfig } from "@better-router/core/PluginContributions"
import * as Responses from "./OpenAIResponses.js"
import * as Chat from "./OpenAIChatCompletions.js"

/** The static part of an OpenAI deployment. Credentials are resolved by reference. */
export interface DeploymentConfig extends CoreDeploymentConfig<
	string,
	"openai",
	string,
	"responses" | "chat-completions"
> {}

type CoreDeployment = CoreDeploymentConfig<string, string, string, string>

export const DeploymentConfigSchema = Schema.Struct({
	...CoreDeploymentConfigSchema.fields,
	provider: Schema.Literal("openai"),
	protocol: Schema.Literals(["responses", "chat-completions"]),
})

export const responsesCapability: Capability<
	"provider.openai.responses",
	"provider",
	"generation"
> = Responses.capability
export const chatCompletionsCapability: Capability<
	"provider.openai.chat-completions",
	"provider",
	"generation"
> = Chat.capability

export type Runtime = Responses.Service | Chat.Service

const invalidDeployment = (message: string, cause?: unknown): ProviderError =>
	ProviderError.make({
		kind: "invalid_request",
		message,
		retryable: false,
		...(cause === undefined ? {} : { cause }),
	})

const deploymentUrl = (
	baseUrl: string | undefined,
	protocol: DeploymentConfig["protocol"],
): Result.Result<URL | undefined, ProviderError> =>
	baseUrl === undefined
		? Result.succeed(undefined)
		: Schema.decodeUnknownResult(Schema.URLFromString)(baseUrl).pipe(
				Result.mapError((cause) =>
					invalidDeployment("OpenAI deployment baseUrl must be an absolute URL", cause),
				),
				Result.map((url) => {
					const path = url.pathname.replace(/\/+$/, "")
					const endpoint = protocol === "responses" ? "responses" : "chat/completions"
					return ["/responses", "/chat/completions"].some((suffix) =>
						path.endsWith(suffix),
					)
						? url
						: Url.setPathname(
								url,
								`${path}${path.endsWith("/v1") ? "" : "/v1"}/${endpoint}`,
							)
				}),
			)

const configError = (cause: unknown): ProviderError =>
	invalidDeployment("Invalid OpenAI deployment configuration", cause)

const resolveApiKey = (
	deployment: DeploymentConfig,
): Effect.Effect<Redacted.Redacted<string>, ProviderError, CredentialResolver> =>
	Effect.gen(function* () {
		if (deployment.credentialRef === undefined)
			return yield* Effect.fail(
				ProviderError.make({
					kind: "unauthorized",
					message: "OpenAI deployment requires credentialRef",
					retryable: false,
				}),
			)
		const resolver = yield* CredentialResolver
		return yield* resolver.resolve(deployment.credentialRef)
	})

const makeResponses = (
	deployment: DeploymentConfig,
): Effect.Effect<Responses.Service, ProviderError, HttpClient.HttpClient | CredentialResolver> =>
	Effect.gen(function* () {
		const key = yield* resolveApiKey(deployment)
		const url = yield* Effect.fromResult(
			deploymentUrl(deployment.baseUrl, deployment.protocol),
		).pipe(Effect.mapError(configError))
		const config = yield* Effect.fromResult(
			Responses.make({
				model: deployment.model,
				apiKey: key,
				...(url === undefined ? {} : { url }),
			}),
		).pipe(Effect.mapError(configError))
		const client = yield* HttpClient.HttpClient
		return Responses.makeService(config, client)
	})

const makeChat = (
	deployment: DeploymentConfig,
): Effect.Effect<Chat.Service, ProviderError, HttpClient.HttpClient | CredentialResolver> =>
	Effect.gen(function* () {
		const key = yield* resolveApiKey(deployment)
		const url = yield* Effect.fromResult(
			deploymentUrl(deployment.baseUrl, deployment.protocol),
		).pipe(Effect.mapError(configError))
		const config = yield* Effect.fromResult(
			Chat.make({
				model: deployment.model,
				apiKey: key,
				...(url === undefined ? {} : { url }),
			}),
		).pipe(Effect.mapError(configError))
		const client = yield* HttpClient.HttpClient
		return Chat.makeService(config, client)
	})

const create = (
	deployment: DeploymentConfig,
): Effect.Effect<Runtime, ProviderError, HttpClient.HttpClient | CredentialResolver> =>
	deployment.protocol === "responses" ? makeResponses(deployment) : makeChat(deployment)

const contractError = (deployment: CoreDeployment, cause: unknown): ProviderContractError =>
	ProviderContractError.make({
		provider: "openai",
		deployment: deployment.id,
		protocol: deployment.protocol,
		message: cause instanceof Error ? cause.message : "Invalid OpenAI deployment",
		...(Schema.isSchemaError(cause) ? { issues: schemaIssues(cause) } : {}),
	})

const issuePath = (path: readonly unknown[] | undefined): readonly (string | number)[] =>
	(path ?? []).map((segment) =>
		typeof segment === "number"
			? segment
			: typeof segment === "string"
				? segment
				: String(segment),
	)

const schemaIssues = (error: Schema.SchemaError) =>
	SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => ({
		path: issuePath(issue.path),
		message: issue.message,
	}))

const EnvironmentSchema = Schema.Struct({
	...DeploymentConfigSchema.fields,
	credentialRef: Schema.NonEmptyString,
	baseUrl: Schema.optional(
		Schema.URLFromString.check(
			Schema.makeFilter<URL>((url) => url.protocol === "http:" || url.protocol === "https:", {
				message: "Expected an HTTP(S) URL",
			}),
		),
	),
})

const validateEnvironment = (input: CoreDeployment): Result.Result<void, ProviderContractError> =>
	Schema.decodeUnknownResult(EnvironmentSchema)(input).pipe(
		Result.mapError((cause) =>
			ProviderContractError.make({
				provider: "openai",
				deployment: input.id,
				protocol: input.protocol,
				message: "Invalid OpenAI deployment configuration",
				issues: schemaIssues(cause),
			}),
		),
		Result.map(() => void 0),
	)

const runtime: RuntimeFactory<HttpClient.HttpClient | CredentialResolver> = (deployment) =>
	Effect.fromResult(Schema.decodeUnknownResult(DeploymentConfigSchema)(deployment)).pipe(
		Effect.mapError((cause) => contractError(deployment, cause)),
		Effect.flatMap((decoded) =>
			create(decoded).pipe(Effect.mapError((cause) => contractError(deployment, cause))),
		),
		Effect.map((service) => ({ generate: service.generate })),
	)

/** OpenAI's generation endpoint matrix. */
export const contract: CoreProviderContract<"openai", HttpClient.HttpClient | CredentialResolver> =
	{
		id: "openai",
		capabilities: [
			{ id: "provider.openai.responses", version: 1 },
			{ id: "provider.openai.chat-completions", version: 1 },
		],
		endpoints: [
			{
				id: "responses",
				parameters: [
					"input",
					"instructions",
					"tools",
					"stream",
					"temperature",
					"top_p",
					"max_output_tokens",
				],
				streaming: true,
				capabilities: ["provider.openai.responses"],
			},
			{
				id: "chat-completions",
				parameters: [
					"input",
					"instructions",
					"tools",
					"stream",
					"temperature",
					"top_p",
					"max_output_tokens",
				],
				streaming: true,
				capabilities: ["provider.openai.chat-completions"],
			},
		],
		protocols: ["responses", "chat-completions"],
		deploymentSchema: DeploymentConfigSchema,
		validateEnvironment,
		runtime,
	}

/** Build a deployment executor while preserving the public model alias in the request. */
export const createForDeployment = (
	deployment: DeploymentConfig,
): Effect.Effect<Runtime, ProviderError, HttpClient.HttpClient | CredentialResolver> =>
	Effect.fromResult(Schema.decodeUnknownResult(DeploymentConfigSchema)(deployment)).pipe(
		Effect.mapError(configError),
		Effect.flatMap(create),
	)

export interface PluginOptions {
	readonly deployments?: readonly DeploymentConfig[]
	readonly modelRoutes?: readonly ModelRouteConfig[]
}

export interface PluginConfig {
	readonly providers: readonly [typeof contract]
	readonly deployments: readonly DeploymentConfig[]
	readonly modelRoutes: readonly ModelRouteConfig[]
}

export interface Plugin extends RouterPlugin.RouterPlugin<
	"openai-provider",
	readonly [typeof responsesCapability, typeof chatCompletionsCapability],
	PluginConfig
> {
	readonly id: "openai-provider"
	readonly capabilities: readonly [typeof responsesCapability, typeof chatCompletionsCapability]
	readonly config: PluginConfig
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** Declare OpenAI without an ingress protocol; credentials remain a host dependency. */
export const plugin = (options: PluginOptions = {}): Plugin => {
	const record = isRecord(options) ? options : undefined
	const deployments =
		record === undefined
			? Array.isArray(options)
				? { options }
				: options
			: record.deployments === undefined
				? []
				: record.deployments
	const modelRoutes = record?.modelRoutes === undefined ? [] : record.modelRoutes
	return RouterPlugin.make({
		id: "openai-provider",
		capabilities: [responsesCapability, chatCompletionsCapability] as const,
		config: {
			providers: [contract] as const,
			deployments: deployments as readonly DeploymentConfig[],
			modelRoutes: modelRoutes as readonly ModelRouteConfig[],
		},
	})
}

export const makePlugin = plugin

/** Structural helper for callers that only need the normalized service type. */
export type GenerationService = {
	readonly generate: (
		request: GenerationRequest,
	) => Effect.Effect<Process<ProviderError>, ProviderError>
}
