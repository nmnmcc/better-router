import { Schema } from "effect"
import type { Effect, Scope } from "effect"
import type { HttpApi } from "effect/unstable/httpapi"
import type { Capability } from "./Capability.js"
import type { Deployment } from "./Deployment.js"
import type { HttpContribution } from "./Http.js"
import type { Router } from "./Router.js"
import type { RoutingPolicy } from "./Routing.js"
import type { DirectPipeline, Middleware } from "./Pipeline.js"
import type { ProtocolDefinition } from "./Projection.js"

class DuplicateId extends Schema.TaggedError<DuplicateId>()("DuplicateId", {
  kind: Schema.Literals(["plugin", "capability", "deployment", "pipeline", "projection", "policy", "middleware", "http_group"]),
  id: Schema.String,
}) {}

class DuplicateHttpRoute extends Schema.TaggedError<DuplicateHttpRoute>()("DuplicateHttpRoute", {
  method: Schema.String,
  path: Schema.String,
}) {}

class InvalidRoute extends Schema.TaggedError<InvalidRoute>()("InvalidRoute", {
  model: Schema.String,
  message: Schema.String,
}) {}

class PluginStartFailed extends Schema.TaggedError<PluginStartFailed>()("PluginStartFailed", {
  plugin: Schema.String,
  cause: Schema.Defect({ excludeCause: true }),
}) {}

export const SetupError = Schema.Union([DuplicateId, DuplicateHttpRoute, InvalidRoute, PluginStartFailed]).pipe(Schema.toTaggedUnion("_tag"))

export type SetupError = typeof SetupError.Type

/** A plugin is a declaration, not a command to register capabilities. */
export interface RouterPlugin<Id extends string = string, Requirements = never, Api extends HttpApi.Constraint = HttpApi.Constraint> {
  readonly id: Id
  /** Capabilities are registered before projections and resource acquisition. */
  readonly capabilities?: readonly Capability[]
  readonly deployments?: readonly Deployment<Requirements>[]
  readonly policies?: readonly RoutingPolicy[]
  readonly middleware?: readonly Middleware<Requirements>[]
  readonly pipelines?: readonly DirectPipeline<Requirements>[]
  readonly projections?: readonly ProtocolDefinition[]
  readonly http?: HttpContribution<Api, Requirements>
  /** Resource acquisition only; capabilities above remain declared statically. */
  readonly start?: (router: Router) => Effect.Effect<void, SetupError, Requirements | Scope.Scope>
}

export type PluginRequirements<Plugin> = Plugin extends RouterPlugin<string, infer Requirements, HttpApi.Constraint> ? Requirements : never
