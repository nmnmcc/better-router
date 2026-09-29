import { Effect, Result } from "effect"

/** Ingress owns decoding and encoding; it receives a projection session, never a deployment. */
export interface Ingress<Request, Response, Error, Requirements = never> {
  readonly id: string
  readonly decode: (value: unknown) => Result.Result<Request, Error>
  readonly handle: (request: Request) => Effect.Effect<Response, Error, Requirements>
}
