import type { Redacted } from "effect"
import type { HttpClient } from "effect/http"
import type { RouterPlugin } from "@better-router/core/Plugin"
import type { DirectPipelineFor } from "@better-router/core/Pipeline"
import * as OpenAIChatCompletionsHttp from "./OpenAIChatCompletionsHttp.js"
import type { OpenAIChatCompletionsDeployment } from "./OpenAIChatCompletionsUpstream.js"

type ChatDeployments = readonly OpenAIChatCompletionsDeployment[]

export interface OpenAIChatCompletionsPlugin<
	Deployments extends ChatDeployments = ChatDeployments,
> extends RouterPlugin<
	"openai-chat-completions",
	HttpClient.HttpClient,
	typeof OpenAIChatCompletionsHttp.api,
	Deployments,
	readonly [],
	readonly DirectPipelineFor<HttpClient.HttpClient, Deployments[number]>[],
	readonly [typeof OpenAIChatCompletionsHttp.projection],
	readonly [],
	readonly []
> {
	readonly http?: ReturnType<typeof OpenAIChatCompletionsHttp.make>
	readonly deployments?: Deployments
	readonly pipelines?: readonly DirectPipelineFor<HttpClient.HttpClient, Deployments[number]>[]
	readonly projections?: readonly [typeof OpenAIChatCompletionsHttp.projection]
}

export interface OpenAIChatCompletionsPluginOptions<
	Deployments extends ChatDeployments = ChatDeployments,
> {
	readonly gatewayKey?: Redacted.Redacted<string>
	readonly deployments?: Deployments
}

export function make<const Deployments extends ChatDeployments = readonly []>(
	options: OpenAIChatCompletionsPluginOptions<Deployments> & {
		gatewayKey: Redacted.Redacted<string>
	},
): OpenAIChatCompletionsPlugin<Deployments> & {
	readonly http: ReturnType<typeof OpenAIChatCompletionsHttp.make>
}
export function make<const Deployments extends ChatDeployments = readonly []>(
	options: OpenAIChatCompletionsPluginOptions<Deployments>,
): OpenAIChatCompletionsPlugin<Deployments>
/** Declare the Chat HTTP ingress, upstream deployments, or both. */
export function make<const Deployments extends ChatDeployments = readonly []>(
	options: OpenAIChatCompletionsPluginOptions<Deployments>,
): OpenAIChatCompletionsPlugin<Deployments> {
	return {
		id: "openai-chat-completions",
		projections: [OpenAIChatCompletionsHttp.projection],
		...(options.gatewayKey
			? { http: OpenAIChatCompletionsHttp.make({ gatewayKey: options.gatewayKey }) }
			: {}),
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
	}
}
