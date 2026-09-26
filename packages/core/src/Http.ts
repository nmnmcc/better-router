import type { FileSystem, Layer, Path } from "effect"
import type { Etag, HttpPlatform, HttpRouter } from "effect/unstable/http"
import type { HttpApi } from "effect/unstable/httpapi"
import type { Router } from "./Router.js"

/** Services supplied by the host when serving Effect HTTP routes. */
export type HttpHostServices = HttpRouter.HttpRouter | Etag.Generator | FileSystem.FileSystem | HttpPlatform.HttpPlatform | Path.Path

/** The plugin owns its endpoint definition and the Layer that handles it. */
export interface HttpContribution<Api extends HttpApi.Constraint = HttpApi.Constraint, Requirements = never> {
  readonly api: Api
  /** May also mount raw HTTP routes, such as a WebSocket upgrade. */
  readonly routes: (router: Router) => Layer.Layer<never, never, HttpHostServices | Requirements>
}
