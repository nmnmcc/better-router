import type { Redacted } from "effect"
import type { Plugin as RouterPlugin } from "@better-router/core"
import type {
	HttpContractContribution,
	ModelRouteConfig,
} from "@better-router/core/PluginContributions"
import * as Protocol from "@better-router/protocol-openai-responses"
import * as Provider from "@better-router/provider-openai"
import type { DeploymentConfig } from "@better-router/provider-openai/Deployment"

export type ResponsesDeployment = Omit<DeploymentConfig, "protocol"> & {
	readonly protocol: "responses"
}

export interface Options {
	readonly gatewayKey?: Redacted.Redacted<string>
	/** Static deployments keep model and credential references separate from capability. */
	readonly deployments?: readonly ResponsesDeployment[]
	/** Public aliases and ordered fallback candidates for these deployments. */
	readonly modelRoutes?: readonly ModelRouteConfig[]
}

export interface PluginConfig {
	readonly http: readonly [HttpContractContribution<typeof Protocol.Api.api>]
	readonly projections: readonly [typeof Protocol.projection]
	readonly providers: readonly [typeof Provider.Deployment.contract]
	readonly deployments: readonly ResponsesDeployment[]
	readonly modelRoutes: readonly ModelRouteConfig[]
}

export interface Plugin {
	readonly id: "openai-responses"
	readonly capabilities: readonly [
		typeof Protocol.capability,
		typeof Provider.Deployment.responsesCapability,
	]
	readonly config: PluginConfig
}

/**
 * Declare Responses ingress and independent OpenAI deployments. Credentials
 * and runtime services are resolved by the host when its Router Layer starts.
 */
export const plugin = (options: Options = {}): Plugin =>
	({
		id: "openai-responses",
		capabilities: [Protocol.capability, Provider.Deployment.responsesCapability] as const,
		config: {
			http: [Protocol.makeHttpContribution({ gatewayKey: options.gatewayKey })] as const,
			projections: [Protocol.projection] as const,
			providers: [Provider.Deployment.contract] as const,
			deployments: options.deployments?.map((deployment) => ({ ...deployment })) ?? [],
			modelRoutes: options.modelRoutes ?? [],
		},
	}) satisfies RouterPlugin.RouterPlugin<Plugin["id"], Plugin["capabilities"], PluginConfig>

export const make = plugin
export const makePlugin = plugin
