import type { Redacted } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { RouterPlugin } from "@better-router/core/Plugin"
import type { OpenAIResponsesDeployment } from "./OpenAIResponses.js"
import * as OpenAIResponsesHttp from "./OpenAIResponsesHttp.js"

export interface OpenAIResponsesPlugin extends RouterPlugin<"openai-responses", HttpClient.HttpClient, typeof OpenAIResponsesHttp.api> {
  readonly deployments?: readonly OpenAIResponsesDeployment<HttpClient.HttpClient>[]
  readonly http?: ReturnType<typeof OpenAIResponsesHttp.make>
}

export interface OpenAIResponsesPluginOptions {
  readonly deployments?: NonNullable<OpenAIResponsesPlugin["deployments"]>
  readonly gatewayKey?: Redacted.Redacted<string>
}

export function make(options: OpenAIResponsesPluginOptions & { gatewayKey: Redacted.Redacted<string> }): OpenAIResponsesPlugin & { readonly http: ReturnType<typeof OpenAIResponsesHttp.make> }
export function make(options: OpenAIResponsesPluginOptions): OpenAIResponsesPlugin
/** Declare the Responses HTTP ingress, upstream deployments, or both. */
export function make(options: OpenAIResponsesPluginOptions): OpenAIResponsesPlugin {
  return {
    id: "openai-responses",
    projections: [OpenAIResponsesHttp.projection],
    ...(options.deployments
      ? {
          deployments: options.deployments,
          pipelines: options.deployments.flatMap((deployment) => (deployment.execute.direct ? [{ id: `${deployment.id}:direct`, deployment: deployment.id, source: deployment.protocol, target: deployment.protocol, execute: deployment.execute.direct }] : [])),
        }
      : {}),
    ...(options.gatewayKey ? { http: OpenAIResponsesHttp.make({ gatewayKey: options.gatewayKey }) } : {}),
  }
}
