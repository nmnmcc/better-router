import type { RouterPlugin } from "@better-router/core/Plugin"
import type { HttpApi } from "effect/unstable/httpapi"
import type { AnthropicMessagesDeployment } from "./AnthropicMessages.js"

/** May also declare an Anthropic Messages-compatible HttpApi and its handlers. */
export interface AnthropicMessagesPlugin<
  Requirements = never,
  Api extends HttpApi.Constraint = HttpApi.Constraint,
> extends RouterPlugin<"anthropic-messages", Requirements, Api> {
  readonly deployments?: readonly AnthropicMessagesDeployment<Requirements>[]
}
