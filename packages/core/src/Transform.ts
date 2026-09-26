import type { Effect, Stream } from "effect"
import type { InvocationOptions } from "./Deployment.js"
import type { ModelEvent, ModelRequest } from "./Model.js"
import type { RouterError } from "./Router.js"

export type ModelHandler<Requirements = never> = (request: ModelRequest, options?: InvocationOptions) => Effect.Effect<Stream.Stream<ModelEvent, RouterError, Requirements>, RouterError, Requirements>

export interface ModelTransform<Requirements = never> {
  readonly id: string
  /** Declared order is composition order; the first transform is outermost. */
  readonly wrap: <R>(next: ModelHandler<R>) => ModelHandler<R | Requirements>
}
