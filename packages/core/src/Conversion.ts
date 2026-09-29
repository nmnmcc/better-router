import { Match, Result, Schema } from "effect"
import type { SchemaIssue } from "effect"

export class ConversionError extends Schema.TaggedError<ConversionError>()("ConversionError", {
	path: Schema.String,
	reason: Schema.Literals(["invalid", "unsupported"]),
	message: Schema.String,
}) {}

export const at = (
	path: string,
	reason: ConversionError["reason"],
	message: string,
): ConversionError => ConversionError.make({ path, reason, message: `${path}: ${message}` })

const segments = (issue: SchemaIssue.Issue): readonly PropertyKey[] =>
	Match.value(issue).pipe(
		Match.tag("Pointer", (value) => [...value.path, ...segments(value.issue)]),
		Match.tag("Filter", (value) => segments(value.issue)),
		Match.tag("Encoding", (value) => segments(value.issue)),
		Match.tag("Composite", "AnyOf", (value) =>
			value.issues
				.map(segments)
				.reduce<readonly PropertyKey[]>(
					(longest, candidate) =>
						candidate.length > longest.length ? candidate : longest,
					[],
				),
		),
		Match.orElse(() => []),
	)

export const fromSchema = (error: Schema.SchemaError, root: string): ConversionError => {
	const path = segments(error.issue).reduce<string>(
		(current, segment) =>
			typeof segment === "number"
				? `${current}[${segment}]`
				: `${current}.${String(segment)}`,
		root,
	)
	return at(path, "invalid", error.message)
}

export const requireThat = (
	condition: boolean,
	path: string,
	reason: ConversionError["reason"],
	message: string,
) => (condition ? Result.void : Result.fail(at(path, reason, message)))
