import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const
const Content = Schema.StructWithRest(
	Schema.Struct({
		type: Schema.String,
		text: Schema.optional(Schema.String),
		id: Schema.optional(Schema.String),
		name: Schema.optional(Schema.String),
		input: Schema.optional(Schema.Unknown),
		tool_use_id: Schema.optional(Schema.String),
		content: Schema.optional(Schema.Unknown),
		source: Schema.optional(Schema.Unknown),
	}),
	rest,
)
const Message = Schema.StructWithRest(
	Schema.Struct({
		role: Schema.String,
		content: Schema.Union([Schema.String, Schema.Array(Content)]),
	}),
	rest,
)
const Tool = Schema.StructWithRest(
	Schema.Struct({
		name: Schema.String,
		description: Schema.optional(Schema.String),
		input_schema: Schema.Record(Schema.String, Schema.Json),
	}),
	rest,
)
const ToolChoice = Schema.StructWithRest(
	Schema.Struct({
		type: Schema.String,
		name: Schema.optional(Schema.String),
		disable_parallel_tool_use: Schema.optional(Schema.Boolean),
	}),
	rest,
)
const OutputConfig = Schema.StructWithRest(
	Schema.Struct({
		format: Schema.StructWithRest(
			Schema.Struct({
				type: Schema.String,
				schema: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
			}),
			rest,
		),
	}),
	rest,
)

export const Error = Schema.Struct({
	type: Schema.Literal("error"),
	error: Schema.Struct({ type: Schema.String, message: Schema.String }),
})

export const Request = Schema.StructWithRest(
	Schema.Struct({
		model: Schema.NonEmptyString,
		messages: Schema.Array(Message),
		max_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
		system: Schema.optional(Schema.Union([Schema.String, Schema.Null, Schema.Array(Content)])),
		stream: Schema.optional(Schema.Boolean),
		tools: Schema.optional(Schema.Array(Tool)),
		tool_choice: Schema.optional(ToolChoice),
		output_config: Schema.optional(OutputConfig),
		temperature: Schema.optional(Schema.Number),
		top_p: Schema.optional(Schema.Number),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)] as const,
)

export const api = HttpApi.make("anthropic-messages").add(
	HttpApiGroup.make("anthropicMessages").add(
		HttpApiEndpoint.post("create", "/v1/messages", {
			payload: Request,
			success: [
				Schema.Unknown,
				HttpApiSchema.StreamUint8Array({ contentType: "text/event-stream; charset=utf-8" }),
			],
			error: [400, 401, 404, 422, 429, 500, 502, 503, 504].map((status) =>
				Error.pipe(HttpApiSchema.status(status)),
			),
		}),
	),
)
