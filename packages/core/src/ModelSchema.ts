import { JsonSchema, Schema, SchemaRepresentation } from "effect"
import type { components, operations } from "./OpenResponses.js"
import type { ModelEvent, ModelRequest, ModelResponse } from "./Model.js"
import specification from "./generated/OpenResponsesSchema.json" with { type: "json" }

type Schemas = components["schemas"]
type StandardEvent = operations["createResponse"]["responses"][200]["content"]["text/event-stream"]

const definitions = specification.components.schemas
const compile = (root: JsonSchema.JsonSchema, schemas: Record<string, unknown> = definitions) => SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaOpenApi3_1({ ...root, $defs: schemas }), { patterns: "apply" })

const prefix = "^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*$"
const extensionType = { type: "string", pattern: prefix }
const extension = (required: readonly string[]) => ({
  type: "object",
  required,
  additionalProperties: true,
  properties: { type: extensionType, id: { type: "string" }, status: { type: "string" }, sequence_number: { type: "integer", minimum: 0 } },
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
const eventDocument = specification.paths["/responses"].post.responses["200"].content["text/event-stream"].schema

// Both type declarations and these runtime schemas come from the pinned document.
export const StandardRequest = Schema.make<Schema.Codec<Schemas["CreateResponseBody"]>>(compile(definitions.CreateResponseBody as JsonSchema.JsonSchema).ast)
export const StandardResponse = Schema.make<Schema.Codec<Schemas["ResponseResource"]>>(compile(definitions.ResponseResource as JsonSchema.JsonSchema).ast)
export const StandardEvent = Schema.make<Schema.Codec<StandardEvent>>(compile(eventDocument as JsonSchema.JsonSchema).ast)

export const Request = Schema.make<Schema.Codec<ModelRequest>>(compile(definitions.CreateResponseBody as JsonSchema.JsonSchema, extended).ast)
export const Response = Schema.make<Schema.Codec<ModelResponse>>(compile(definitions.ResponseResource as JsonSchema.JsonSchema, extended).ast)
export const Event = Schema.make<Schema.Codec<ModelEvent>>(
  compile(
    { oneOf: [...eventDocument.oneOf, { $ref: "#/components/schemas/BetterRouterExtensionEvent" }] },
    {
      ...extended,
      BetterRouterExtensionEvent: extension(["type", "sequence_number"]),
    },
  ).ast,
)

export const ExtensionItem = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*$/))),
    id: Schema.String,
    status: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)

export const ExtensionEvent = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*$/))),
    sequence_number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  [Schema.Record(Schema.String, Schema.Json)],
)

export const ExtensionTool = Schema.StructWithRest(Schema.Struct({ type: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*$/))) }), [Schema.Record(Schema.String, Schema.Json)])
