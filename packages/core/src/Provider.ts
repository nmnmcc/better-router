import { Effect, Schema } from "effect"
import type { GenerationRequest } from "./Generation.js"
import type { Process } from "./GenerationProcess.js"

/** The normalized failure vocabulary shared by concrete provider adapters. */
export class Error extends Schema.TaggedError<Error>()("ProviderError", {
	kind: Schema.Literals([
		"invalid_request",
		"unauthorized",
		"rate_limited",
		"timeout",
		"unavailable",
		"unsupported",
		"unknown",
	]),
	message: Schema.String,
	retryable: Schema.Boolean,
	cause: Schema.optional(Schema.Defect({ excludeCause: true })),
}) {}

export type ProviderError = typeof Error.Type

/** A provider package owns the request codec and returns only semantic events. */
export interface Service<Request = GenerationRequest, R = never> {
	readonly generate: (
		request: Request,
	) => Effect.Effect<Process<ProviderError, R>, ProviderError, R>
}

/** Namespace-shaped core provider contract. Concrete packages expose services of their own. */
export const Provider = {
	Error,
}
