import { Result, Schema } from "effect"
import type { Identifier } from "./Identifier.js"

/** The kind of a capability is descriptive metadata, not an execution hook. */
export const Kind = Schema.Literals(["generation", "provider", "protocol", "routing"] as const)

export type Kind = typeof Kind.Type

/**
 * A capability is the stable, stateless part of a plugin contract.
 *
 * Credentials, model names, Layers and other process state deliberately do not
 * belong here. They are supplied by a plugin's `state` value instead.
 */
export const SchemaDefinition = Schema.Struct({
	id: Schema.NonEmptyString,
	version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	kind: Kind,
	projections: Schema.Array(Schema.NonEmptyString),
})

export interface Capability<
	Id extends string = string,
	CapabilityKind extends Kind = Kind,
	ProjectionId extends string = string,
> {
	readonly id: Identifier<Id>
	readonly version: number
	readonly kind: CapabilityKind
	readonly projections: readonly Identifier<ProjectionId>[]
}

export class Error extends Schema.TaggedError<Error>()("CapabilityError", {
	id: Schema.String,
	message: Schema.String,
}) {}

export type CapabilityError = typeof Error.Type

/** Define a trusted capability descriptor without capturing runtime state. */
export const make = <
	const Id extends string,
	const CapabilityKind extends Kind,
	const ProjectionId extends string = never,
>(definition: {
	readonly id: Id
	readonly version: number
	readonly kind: CapabilityKind
	readonly projections?: readonly ProjectionId[]
}): Capability<Id, CapabilityKind, ProjectionId> => ({
	id: definition.id,
	version: definition.version,
	kind: definition.kind,
	projections: [...(definition.projections ?? [])],
})

/** Decode a capability at extension/plugin boundaries while preserving errors as data. */
export const decode = (value: unknown): Result.Result<Capability, CapabilityError> =>
	Schema.decodeUnknownResult(SchemaDefinition)(value).pipe(
		Result.mapError((cause) => Error.make({ id: "unknown", message: cause.message })),
	)

/** The semantic generation contract is always present in a composed router. */
export const generation = make({
	id: "generation",
	version: 1,
	kind: "generation",
	projections: [],
} as const)
