import type { Redacted } from "effect"
import type { HttpClient } from "effect/http"
import type { RouterPlugin } from "@better-router/core/Plugin"
import type { HttpContribution } from "@better-router/core/Http"
import type { HttpApi } from "effect/http-api"
import type { AnthropicMessagesDeployment } from "./AnthropicMessages.js"
import type { DirectPipelineFor } from "@better-router/core/Pipeline"
import * as AnthropicMessagesHttp from "./AnthropicMessagesHttp.js"

/** May also declare an Anthropic Messages-compatible HttpApi and its handlers. */
export interface AnthropicMessagesPlugin<
	Requirements = never,
	Api extends HttpApi.Constraint = HttpApi.Constraint,
	Deployments extends readonly AnthropicMessagesDeployment<Requirements>[] =
		readonly AnthropicMessagesDeployment<Requirements>[],
> extends RouterPlugin<
	"anthropic-messages",
	Requirements,
	Api,
	Deployments,
	readonly [],
	readonly DirectPipelineFor<Requirements, Deployments[number]>[],
	readonly [typeof AnthropicMessagesHttp.projection],
	readonly [],
	readonly []
> {
	readonly deployments?: Deployments
	readonly pipelines?: readonly DirectPipelineFor<Requirements, Deployments[number]>[]
	readonly projections?: readonly [typeof AnthropicMessagesHttp.projection]
	readonly http?: HttpContribution<Api, Requirements>
}

type AnthropicDeployments = readonly AnthropicMessagesDeployment<HttpClient.HttpClient>[]

export interface AnthropicMessagesPluginOptions<
	Deployments extends AnthropicDeployments = AnthropicDeployments,
> {
	readonly deployments?: Deployments
	readonly gatewayKey?: Redacted.Redacted<string>
}

export function make<const Deployments extends AnthropicDeployments = readonly []>(
	options: AnthropicMessagesPluginOptions<Deployments> & {
		gatewayKey: Redacted.Redacted<string>
	},
): AnthropicMessagesPlugin<HttpClient.HttpClient, typeof AnthropicMessagesHttp.api, Deployments> & {
	readonly http: ReturnType<typeof AnthropicMessagesHttp.make>
}
export function make<const Deployments extends AnthropicDeployments = readonly []>(
	options: AnthropicMessagesPluginOptions<Deployments>,
): AnthropicMessagesPlugin<HttpClient.HttpClient, typeof AnthropicMessagesHttp.api, Deployments>
export function make<const Deployments extends AnthropicDeployments = readonly []>(
	options: AnthropicMessagesPluginOptions<Deployments>,
): AnthropicMessagesPlugin<HttpClient.HttpClient, typeof AnthropicMessagesHttp.api, Deployments> {
	return {
		id: "anthropic-messages",
		projections: [AnthropicMessagesHttp.projection],
		...(options.deployments
			? {
					deployments: options.deployments,
					pipelines: options.deployments.flatMap((deployment: Deployments[number]) =>
						deployment.execute.direct
							? [
									{
										id: `${deployment.id}:direct`,
										deployment: deployment.id,
										source: deployment.protocol,
										target: deployment.protocol,
										execute: deployment.execute.direct,
									},
								]
							: [],
					),
				}
			: {}),
		...(options.gatewayKey
			? { http: AnthropicMessagesHttp.make({ gatewayKey: options.gatewayKey }) }
			: {}),
	}
}
