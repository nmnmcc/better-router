import type { ModelDeployment, ModelExecutor } from "@better-router/core/Deployment"

export interface AnthropicMessagesDeploymentConfig {
  readonly apiKey: string
  readonly baseUrl?: string
}

export interface AnthropicMessagesDeployment<Requirements = never> extends ModelDeployment<Requirements> {
  readonly provider: "anthropic"
  readonly protocol: "anthropic.messages"
  readonly execute: {
    readonly http: ModelExecutor<Requirements>
    readonly websocket?: never
  }
}
