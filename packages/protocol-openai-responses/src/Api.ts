import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api"
import * as ResponsesSchema from "./OpenAIResponsesSchema.js"

export const Error = Schema.Struct({
	error: Schema.Struct({
		message: Schema.String,
		type: Schema.String,
		param: Schema.optional(Schema.String),
	}),
})

export const api = HttpApi.make("openai-responses").add(
	HttpApiGroup.make("openAIResponses").add(
		HttpApiEndpoint.post("create", "/v1/responses", {
			payload: ResponsesSchema.Request,
			success: [
				ResponsesSchema.Response,
				HttpApiSchema.StreamUint8Array({ contentType: "text/event-stream; charset=utf-8" }),
			],
			error: [400, 401, 403, 404, 413, 422, 429, 500, 502, 503, 504].map((status) =>
				Error.pipe(HttpApiSchema.status(status)),
			),
		}),
	),
)

/** The Responses wire contract is the public semantic generation contract. */
export const Request = ResponsesSchema.Request
export const Response = ResponsesSchema.Response
export const Event = ResponsesSchema.Event
