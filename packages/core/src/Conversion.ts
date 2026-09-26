import { Result, Schema } from "effect"
import type { SchemaIssue } from "effect"

export const ConversionError = Schema.Struct({
  path: Schema.String,
  reason: Schema.Literals(["invalid", "unsupported"]),
  message: Schema.String,
})
export type ConversionError = typeof ConversionError.Type

export const at = (path: string, reason: ConversionError["reason"], message: string): ConversionError => ConversionError.make({ path, reason, message: `${path}: ${message}` })

const segments = (issue: SchemaIssue.Issue): readonly PropertyKey[] => {
  if (issue._tag === "Pointer") return [...issue.path, ...segments(issue.issue)]
  if (issue._tag === "Filter" || issue._tag === "Encoding") return segments(issue.issue)
  if (issue._tag === "Composite" || issue._tag === "AnyOf") {
    return issue.issues.map(segments).reduce<readonly PropertyKey[]>((longest, candidate) => (candidate.length > longest.length ? candidate : longest), [])
  }
  return []
}

export const fromSchema = (error: Schema.SchemaError, root: string): ConversionError => {
  const path = segments(error.issue).reduce<string>((current, segment) => (typeof segment === "number" ? `${current}[${segment}]` : `${current}.${String(segment)}`), root)
  return at(path, "invalid", error.message)
}

export const requireThat = (condition: boolean, path: string, reason: ConversionError["reason"], message: string) => (condition ? Result.void : Result.fail(at(path, reason, message)))
