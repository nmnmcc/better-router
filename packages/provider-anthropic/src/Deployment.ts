import { Effect, Redacted, Result, Schema, SchemaIssue } from "effect"
import { HttpClient, Url } from "effect/http"
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
import * as Messages from "./AnthropicMessages.js"

/** The static part of an Anthropic Messages deployment. */
export interface DeploymentConfig extends CoreDeploymentConfig<
	string,
	"anthropic",
	string,
	"messages"
> {
	readonly defaultMaxTokens?: number | undefined
	readonly version?: string | undefined
}

type CoreDeployment = CoreDeploymentConfig<string, string, string, string>

export const DeploymentConfigSchema = Schema.Struct({
	...CoreDeploymentConfigSchema.fields,
	provider: Schema.Literal("anthropic"),
	protocol: Schema.Literal("messages"),
	defaultMaxTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
	version: Schema.optional(Schema.String),
})

export const messagesCapability: Capability<
	"provider.anthropic.messages",
	"provider",
	"generation"
> = Messages.capability

const invalidDeployment = (message: string, cause?: unknown): ProviderError =>
	ProviderError.make({
		kind: "invalid_request",
		message,
		retryable: false,
		...(cause === undefined ? {} : { cause }),
	})

const deploymentUrl = (
	baseUrl: string | undefined,
): Result.Result<URL | undefined, ProviderError> =>
	baseUrl === undefined
		? Result.succeed(undefined)
		: Schema.decodeUnknownResult(Schema.URLFromString)(baseUrl).pipe(
				Result.mapError((cause) =>
					invalidDeployment(
						"Anthropic deployment baseUrl must be an absolute URL",
						cause,
					),
				),
				Result.map((url) => {
					const path = url.pathname.replace(/\/+$/, "")
					return path.endsWith("/messages")
						? url
						: Url.setPathname(
								url,
								`${path}${path.endsWith("/v1") ? "" : "/v1"}/messages`,
							)
				}),
			)

const configError = (cause: unknown): ProviderError =>
	invalidDeployment("Invalid Anthropic deployment configuration", cause)

const resolveApiKey = (
	deployment: DeploymentConfig,
): Effect.Effect<Redacted.Redacted<string>, ProviderError, CredentialResolver> =>
	Effect.gen(function* () {
		if (deployment.credentialRef === undefined)
			return yield* Effect.fail(
				ProviderError.make({
					kind: "unauthorized",
					message: "Anthropic deployment requires credentialRef",
					retryable: false,
				}),
			)
		const resolver = yield* CredentialResolver
		return yield* resolver.resolve(deployment.credentialRef)
	})

const create = (
	deployment: DeploymentConfig,
): Effect.Effect<Messages.Service, ProviderError, HttpClient.HttpClient | CredentialResolver> =>
	Effect.gen(function* () {
		const key = yield* resolveApiKey(deployment)
		const url = yield* Effect.fromResult(deploymentUrl(deployment.baseUrl)).pipe(
			Effect.mapError(configError),
		)
		const config = yield* Effect.fromResult(
			Messages.make({
				model: deployment.model,
				apiKey: key,
				defaultMaxTokens: deployment.defaultMaxTokens ?? 1024,
				...(url === undefined ? {} : { url }),
				...(deployment.version === undefined ? {} : { version: deployment.version }),
			}),
		).pipe(Effect.mapError(configError))
		const client = yield* HttpClient.HttpClient
		return Messages.makeService(config, client)
	})

const contractError = (deployment: CoreDeployment, cause: unknown): ProviderContractError =>
	ProviderContractError.make({
		provider: "anthropic",
		deployment: deployment.id,
		protocol: deployment.protocol,
		message: cause instanceof Error ? cause.message : "Invalid Anthropic deployment",
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
				provider: "anthropic",
				deployment: input.id,
				protocol: input.protocol,
				message: "Invalid Anthropic deployment configuration",
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

/** Anthropic's generation endpoint matrix. */
export const contract: CoreProviderContract<
	"anthropic",
	HttpClient.HttpClient | CredentialResolver
> = {
	id: "anthropic",
	capabilities: [{ id: "provider.anthropic.messages", version: 1 }],
	endpoints: [
		{
			id: "messages",
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
			capabilities: ["provider.anthropic.messages"],
		},
	],
	protocols: ["messages"],
	deploymentSchema: DeploymentConfigSchema,
	validateEnvironment,
	runtime,
}

/** Create an Anthropic Messages executor bound to one parsed deployment. */
export const createForDeployment = (
	deployment: DeploymentConfig,
): Effect.Effect<Messages.Service, ProviderError, HttpClient.HttpClient | CredentialResolver> =>
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
	"anthropic-provider",
	readonly [typeof messagesCapability],
	PluginConfig
> {
	readonly id: "anthropic-provider"
	readonly capabilities: readonly [typeof messagesCapability]
	readonly config: PluginConfig
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** Declare Anthropic without an ingress protocol; credentials remain a host dependency. */
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
		id: "anthropic-provider",
		capabilities: [messagesCapability] as const,
		config: {
			providers: [contract] as const,
			deployments: deployments as readonly DeploymentConfig[],
			modelRoutes: modelRoutes as readonly ModelRouteConfig[],
		},
	})
}

export const makePlugin = plugin
