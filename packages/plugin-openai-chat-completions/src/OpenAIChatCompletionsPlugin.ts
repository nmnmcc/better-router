import type { Redacted } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { RouterPlugin } from "@better-router/core/Plugin"
import * as OpenAIChatCompletionsHttp from "./OpenAIChatCompletionsHttp.js"
import type { OpenAIChatCompletionsDeployment } from "./OpenAIChatCompletionsUpstream.js"

export interface OpenAIChatCompletionsPlugin extends RouterPlugin<"openai-chat-completions", HttpClient.HttpClient, typeof OpenAIChatCompletionsHttp.api> {
  readonly http?: ReturnType<typeof OpenAIChatCompletionsHttp.make>
  readonly deployments?: readonly OpenAIChatCompletionsDeployment[]
}

export interface OpenAIChatCompletionsPluginOptions {
  readonly gatewayKey?: Redacted.Redacted<string>
  readonly deployments?: readonly OpenAIChatCompletionsDeployment[]
}

export function make(options: OpenAIChatCompletionsPluginOptions & { gatewayKey: Redacted.Redacted<string> }): OpenAIChatCompletionsPlugin & { readonly http: ReturnType<typeof OpenAIChatCompletionsHttp.make> }
export function make(options: OpenAIChatCompletionsPluginOptions): OpenAIChatCompletionsPlugin
/** Declare the Chat HTTP ingress, upstream deployments, or both. */
export function make(options: OpenAIChatCompletionsPluginOptions): OpenAIChatCompletionsPlugin {
  return {
    id: "openai-chat-completions",
    projections: [OpenAIChatCompletionsHttp.projection],
    ...(options.gatewayKey ? { http: OpenAIChatCompletionsHttp.make({ gatewayKey: options.gatewayKey }) } : {}),
    ...(options.deployments
      ? {
          deployments: options.deployments,
          pipelines: options.deployments.flatMap((deployment) => (deployment.execute.direct ? [{ id: `${deployment.id}:direct`, deployment: deployment.id, source: deployment.protocol, target: deployment.protocol, execute: deployment.execute.direct }] : [])),
        }
      : {}),
  }
}
