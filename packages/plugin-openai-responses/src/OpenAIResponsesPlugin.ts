import type { HttpClient } from "effect/unstable/http"
import type { RouterPlugin } from "@better-router/core/Plugin"
import type { OpenAIResponsesDeployment } from "./OpenAIResponses.js"

export interface OpenAIResponsesPlugin extends RouterPlugin<"openai-responses", HttpClient.HttpClient> {
  readonly deployments: readonly OpenAIResponsesDeployment<HttpClient.HttpClient>[]
}

export interface OpenAIResponsesPluginOptions {
  readonly deployments: OpenAIResponsesPlugin["deployments"]
}

/** Declare only the OpenAI Responses upstream deployments. */
export function make(options: OpenAIResponsesPluginOptions): OpenAIResponsesPlugin {
  return { id: "openai-responses", deployments: options.deployments }
}
