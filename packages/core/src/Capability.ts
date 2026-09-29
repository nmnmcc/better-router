import { Result, Schema } from "effect"
import type { Identifier } from "./Identifier.js"

export const Capability = Schema.Struct({
	id: Schema.NonEmptyString,
	version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	projections: Schema.Array(Schema.NonEmptyString),
})

export type Capability<Id extends string = string, ProjectionId extends string = string> = {
	readonly id: Identifier<Id>
	readonly version: number
	readonly projections: readonly Identifier<ProjectionId>[]
}

export class CapabilityError extends Schema.TaggedError<CapabilityError>()("CapabilityError", {
	id: Schema.String,
	message: Schema.String,
}) {}

/** Reject declarations before any plugin resources are acquired. */
export const parse = (value: unknown): Result.Result<Capability, CapabilityError> =>
	Result.mapError(Schema.decodeUnknownResult(Capability)(value), (cause) =>
		CapabilityError.make({ id: "unknown", message: cause.message }),
	)

/** The core knows the semantic capability, never the protocols that project it. */
export const generation: Capability<"generation", never> = {
	id: "generation",
	version: 1,
	projections: [],
}
