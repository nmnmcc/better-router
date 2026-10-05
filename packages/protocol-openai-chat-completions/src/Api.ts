import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"

export const Error = Schema.Struct({
	error: Schema.Struct({
		message: Schema.String,
		type: Schema.String,
		param: Schema.optional(Schema.String),
	}),
})

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const
const imageUrl = Schema.Struct({
	url: Schema.optional(Schema.String),
	detail: Schema.optional(Schema.Literals(["auto", "low", "high"] as const)),
})
const contentPart = Schema.Struct({
	type: Schema.String,
	text: Schema.optional(Schema.String),
	image_url: Schema.optional(imageUrl),
})
const toolCall = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	function: Schema.Struct({
		name: Schema.optional(Schema.String),
		arguments: Schema.optional(Schema.String),
	}),
})
const message = Schema.Struct({
	role: Schema.String,
	content: Schema.optional(
		Schema.NullOr(Schema.Union([Schema.String, Schema.Array(contentPart)])),
	),
	tool_calls: Schema.optional(Schema.Array(toolCall)),
	tool_call_id: Schema.optional(Schema.String),
})
const tool = Schema.Struct({
	type: Schema.String,
	function: Schema.Struct({
		name: Schema.String,
		description: Schema.optional(Schema.String),
		parameters: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
		strict: Schema.optional(Schema.Boolean),
	}),
})
const toolChoice = Schema.Union([
	Schema.Literals(["none", "auto", "required"] as const),
	Schema.Struct({
		type: Schema.String,
		function: Schema.Struct({ name: Schema.String }),
	}),
])
const responseFormat = Schema.Struct({
	type: Schema.String,
	json_schema: Schema.optional(
		Schema.Struct({
			name: Schema.String,
			description: Schema.optional(Schema.String),
			schema: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
			strict: Schema.optional(Schema.Boolean),
		}),
	),
})

export const Request = Schema.StructWithRest(
	Schema.Struct({
		model: Schema.NonEmptyString,
		messages: Schema.Array(message),
		tools: Schema.optional(Schema.Array(tool)),
		tool_choice: Schema.optional(toolChoice),
		response_format: Schema.optional(responseFormat),
		max_completion_tokens: Schema.optional(Schema.Number),
		max_tokens: Schema.optional(Schema.Number),
		temperature: Schema.optional(Schema.Number),
		top_p: Schema.optional(Schema.Number),
		presence_penalty: Schema.optional(Schema.Number),
		frequency_penalty: Schema.optional(Schema.Number),
		parallel_tool_calls: Schema.optional(Schema.Boolean),
		stream: Schema.optional(Schema.Boolean),
		stream_options: Schema.optional(
			Schema.Struct({
				include_usage: Schema.optional(Schema.Boolean),
				include_obfuscation: Schema.optional(Schema.Boolean),
			}),
		),
		store: Schema.optional(Schema.Boolean),
		metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	}),
	rest,
)

export const Response = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		object: Schema.Literal("chat.completion"),
		created: Schema.Number,
		model: Schema.String,
		choices: Schema.Array(Schema.Unknown),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)] as const,
)

export const api = HttpApi.make("openai-chat-completions").add(
	HttpApiGroup.make("openAIChatCompletions").add(
		HttpApiEndpoint.post("create", "/v1/chat/completions", {
			payload: Request,
			success: [
				Response,
				HttpApiSchema.StreamUint8Array({ contentType: "text/event-stream; charset=utf-8" }),
			],
			error: [400, 401, 403, 404, 413, 422, 429, 500, 502, 503, 504].map((status) =>
				Error.pipe(HttpApiSchema.status(status)),
			),
		}),
	),
)
