import type { Redacted } from "effect"
import type { Plugin as RouterPlugin } from "@better-router/core"
import type {
	HttpContractContribution,
	ModelRouteConfig,
} from "@better-router/core/PluginContributions"
import * as Protocol from "@better-router/protocol-openai-chat-completions"
import * as Provider from "@better-router/provider-openai"
import type { DeploymentConfig } from "@better-router/provider-openai/Deployment"

export type ChatDeployment = Omit<DeploymentConfig, "protocol"> & {
	readonly protocol: "chat-completions"
}

export interface Options {
	readonly gatewayKey?: Redacted.Redacted<string>
	/** Static deployments keep model and credential references separate from capability. */
	readonly deployments?: readonly ChatDeployment[]
	/** Public aliases and ordered fallback candidates for these deployments. */
	readonly modelRoutes?: readonly ModelRouteConfig[]
}

export interface PluginConfig {
	readonly http: readonly [HttpContractContribution<typeof Protocol.Api.api>]
	readonly projections: readonly [typeof Protocol.projection]
	readonly providers: readonly [typeof Provider.Deployment.contract]
	readonly deployments: readonly ChatDeployment[]
	readonly modelRoutes: readonly ModelRouteConfig[]
}

export interface Plugin {
	readonly id: "openai-chat-completions"
	readonly capabilities: readonly [
		typeof Protocol.capability,
		typeof Provider.Deployment.chatCompletionsCapability,
	]
	readonly config: PluginConfig
}

/** Declare Chat Completions ingress, deployments, and public model aliases. */
export const plugin = (options: Options = {}): Plugin =>
	({
		id: "openai-chat-completions",
		capabilities: [Protocol.capability, Provider.Deployment.chatCompletionsCapability] as const,
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
