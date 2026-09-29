import { Schema } from "effect"
import type { Effect, Stream } from "effect"
import type { GenerationEvent, GenerationRequest } from "./Generation.js"

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

export class ProviderError extends Schema.TaggedError<ProviderError>()("ProviderError", {
  kind: Schema.Literals(["invalid_request", "unauthorized", "rate_limited", "timeout", "unavailable", "unsupported", "unknown"]),
  message: Schema.String,
  retryable: Schema.Boolean,
  cause: Schema.optional(Schema.Defect({ excludeCause: true })),
}) {}

export type GenerationExecutor<Requirements = never> = (request: GenerationRequest) => Effect.Effect<Stream.Stream<GenerationEvent, ProviderError, Requirements>, ProviderError, Requirements>

/** At least one executable upstream transport must be present. */
export type GenerationExecutors<Requirements = never> = { readonly http: GenerationExecutor<Requirements>; readonly websocket?: GenerationExecutor<Requirements> } | { readonly http?: GenerationExecutor<Requirements>; readonly websocket: GenerationExecutor<Requirements> }

/** A deployment binds its private provider configuration to executable paths. */
export interface Deployment<Requirements = never> extends DeploymentRef {
  readonly protocol: string
  readonly execute: GenerationExecutors<Requirements>
}
