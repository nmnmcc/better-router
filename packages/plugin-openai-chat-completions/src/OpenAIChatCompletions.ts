import { Match, Result, Schema } from "effect"
import { ConversionError, at, fromSchema, requireThat } from "@better-router/core/Conversion"
import type {
	GenerationInputItem,
	GenerationRequest,
	GenerationTool,
	MessageContentPart,
} from "@better-router/core/Generation"

export { make, toChatRequest } from "./OpenAIChatCompletionsUpstream.js"
export type {
	OpenAIChatCompletionsDeployment,
	OpenAIChatCompletionsDeploymentConfig,
} from "./OpenAIChatCompletionsUpstream.js"

export const OpenAIChatCompletionsConversionError = ConversionError
export type OpenAIChatCompletionsConversionError = ConversionError

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const
const textPart = Schema.StructWithRest(
	Schema.Struct({
		type: Schema.String,
		text: Schema.optional(Schema.String),
		image_url: Schema.optional(
			Schema.StructWithRest(
				Schema.Struct({
					url: Schema.optional(Schema.String),
					detail: Schema.optional(Schema.Literals(["auto", "low", "high"])),
				}),
				rest,
			),
		),
	}),
	rest,
)
const call = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		type: Schema.String,
		function: Schema.StructWithRest(
			Schema.Struct({
				name: Schema.optional(Schema.String),
				arguments: Schema.optional(Schema.String),
			}),
			rest,
		),
	}),
	rest,
)
const message = Schema.StructWithRest(
	Schema.Struct({
		role: Schema.String,
		content: Schema.optional(
			Schema.Union([Schema.String, Schema.Null, Schema.Array(textPart)]),
		),
		tool_calls: Schema.optional(Schema.Array(call)),
		tool_call_id: Schema.optional(Schema.String),
	}),
	rest,
)
const tool = Schema.StructWithRest(
	Schema.Struct({
		type: Schema.String,
		function: Schema.StructWithRest(
			Schema.Struct({
				name: Schema.optional(Schema.String),
				description: Schema.optional(Schema.String),
				parameters: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
				strict: Schema.optional(Schema.Boolean),
			}),
			rest,
		),
	}),
	rest,
)
const choice = Schema.Union([
	Schema.Literals(["auto", "none", "required"]),
	Schema.StructWithRest(
		Schema.Struct({
			type: Schema.String,
			function: Schema.StructWithRest(Schema.Struct({ name: Schema.String }), rest),
		}),
		rest,
	),
])
const responseFormat = Schema.StructWithRest(
	Schema.Struct({
		type: Schema.String,
		json_schema: Schema.optional(
			Schema.StructWithRest(
				Schema.Struct({
					name: Schema.String,
					description: Schema.optional(Schema.String),
					schema: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
					strict: Schema.optional(Schema.Boolean),
				}),
				rest,
			),
		),
	}),
	rest,
)

export const ChatRequest = Schema.StructWithRest(
	Schema.Struct({
		model: Schema.String,
		messages: Schema.Array(message),
		tools: Schema.optional(Schema.Array(tool)),
		tool_choice: Schema.optional(choice),
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
			Schema.StructWithRest(
				Schema.Struct({
					include_usage: Schema.optional(Schema.Boolean),
					include_obfuscation: Schema.optional(Schema.Boolean),
				}),
				rest,
			),
		),
		store: Schema.optional(Schema.Boolean),
		metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
		n: Schema.optional(Schema.Number),
	}),
	rest,
)

type Native = typeof ChatRequest.Type
type Part = {
	readonly type: string
	readonly text?: string
	readonly image_url?: {
		readonly url?: string
		readonly detail?: "auto" | "low" | "high"
	}
}
type Message = typeof message.Type

export type OpenAIChatCompletionsRequest = {
	readonly request: GenerationRequest
	readonly ingress: {
		readonly stream: boolean
		readonly hasStreamOptions: boolean
		readonly includeUsage: boolean
	}
}

export const decodeRequest = (value: unknown): Result.Result<Native, ConversionError> =>
	Result.mapError(Schema.decodeUnknownResult(ChatRequest)(value), (error) =>
		fromSchema(error, "request"),
	)

/** Decode only the model selector for a native pass-through attempt. */
export const toNativeRequest = (
	value: unknown,
): Result.Result<{ readonly model: string; readonly stream?: boolean }, ConversionError> =>
	Result.map(decodeRequest(value), ({ model, stream }) => ({
		model,
		...(stream === undefined ? {} : { stream }),
	}))

const only = (
	value: object,
	path: string,
	keys: readonly string[],
): Result.Result<void, ConversionError> => {
	const extra = Object.keys(value).find((key) => !keys.includes(key))
	return extra
		? Result.fail(at(`${path}.${extra}`, "unsupported", "no OpenResponses mapping"))
		: Result.void
}

const imageUrl = (url: string | undefined, path: string): Result.Result<string, ConversionError> =>
	url === undefined
		? Result.fail(at(path, "invalid", "expected an image URL"))
		: /^https?:\/\/\S+$/.test(url) ||
			  /^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/.test(url)
			? Result.succeed(url)
			: Result.fail(at(path, "unsupported", "only URL and base64 image data are portable"))

function parts(
	content: readonly Part[],
	path: string,
	role: Message["role"],
): Result.Result<readonly MessageContentPart[], ConversionError> {
	return content.reduce<Result.Result<readonly MessageContentPart[], ConversionError>>(
		(previous, part, index) =>
			Result.gen(function* () {
				const output = yield* previous
				const field = `${path}[${index}]`
				return yield* Match.value(part.type).pipe(
					Match.when("text", () =>
						Result.gen(function* () {
							const value = part as typeof part & {
								readonly type: "text"
								readonly text?: string
							}
							yield* only(part, field, ["type", "text"])
							if (value.text === undefined)
								return yield* Result.fail(
									at(`${field}.text`, "invalid", "text is required"),
								)
							return [
								...output,
								{
									type:
										role === "assistant"
											? ("output_text" as const)
											: ("input_text" as const),
									text: value.text,
								},
							]
						}),
					),
					Match.when("image_url", () =>
						Result.gen(function* () {
							const value = part as typeof part & {
								readonly type: "image_url"
								readonly image_url?: NonNullable<typeof part.image_url>
							}
							if (role !== "user")
								return yield* Result.fail(
									at(
										`${field}.type`,
										"unsupported",
										"no OpenResponses input content mapping",
									),
								)
							yield* only(part, field, ["type", "image_url"])
							if (!value.image_url)
								return yield* Result.fail(
									at(`${field}.image_url`, "invalid", "image_url is required"),
								)
							yield* only(value.image_url, `${field}.image_url`, ["url", "detail"])
							const url = yield* imageUrl(
								value.image_url.url,
								`${field}.image_url.url`,
							)
							return [
								...output,
								{
									type: "input_image" as const,
									image_url: url,
									...(value.image_url.detail === undefined
										? {}
										: { detail: value.image_url.detail }),
								},
							]
						}),
					),
					Match.orElse(() =>
						Result.fail(
							at(
								`${field}.type`,
								"unsupported",
								"no OpenResponses input content mapping",
							),
						),
					),
				)
			}),
		Result.succeed([]),
	)
}

const textParts = (
	content: string | null | readonly Part[] | undefined,
	path: string,
	role: Message["role"],
) =>
	typeof content === "string"
		? Result.succeed(content)
		: content === null || content === undefined
			? Result.fail(at(path, "invalid", "content is required"))
			: parts(content, path, role)

function convertMessage(
	source: Message,
	index: number,
): Result.Result<readonly GenerationInputItem[], ConversionError> {
	const path = `messages[${index}]`
	if (source.role === "system" || source.role === "developer" || source.role === "user")
		return Result.gen(function* () {
			yield* only(source, path, ["role", "content"])
			const content = yield* textParts(
				source.content as string | null | readonly Part[] | undefined,
				`${path}.content`,
				source.role,
			)
			return [{ type: "message", role: source.role, content } as GenerationInputItem]
		})
	if (source.role === "tool")
		return Result.gen(function* () {
			yield* only(source, path, ["role", "tool_call_id", "content"])
			yield* requireThat(
				!!source.tool_call_id,
				`${path}.tool_call_id`,
				"invalid",
				"tool call ID is required",
			)
			const content = yield* textParts(
				source.content as string | null | readonly Part[] | undefined,
				`${path}.content`,
				source.role,
			)
			return [
				{
					type: "function_call_output",
					call_id: source.tool_call_id!,
					output: content,
				} as GenerationInputItem,
			]
		})
	if (source.role !== "assistant")
		return Result.fail(at(`${path}.role`, "unsupported", "unknown chat message role"))
	return Result.gen(function* () {
		yield* only(source, path, ["role", "content", "tool_calls"])
		const calls = yield* (source.tool_calls ?? []).reduce<
			Result.Result<readonly GenerationInputItem[], ConversionError>
		>(
			(previous, entry, callIndex) =>
				Result.gen(function* () {
					const output = yield* previous
					const field = `${path}.tool_calls[${callIndex}]`
					yield* only(entry, field, ["id", "type", "function"])
					return yield* Match.value(entry.type).pipe(
						Match.when("function", () =>
							Result.gen(function* () {
								const value = entry as typeof entry & { readonly type: "function" }
								yield* only(value.function, `${field}.function`, [
									"name",
									"arguments",
								])
								yield* requireThat(
									!!value.id,
									`${field}.id`,
									"invalid",
									"tool call ID is required",
								)
								yield* requireThat(
									!!value.function.name,
									`${field}.function.name`,
									"invalid",
									"function name is required",
								)
								yield* requireThat(
									value.function.arguments !== undefined,
									`${field}.function.arguments`,
									"invalid",
									"arguments are required",
								)
								return [
									...output,
									{
										type: "function_call",
										call_id: value.id,
										name: value.function.name,
										arguments: value.function.arguments!,
									} as GenerationInputItem,
								]
							}),
						),
						Match.orElse(() =>
							Result.fail(
								at(
									`${field}.type`,
									"unsupported",
									"only function calls are supported",
								),
							),
						),
					)
				}),
			Result.succeed([]),
		)
		if (source.content == null && calls.length === 0)
			return yield* Result.fail(
				at(path, "invalid", "assistant message needs content or function calls"),
			)
		const content =
			source.content == null
				? []
				: [
						{
							type: "message",
							role: "assistant",
							content: yield* textParts(
								source.content as string | null | readonly Part[] | undefined,
								`${path}.content`,
								"assistant",
							),
						} as GenerationInputItem,
					]
		return [...content, ...calls]
	})
}

/** Parse untrusted Chat JSON once before translating its supported semantics. */
export function parseRequest(
	value: unknown,
): Result.Result<OpenAIChatCompletionsRequest, ConversionError> {
	return Result.flatMap(decodeRequest(value), (source) =>
		Result.gen(function* () {
			yield* only(source, "request", [
				"model",
				"messages",
				"tools",
				"tool_choice",
				"response_format",
				"max_completion_tokens",
				"max_tokens",
				"temperature",
				"top_p",
				"presence_penalty",
				"frequency_penalty",
				"parallel_tool_calls",
				"stream",
				"stream_options",
				"store",
				"metadata",
				"n",
			])
			yield* requireThat(!!source.model, "request.model", "invalid", "model is required")
			if (source.max_tokens !== undefined && source.max_completion_tokens !== undefined)
				return yield* Result.fail(
					at(
						"request.max_tokens",
						"invalid",
						"cannot combine max_tokens with max_completion_tokens",
					),
				)
			if (source.n !== undefined && source.n !== 1)
				return yield* Result.fail(
					at("request.n", "unsupported", "only one choice is portable"),
				)
			const input = yield* source.messages.reduce<
				Result.Result<readonly GenerationInputItem[], ConversionError>
			>(
				(previous, item, itemIndex) =>
					Result.gen(function* () {
						const entries = yield* previous
						return [...entries, ...(yield* convertMessage(item, itemIndex))]
					}),
				Result.succeed([]),
			)
			const tools = yield* (source.tools ?? []).reduce<
				Result.Result<readonly GenerationTool[], ConversionError>
			>(
				(previous, entry, toolIndex) =>
					Result.gen(function* () {
						const output = yield* previous
						const path = `tools[${toolIndex}]`
						yield* only(entry, path, ["type", "function"])
						return yield* Match.value(entry.type).pipe(
							Match.when("function", () =>
								Result.gen(function* () {
									const functionEntry = entry as typeof entry & {
										readonly type: "function"
									}
									yield* only(functionEntry.function, `${path}.function`, [
										"name",
										"description",
										"parameters",
										"strict",
									])
									yield* requireThat(
										!!functionEntry.function.name,
										`${path}.function.name`,
										"invalid",
										"tool name is required",
									)
									return [
										...output,
										{
											type: "function" as const,
											name: functionEntry.function.name!,
											...(functionEntry.function.description === undefined
												? {}
												: {
														description:
															functionEntry.function.description,
													}),
											...(functionEntry.function.parameters === undefined
												? {}
												: {
														parameters:
															functionEntry.function.parameters,
													}),
											...(functionEntry.function.strict === undefined
												? {}
												: { strict: functionEntry.function.strict }),
										},
									] satisfies readonly GenerationTool[]
								}),
							),
							Match.orElse(() =>
								Result.fail(
									at(
										`${path}.type`,
										"unsupported",
										"only function tools are supported",
									),
								),
							),
						)
					}),
				Result.succeed([] as readonly GenerationTool[]),
			)
			const choice = yield* source.tool_choice === undefined
				? Result.succeed(undefined)
				: typeof source.tool_choice === "string"
					? Result.succeed(source.tool_choice)
					: Result.gen(function* () {
							const value = source.tool_choice as Exclude<
								Native["tool_choice"],
								string | undefined
							>
							yield* only(value, "tool_choice", ["type", "function"])
							return yield* Match.value(value.type).pipe(
								Match.when("function", () =>
									Result.gen(function* () {
										yield* only(value.function, "tool_choice.function", [
											"name",
										])
										return {
											type: "function" as const,
											name: value.function.name,
										}
									}),
								),
								Match.orElse(() =>
									Result.fail(
										at(
											"tool_choice.type",
											"unsupported",
											"only function tools are supported",
										),
									),
								),
							)
						})
			const format = yield* source.response_format === undefined
				? Result.succeed(undefined)
				: Result.gen(function* () {
						const value = source.response_format!
						return yield* Match.value(value.type).pipe(
							Match.when("text", () =>
								Result.gen(function* () {
									yield* only(value, "response_format", ["type"])
									return { format: { type: "text" as const } }
								}),
							),
							Match.when("json_schema", () =>
								Result.gen(function* () {
									yield* only(value, "response_format", ["type", "json_schema"])
									if (!value.json_schema)
										return yield* Result.fail(
											at(
												"response_format.json_schema",
												"invalid",
												"json_schema is required",
											),
										)
									yield* only(value.json_schema, "response_format.json_schema", [
										"name",
										"description",
										"schema",
										"strict",
									])
									return {
										format: {
											type: "json_schema" as const,
											name: value.json_schema.name,
											...(value.json_schema.description === undefined
												? {}
												: { description: value.json_schema.description }),
											...(value.json_schema.schema === undefined
												? {}
												: { schema: value.json_schema.schema }),
											...(value.json_schema.strict === undefined
												? {}
												: { strict: value.json_schema.strict }),
										},
									}
								}),
							),
							Match.orElse(() =>
								Result.fail(
									at(
										"response_format.type",
										"unsupported",
										"only text and json_schema are supported",
									),
								),
							),
						)
					})
			if (source.stream_options)
				yield* only(source.stream_options, "request.stream_options", [
					"include_usage",
					"include_obfuscation",
				])
			const limit = source.max_completion_tokens ?? source.max_tokens
			const limitPath =
				source.max_completion_tokens === undefined
					? "request.max_tokens"
					: "request.max_completion_tokens"
			if (limit !== undefined) {
				yield* requireThat(
					Number.isInteger(limit) && limit > 0,
					limitPath,
					"invalid",
					"expected a positive integer",
				)
				yield* requireThat(
					limit >= 16,
					limitPath,
					"unsupported",
					"OpenResponses requires at least 16 output tokens",
				)
			}
			if (source.metadata) {
				yield* requireThat(
					Object.keys(source.metadata).length <= 16,
					"request.metadata",
					"unsupported",
					"OpenResponses allows at most 16 pairs",
				)
				const oversized = Object.entries(source.metadata).find(
					([key, entry]) => key.length > 64 || entry.length > 512,
				)
				if (oversized)
					return yield* Result.fail(
						at(
							`request.metadata.${oversized[0]}`,
							"unsupported",
							"metadata size limit exceeded",
						),
					)
			}
			const outOfRange = (
				["temperature", "top_p", "presence_penalty", "frequency_penalty"] as const
			).find(
				(key) =>
					source[key] !== undefined &&
					(!Number.isFinite(source[key]) ||
						source[key]! < (key.endsWith("penalty") ? -2 : 0) ||
						source[key]! > (key === "top_p" ? 1 : 2)),
			)
			if (outOfRange)
				return yield* Result.fail(
					at(`request.${outOfRange}`, "invalid", "number out of range"),
				)
			const request: GenerationRequest = {
				model: source.model,
				input,
				...(source.tools === undefined ? {} : { tools }),
				...(choice === undefined ? {} : { tool_choice: choice }),
				...(format === undefined ? {} : { text: format }),
				...(limit === undefined ? {} : { max_output_tokens: limit }),
				...Object.fromEntries(
					(
						[
							"temperature",
							"top_p",
							"presence_penalty",
							"frequency_penalty",
							"parallel_tool_calls",
							"stream",
							"store",
							"metadata",
						] as const
					)
						.filter((key) => source[key] !== undefined)
						.map((key) => [key, source[key]]),
				),
				...(source.stream_options === undefined
					? {}
					: {
							stream_options:
								source.stream_options.include_obfuscation === undefined
									? {}
									: {
											include_obfuscation:
												source.stream_options.include_obfuscation,
										},
						}),
			}
			return {
				request,
				ingress: {
					stream: source.stream === true,
					hasStreamOptions: source.stream_options !== undefined,
					includeUsage: source.stream_options?.include_usage ?? false,
				},
			}
		}),
	)
}

/** Parse and project Chat JSON for callers that do not need transport options. */
export const toResponseRequest = (
	value: unknown,
): Result.Result<GenerationRequest, ConversionError> =>
	Result.map(parseRequest(value), ({ request }) => request)
