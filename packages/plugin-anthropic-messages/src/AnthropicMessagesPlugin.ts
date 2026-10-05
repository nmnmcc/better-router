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
	readonly modelRoutes?: readonly ModelRouteConfig[]
}

export interface PluginConfig {
	readonly http: readonly [HttpContractContribution<typeof Protocol.Api.api>]
	readonly projections: readonly [typeof Protocol.projection]
	readonly providers: readonly [typeof Provider.Deployment.contract]
	readonly deploymentSchema: typeof Provider.Deployment.DeploymentConfigSchema
	readonly deployments: readonly DeploymentConfig[]
	readonly modelRoutes: readonly ModelRouteConfig[]
}

export interface Plugin extends RouterPlugin.RouterPlugin<
	"anthropic-messages",
	readonly [typeof Protocol.capability, typeof Provider.Deployment.messagesCapability],
	PluginConfig
> {
	readonly id: "anthropic-messages"
	readonly capabilities: readonly [
		typeof Protocol.capability,
		typeof Provider.Deployment.messagesCapability,
	]
	readonly config: PluginConfig
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** Declare Messages ingress, deployments, and public model aliases. */
export const plugin = (options: Options = {}): Plugin =>
	((): Plugin => {
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
		return {
			id: "anthropic-messages",
			capabilities: [Protocol.capability, Provider.Deployment.messagesCapability] as const,
			config: {
				http: [
					Protocol.makeHttpContribution({
						gatewayKey: record?.gatewayKey as Options["gatewayKey"],
					}),
				] as const,
				projections: [Protocol.projection] as const,
				providers: [Provider.Deployment.contract] as const,
				deploymentSchema: Provider.Deployment.DeploymentConfigSchema,
				deployments: deployments as PluginConfig["deployments"],
				modelRoutes: modelRoutes as PluginConfig["modelRoutes"],
			},
		} satisfies RouterPlugin.RouterPlugin<Plugin["id"], Plugin["capabilities"], PluginConfig>
	})()

export const make = plugin
export const makePlugin = plugin
