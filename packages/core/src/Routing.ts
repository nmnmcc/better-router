import { Schema } from "effect"
import type { Effect } from "effect"
import type { DeploymentId, DeploymentRef } from "./Deployment.js"
import type { GenerationRequest, ModelAlias } from "./Generation.js"

export interface ModelRoute {
  readonly model: ModelAlias
  /** Listed order is fallback order when no policy is selected. */
  readonly deployments: readonly DeploymentId[]
  readonly policy?: string
}

export class RoutingError extends Schema.TaggedError<RoutingError>()("RoutingError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect({ excludeCause: true })),
}) {}

export interface RoutingPolicy {
  readonly id: string
  /** Return an ordered subset of candidates; do not introduce new deployments. */
  readonly rank: (request: GenerationRequest, candidates: readonly DeploymentRef[]) => Effect.Effect<readonly DeploymentRef[], RoutingError>
}
