import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import type {
	GenerationEvent,
	GenerationRequest,
	GenerationResponse,
} from "@better-router/core/Generation"
import type { components, operations } from "./OpenResponses.js"
import specification from "./generated/OpenResponsesSchema.json" with { type: "json" }

type Schemas = components["schemas"]
type StandardEvent = operations["createResponse"]["responses"][200]["content"]["text/event-stream"]

const definitions = specification.components.schemas
const compile = (root: JsonSchema.JsonSchema, schemas: Record<string, unknown> = definitions) =>
	SchemaRepresentation.fromJsonSchemaDocument(
		JsonSchema.fromSchemaOpenApi3_1({ ...root, $defs: schemas }),
		{ patterns: "apply" },
	)
const prefix = "^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*$"
const extension = (required: readonly string[]) => ({
	type: "object",
	required,
	additionalProperties: true,
	properties: {
		type: { type: "string", pattern: prefix },
		id: { type: "string" },
		status: { type: "string" },
		sequence_number: { type: "integer", minimum: 0 },
	},
})
const extend = (key: "ItemParam" | "ItemField" | "ResponsesToolParam" | "Tool", name: string) => ({
	...definitions[key],
	oneOf: [...definitions[key].oneOf, { $ref: `#/components/schemas/${name}` }],
})
const extended = {
	...definitions,
	BetterRouterExtensionItem: extension(["type", "id", "status"]),
	BetterRouterExtensionTool: extension(["type"]),
	ItemParam: extend("ItemParam", "BetterRouterExtensionItem"),
	ItemField: extend("ItemField", "BetterRouterExtensionItem"),
	ResponsesToolParam: extend("ResponsesToolParam", "BetterRouterExtensionTool"),
	Tool: extend("Tool", "BetterRouterExtensionTool"),
}
const eventDocument =
	specification.paths["/responses"].post.responses["200"].content["text/event-stream"].schema

/** The pinned Responses wire contract is owned by its protocol plugin. */
export const StandardRequest = Schema.make<Schema.Codec<Schemas["CreateResponseBody"]>>(
	compile(definitions.CreateResponseBody as JsonSchema.JsonSchema).ast,
)
export const StandardResponse = Schema.make<Schema.Codec<Schemas["ResponseResource"]>>(
	compile(definitions.ResponseResource as JsonSchema.JsonSchema).ast,
)
export const StandardEvent = Schema.make<Schema.Codec<StandardEvent>>(
	compile(eventDocument as JsonSchema.JsonSchema).ast,
)
export const Request = Schema.make<Schema.Codec<GenerationRequest>>(
	compile(definitions.CreateResponseBody as JsonSchema.JsonSchema, extended).ast,
)
export const Response = Schema.make<Schema.Codec<GenerationResponse>>(
	compile(definitions.ResponseResource as JsonSchema.JsonSchema, extended).ast,
)
export const Event = Schema.make<Schema.Codec<GenerationEvent>>(
	compile(
		{
			oneOf: [
				...eventDocument.oneOf,
				{ $ref: "#/components/schemas/BetterRouterExtensionEvent" },
			],
		},
		{ ...extended, BetterRouterExtensionEvent: extension(["type", "sequence_number"]) },
	).ast,
)
