import { Schema } from "effect"
import type { Effect, Stream } from "effect"
import type { ModelEvent, ModelRequest } from "./Model.js"

export type ProviderId = string
export type DeploymentId = string
export type UpstreamTransport = "http" | "websocket"

/** Ingress transport does not select the upstream transport. */
export interface InvocationOptions {
  readonly upstream?: {
    readonly transport: UpstreamTransport
    readonly mode: "prefer" | "require"
  }
}

export interface DeploymentRef {
  readonly id: DeploymentId
  readonly provider: ProviderId
  readonly model: string
}

export const ProviderError = Schema.Struct({
  kind: Schema.Literals(["invalid_request", "unauthorized", "rate_limited", "timeout", "unavailable", "unsupported", "unknown"]),
  message: Schema.String,
  retryable: Schema.Boolean,
  cause: Schema.optional(Schema.Defect({ excludeCause: true })),
})

export type ProviderError = typeof ProviderError.Type

export type ModelExecutor<Requirements = never> = (request: ModelRequest) => Effect.Effect<Stream.Stream<ModelEvent, ProviderError, Requirements>, ProviderError, Requirements>

/** At least one executable upstream transport must be present. */
export type UpstreamExecutors<Requirements = never> = { readonly http: ModelExecutor<Requirements>; readonly websocket?: ModelExecutor<Requirements> } | { readonly http?: ModelExecutor<Requirements>; readonly websocket: ModelExecutor<Requirements> }

/** A deployment binds its private provider configuration to executable paths. */
export interface ModelDeployment<Requirements = never> extends DeploymentRef {
  readonly protocol: string
  readonly execute: UpstreamExecutors<Requirements>
}
