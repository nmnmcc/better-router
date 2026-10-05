import { Result, Schema, SchemaIssue } from "effect"
import type { Identifier } from "./Identifier.js"

/** The kind of a capability is descriptive metadata, not an execution hook. */
export const Kind = Schema.Literals(["generation", "provider", "protocol", "routing"] as const)

export type Kind = typeof Kind.Type

/**
 * A capability is the stable, stateless part of a plugin contract.
 *
 * Credentials, model names, Layers and other process state deliberately do not
 * belong here. They are supplied by a plugin's configuration and runtime
 * layers instead.
 */
export const Endpoint = Schema.Struct({
	id: Schema.NonEmptyString,
	parameters: Schema.Array(Schema.NonEmptyString),
	streaming: Schema.Boolean,
	/** Stable capability identifiers made available by this endpoint. */
	capabilities: Schema.optional(Schema.Array(Schema.NonEmptyString)),
})

export type Endpoint = typeof Endpoint.Type

export const Issue = Schema.Struct({
	path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
	message: Schema.String,
})

export type Issue = typeof Issue.Type

export const SchemaDefinition = Schema.Struct({
	id: Schema.NonEmptyString,
	version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	kind: Kind,
	projections: Schema.Array(Schema.NonEmptyString),
	endpoints: Schema.optional(Schema.Array(Endpoint)),
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
	readonly endpoints?: readonly Endpoint[] | undefined
}

export class Error extends Schema.TaggedError<Error>()("CapabilityError", {
	id: Schema.String,
	message: Schema.String,
	issues: Schema.optional(Schema.Array(Issue)),
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
	readonly projections?: readonly ProjectionId[] | undefined
	readonly endpoints?: readonly Endpoint[] | undefined
}): Capability<Id, CapabilityKind, ProjectionId> => ({
	id: definition.id,
	version: definition.version,
	kind: definition.kind,
	projections: [...(definition.projections ?? [])],
	...(definition.endpoints === undefined
		? {}
		: {
				endpoints: definition.endpoints.map((endpoint) => ({
					...endpoint,
					parameters: [...endpoint.parameters],
					...(endpoint.capabilities === undefined
						? {}
						: { capabilities: [...endpoint.capabilities] }),
				})),
			}),
})

const issuePath = (path: readonly unknown[] | undefined): readonly (string | number)[] =>
	(path ?? []).map((segment) =>
		typeof segment === "number"
			? segment
			: typeof segment === "string"
				? segment
				: String(segment),
	)

const issuesOf = (error: Schema.SchemaError): readonly Issue[] =>
	SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => ({
		path: issuePath(issue.path),
		message: issue.message,
	}))

/** Decode a capability at extension/plugin boundaries while preserving errors as data. */
export const decode = (value: unknown): Result.Result<Capability, CapabilityError> =>
	Schema.decodeUnknownResult(SchemaDefinition, { onExcessProperty: "error" })(value).pipe(
		Result.map(make),
		Result.mapError((cause) =>
			Error.make({
				id: "unknown",
				message: cause.message,
				issues: issuesOf(cause),
			}),
		),
	)

/** The semantic generation contract is always present in a composed router. */
export const generation = make({
	id: "generation",
	version: 1,
	kind: "generation",
	projections: [],
} as const)
