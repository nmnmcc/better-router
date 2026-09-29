import { Effect, Result } from "effect"
import type { Identifier } from "./Identifier.js"

/** Ingress owns decoding and encoding; it receives a projection session, never a deployment. */
export interface Ingress<
	Request,
	Response,
	Error,
	Requirements = never,
	Id extends string = string,
> {
	readonly id: Identifier<Id>
	readonly decode: (value: unknown) => Result.Result<Request, Error>
	readonly handle: (request: Request) => Effect.Effect<Response, Error, Requirements>
}
