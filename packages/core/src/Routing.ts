import { Schema } from "effect"
import type { Effect } from "effect"
import type { DeploymentId, DeploymentRef } from "./Deployment.js"
import type { ModelName, ModelRequest } from "./Model.js"

export interface ModelRoute {
  readonly model: ModelName
  /** Listed order is fallback order when no policy is selected. */
  readonly deployments: readonly DeploymentId[]
  readonly policy?: string
}

export const RoutingError = Schema.Struct({
  message: Schema.String,
  cause: Schema.optional(Schema.Defect({ excludeCause: true })),
})

export type RoutingError = typeof RoutingError.Type

export interface RoutingPolicy {
  readonly id: string
  /** Return an ordered subset of candidates; do not introduce new deployments. */
  readonly rank: (request: ModelRequest, candidates: readonly DeploymentRef[]) => Effect.Effect<readonly DeploymentRef[], RoutingError>
}
