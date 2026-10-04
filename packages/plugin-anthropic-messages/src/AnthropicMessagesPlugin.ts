import type { Redacted } from "effect"
import type { Plugin as RouterPlugin } from "@better-router/core"
import type {
	HttpContractContribution,
	ModelRouteConfig,
} from "@better-router/core/PluginContributions"
import * as Protocol from "@better-router/protocol-anthropic-messages"
import * as Provider from "@better-router/provider-anthropic"
import type { DeploymentConfig } from "@better-router/provider-anthropic/Deployment"

export interface Options {
	readonly gatewayKey?: Redacted.Redacted<string>
	/** Static deployments keep model and credential references separate from capability. */
	readonly deployments?: readonly DeploymentConfig[]
	/** Public aliases and ordered fallback candidates for these deployments. */
	readonly routes?: readonly ModelRouteConfig[]
}

export interface PluginConfig {
	readonly http: readonly [HttpContractContribution<typeof Protocol.Api.api>]
	readonly projections: readonly [typeof Protocol.projection]
	readonly providers: readonly [typeof Provider.Deployment.contract]
	readonly deployments: readonly DeploymentConfig[]
	readonly routes: readonly ModelRouteConfig[]
}

export interface Plugin {
	readonly id: "anthropic-messages"
	readonly capabilities: readonly [
		typeof Protocol.capability,
		typeof Provider.Deployment.messagesCapability,
	]
	readonly config: PluginConfig
}

/** Declare Messages ingress, deployments, and public model aliases. */
export const plugin = (options: Options = {}): Plugin =>
	({
		id: "anthropic-messages",
		capabilities: [Protocol.capability, Provider.Deployment.messagesCapability] as const,
		config: {
			http: [Protocol.makeHttpContribution({ gatewayKey: options.gatewayKey })] as const,
			projections: [Protocol.projection] as const,
			providers: [Provider.Deployment.contract] as const,
			deployments: options.deployments?.map((deployment) => ({ ...deployment })) ?? [],
			routes: options.routes ?? [],
		},
	}) satisfies RouterPlugin.RouterPlugin<Plugin["id"], Plugin["capabilities"], PluginConfig>

export const make = plugin
export const makePlugin = plugin
