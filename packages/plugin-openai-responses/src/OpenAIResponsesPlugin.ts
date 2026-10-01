import type { Redacted } from "effect"
import type { HttpClient } from "effect/http"
import type { RouterPlugin } from "@better-router/core/Plugin"
import type { DirectPipelineFor } from "@better-router/core/Pipeline"
import type { OpenAIResponsesDeployment } from "./OpenAIResponses.js"
import * as OpenAIResponsesHttp from "./OpenAIResponsesHttp.js"

type ResponseDeployments = readonly OpenAIResponsesDeployment<HttpClient.HttpClient>[]

export interface OpenAIResponsesPlugin<
	Deployments extends ResponseDeployments = ResponseDeployments,
> extends RouterPlugin<
	"openai-responses",
	HttpClient.HttpClient,
	typeof OpenAIResponsesHttp.api,
	Deployments,
	readonly [],
	readonly DirectPipelineFor<HttpClient.HttpClient, Deployments[number]>[],
	readonly [typeof OpenAIResponsesHttp.projection],
	readonly [],
	readonly []
> {
	readonly deployments?: Deployments
	readonly pipelines?: readonly DirectPipelineFor<HttpClient.HttpClient, Deployments[number]>[]
	readonly projections?: readonly [typeof OpenAIResponsesHttp.projection]
	readonly http?: ReturnType<typeof OpenAIResponsesHttp.make>
}

export interface OpenAIResponsesPluginOptions<
	Deployments extends ResponseDeployments = ResponseDeployments,
> {
	readonly deployments?: Deployments
	readonly gatewayKey?: Redacted.Redacted<string>
}

export function make<const Deployments extends ResponseDeployments = readonly []>(
	options: OpenAIResponsesPluginOptions<Deployments> & { gatewayKey: Redacted.Redacted<string> },
): OpenAIResponsesPlugin<Deployments> & {
	readonly http: ReturnType<typeof OpenAIResponsesHttp.make>
}
export function make<const Deployments extends ResponseDeployments = readonly []>(
	options: OpenAIResponsesPluginOptions<Deployments>,
): OpenAIResponsesPlugin<Deployments>
/** Declare the Responses HTTP ingress, upstream deployments, or both. */
export function make<const Deployments extends ResponseDeployments = readonly []>(
	options: OpenAIResponsesPluginOptions<Deployments>,
): OpenAIResponsesPlugin<Deployments> {
	return {
		id: "openai-responses",
		projections: [OpenAIResponsesHttp.projection],
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
			? { http: OpenAIResponsesHttp.make({ gatewayKey: options.gatewayKey }) }
			: {}),
	}
}
