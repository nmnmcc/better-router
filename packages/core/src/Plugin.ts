import { Schema } from "effect"
import type { Effect, Scope } from "effect"
import type { HttpApi } from "effect/unstable/httpapi"
import type { ModelDeployment } from "./Deployment.js"
import type { HttpContribution } from "./Http.js"
import type { Router } from "./Router.js"
import type { RoutingPolicy } from "./Routing.js"
import type { ModelTransform } from "./Transform.js"

export const SetupError = Schema.TaggedUnion({
  DuplicateId: {
    kind: Schema.Literals(["plugin", "deployment", "policy", "transform", "http_group"]),
    id: Schema.String,
  },
  DuplicateHttpRoute: { method: Schema.String, path: Schema.String },
  InvalidRoute: { model: Schema.String, message: Schema.String },
  PluginStartFailed: { plugin: Schema.String, cause: Schema.Defect({ excludeCause: true }) },
})

export type SetupError = typeof SetupError.Type

/** A plugin is a declaration, not a command to register capabilities. */
export interface RouterPlugin<Id extends string = string, Requirements = never, Api extends HttpApi.Constraint = HttpApi.Constraint> {
  readonly id: Id
  readonly deployments?: readonly ModelDeployment<Requirements>[]
  readonly policies?: readonly RoutingPolicy[]
  readonly transforms?: readonly ModelTransform<Requirements>[]
  readonly http?: HttpContribution<Api, Requirements>
  /** Resource acquisition only; capabilities above remain declared statically. */
  readonly start?: (router: Router) => Effect.Effect<void, SetupError, Requirements | Scope.Scope>
}

export type PluginRequirements<Plugin> = Plugin extends RouterPlugin<string, infer Requirements, HttpApi.Constraint> ? Requirements : never
