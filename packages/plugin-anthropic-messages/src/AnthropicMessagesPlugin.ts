import type { Redacted } from "effect"
import type { HttpClient } from "effect/unstable/http"
import type { RouterPlugin } from "@better-router/core/Plugin"
import type { HttpContribution } from "@better-router/core/Http"
import type { HttpApi } from "effect/unstable/httpapi"
import type { AnthropicMessagesDeployment } from "./AnthropicMessages.js"
import * as AnthropicMessagesHttp from "./AnthropicMessagesHttp.js"

/** May also declare an Anthropic Messages-compatible HttpApi and its handlers. */
export interface AnthropicMessagesPlugin<Requirements = never, Api extends HttpApi.Constraint = HttpApi.Constraint> extends RouterPlugin<"anthropic-messages", Requirements, Api> {
  readonly deployments?: readonly AnthropicMessagesDeployment<Requirements>[]
  readonly http?: HttpContribution<Api, Requirements>
}

export interface AnthropicMessagesPluginOptions {
  readonly deployments?: readonly AnthropicMessagesDeployment<HttpClient.HttpClient>[]
  readonly gatewayKey?: Redacted.Redacted<string>
}

export function make(options: AnthropicMessagesPluginOptions & { gatewayKey: Redacted.Redacted<string> }): AnthropicMessagesPlugin<HttpClient.HttpClient, typeof AnthropicMessagesHttp.api> & { readonly http: ReturnType<typeof AnthropicMessagesHttp.make> }
export function make(options: AnthropicMessagesPluginOptions): AnthropicMessagesPlugin<HttpClient.HttpClient, typeof AnthropicMessagesHttp.api>
export function make(options: AnthropicMessagesPluginOptions): AnthropicMessagesPlugin<HttpClient.HttpClient, typeof AnthropicMessagesHttp.api> {
  return { id: "anthropic-messages", ...(options.deployments ? { deployments: options.deployments } : {}), ...(options.gatewayKey ? { http: AnthropicMessagesHttp.make({ gatewayKey: options.gatewayKey }) } : {}) }
}
