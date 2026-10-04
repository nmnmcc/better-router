import { Match, Result, Schema } from "effect"
import type {
	GenerationEvent,
	GenerationInputItem,
	GenerationRequest,
	GenerationResponse,
	GenerationTool,
} from "@better-router/core/Generation"
import { at, ConversionError, fromSchema } from "@better-router/core/Convert"
import { Request as GenerationRequestSchema } from "@better-router/core/GenerationSchema"
import { Request as WireRequest } from "./Api.js"

type Wire = typeof WireRequest.Type

const block = Schema.StructWithRest(
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
	[Schema.Record(Schema.String, Schema.Unknown)] as const,
)
const source = Schema.StructWithRest(
	Schema.Struct({
		type: Schema.String,
		url: Schema.optional(Schema.String),
		media_type: Schema.optional(Schema.String),
		data: Schema.optional(Schema.String),
	}),
	[Schema.Record(Schema.String, Schema.Unknown)] as const,
)

const contentItems = (
	value: unknown,
	role: "user" | "assistant",
	path: string,
): Result.Result<readonly GenerationInputItem[], ConversionError> =>
	typeof value === "string"
		? Result.succeed([{ type: "message", role, content: value }])
		: Result.gen(function* () {
				const blocks = yield* Schema.decodeUnknownResult(Schema.Array(block))(value).pipe(
					Result.mapError((error) => fromSchema(error, path)),
				)
				return yield* blocks.reduce<
					Result.Result<readonly GenerationInputItem[], ConversionError>
				>(
					(previous, item, index) =>
						Result.gen(function* () {
							const entries = yield* previous
							const itemPath = `${path}[${index}]`
							if (item.type === "text")
								return [
									...entries,
									{
										type: "message" as const,
										role,
										content: [
											{
												type:
													role === "assistant"
														? ("output_text" as const)
														: ("input_text" as const),
												text: item.text ?? "",
											},
										],
									},
								]
							if (item.type === "image") {
								if (role !== "user")
									return yield* Result.fail(
										at(`${itemPath}.type`, "unsupported", "image role"),
									)
								const parsedSource = yield* Schema.decodeUnknownResult(source)(
									item.source,
								).pipe(
									Result.mapError((error) =>
										fromSchema(error, `${itemPath}.source`),
									),
								)
								const imageUrl =
									parsedSource.type === "url"
										? parsedSource.url
										: parsedSource.type === "base64" &&
											  parsedSource.media_type &&
											  parsedSource.data
											? `data:${parsedSource.media_type};base64,${parsedSource.data}`
											: undefined
								if (!imageUrl)
									return yield* Result.fail(
										at(`${itemPath}.source`, "invalid", "image source"),
									)
								return [
									...entries,
									{
										type: "message" as const,
										role,
										content: [
											{ type: "input_image" as const, image_url: imageUrl },
										],
									},
								]
							}
							if (item.type === "tool_use") {
								if (!item.id || !item.name)
									return yield* Result.fail(at(itemPath, "invalid", "tool use"))
								return [
									...entries,
									{
										type: "function_call" as const,
										call_id: item.id,
										name: item.name,
										arguments: JSON.stringify(item.input ?? {}),
									},
								]
							}
							if (item.type === "tool_result") {
								if (!item.tool_use_id)
									return yield* Result.fail(
										at(`${itemPath}.tool_use_id`, "invalid", "tool use id"),
									)
								return [
									...entries,
									{
										type: "function_call_output" as const,
										call_id: item.tool_use_id,
										output:
											typeof item.content === "string"
												? item.content
												: JSON.stringify(item.content ?? ""),
									},
								]
							}
							return yield* Result.fail(
								at(`${itemPath}.type`, "unsupported", "content block"),
							)
						}),
					Result.succeed([]),
				)
			})

const tools = (
	request: Wire,
): Result.Result<readonly GenerationTool[] | undefined, ConversionError> => {
	type WireTool = {
		readonly name: string
		readonly description?: string
		readonly input_schema: Readonly<Record<string, import("effect").Schema.Json>>
	}
	const parsed = ((request.tools as readonly WireTool[] | undefined) ?? []).reduce<
		Result.Result<readonly GenerationTool[], ConversionError>
	>(
		(previous, tool, index) =>
			Result.gen(function* () {
				const entries = yield* previous
				if (!tool.name)
					return yield* Result.fail(
						at(`request.tools[${index}].name`, "invalid", "tool name"),
					)
				return [
					...entries,
					{
						type: "function" as const,
						name: tool.name,
						...(tool.description ? { description: tool.description } : {}),
						parameters: tool.input_schema,
					},
				]
			}),
		Result.succeed([]),
	)
	return Result.map(parsed, (value) => (value.length === 0 ? undefined : value))
}

const system = (value: Wire["system"]): Result.Result<string | undefined, ConversionError> =>
	value == null
		? Result.succeed(undefined)
		: typeof value === "string"
			? Result.succeed(value)
			: value.reduce<Result.Result<string, ConversionError>>(
					(previous, block, index) =>
						Result.gen(function* () {
							const current = yield* previous
							if (block.type !== "text" || block.text === undefined)
								return yield* Result.fail(
									at(
										`request.system[${index}]`,
										"unsupported",
										"system content block",
									),
								)
							return current + block.text
						}),
					Result.succeed(""),
				)

const toolChoice = (
	value: Wire["tool_choice"],
): Result.Result<GenerationRequest["tool_choice"], ConversionError> =>
	value === undefined
		? Result.succeed(undefined)
		: value.type === "auto"
			? Result.succeed("auto")
			: value.type === "any"
				? Result.succeed("required")
				: value.type === "tool" && value.name
					? Result.succeed({ type: "function", name: value.name })
					: Result.fail(at("request.tool_choice", "unsupported", "tool choice"))

const textConfig = (
	value: Wire["output_config"],
): Result.Result<GenerationRequest["text"], ConversionError> =>
	value === undefined
		? Result.succeed(undefined)
		: value.format.type === "json_schema"
			? Result.succeed({
					format: {
						type: "json_schema",
						name: "response",
						...(value.format.schema === undefined
							? {}
							: { schema: value.format.schema }),
					},
				})
			: Result.fail(at("request.output_config.format.type", "unsupported", "output format"))

export const decodeRequest = (value: unknown): Result.Result<GenerationRequest, ConversionError> =>
	Result.gen(function* () {
		const request = yield* Schema.decodeUnknownResult(WireRequest)(value, {
			onExcessProperty: "error",
		}).pipe(Result.mapError((error) => fromSchema(error, "request")))
		const messages = yield* request.messages.reduce<
			Result.Result<readonly GenerationInputItem[], ConversionError>
		>(
			(previous, message, index) =>
				Result.gen(function* () {
					const entries = yield* previous
					if (message.role !== "user" && message.role !== "assistant")
						return yield* Result.fail(
							at(`request.messages[${index}].role`, "unsupported", "message role"),
						)
					return [
						...entries,
						...(yield* contentItems(
							message.content,
							message.role,
							`request.messages[${index}].content`,
						)),
					]
				}),
			Result.succeed([]),
		)
		const requestTools = yield* tools(request)
		const instructions = yield* system(request.system)
		const choice = yield* toolChoice(request.tool_choice)
		const text = yield* textConfig(request.output_config)
		const parallelToolCalls =
			request.tool_choice?.disable_parallel_tool_use === true ? false : undefined
		return yield* Schema.decodeUnknownResult(GenerationRequestSchema)({
			model: request.model,
			input: messages,
			max_output_tokens: request.max_tokens,
			...(instructions === undefined ? {} : { instructions }),
			...(request.stream === undefined ? {} : { stream: request.stream }),
			...(requestTools === undefined ? {} : { tools: requestTools }),
			...(choice === undefined ? {} : { tool_choice: choice }),
			...(text === undefined ? {} : { text }),
			...(parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }),
			...(request.temperature === undefined ? {} : { temperature: request.temperature }),
			...(request.top_p === undefined ? {} : { top_p: request.top_p }),
		}).pipe(Result.mapError((error) => fromSchema(error, "request")))
	})

const text = (response: GenerationResponse): Result.Result<string, ConversionError> =>
	response.output.reduce<Result.Result<string, ConversionError>>(
		(previous, item, index) =>
			Result.gen(function* () {
				const current = yield* previous
				if (item.type !== "message")
					return yield* Result.fail(
						at(`response.output[${index}]`, "unsupported", "output item"),
					)
				return yield* item.content.reduce<Result.Result<string, ConversionError>>(
					(content, part) =>
						part.type === "output_text"
							? Result.map(content, (value) => value + part.text)
							: Result.fail(
									at(
										`response.output[${index}].content`,
										"unsupported",
										"content part",
									),
								),
					Result.succeed(current),
				)
			}),
		Result.succeed(""),
	)

export const encodeResponse = (
	response: GenerationResponse,
): Result.Result<Readonly<Record<string, unknown>>, ConversionError> =>
	text(response).pipe(
		Result.map((value) => ({
			id: response.id,
			type: "message",
			role: "assistant",
			model: response.model,
			content: [{ type: "text", text: value }],
			stop_reason: response.status === "incomplete" ? "max_tokens" : "end_turn",
			stop_sequence: null,
			usage: {
				input_tokens: response.usage?.input_tokens ?? 0,
				output_tokens: response.usage?.output_tokens ?? 0,
			},
		})),
	)

export const encodeEvent = (
	event: GenerationEvent,
): Result.Result<Readonly<Record<string, unknown>>, ConversionError> =>
	Match.value(event).pipe(
		Match.when({ type: "response.created" }, (value) =>
			Result.succeed({
				type: "message_start",
				message: { id: value.response.id, type: "message", role: "assistant", content: [] },
			}),
		),
		Match.when({ type: "response.output_text.delta" }, (value) =>
			Result.succeed({
				type: "content_block_delta",
				index: value.output_index,
				delta: { type: "text_delta", text: value.delta },
			}),
		),
		Match.when({ type: "response.output_item.added" }, (value) =>
			value.item?.type === "function_call"
				? Result.succeed({
						type: "content_block_start",
						index: value.output_index,
						content_block: {
							type: "tool_use",
							id: value.item.call_id,
							name: value.item.name,
							input: {},
						},
					})
				: Result.fail(at("event.item", "unsupported", "output item")),
		),
		Match.when({ type: "response.function_call_arguments.delta" }, (value) =>
			Result.succeed({
				type: "content_block_delta",
				index: value.output_index,
				delta: { type: "input_json_delta", partial_json: value.delta },
			}),
		),
		Match.whenOr({ type: "response.completed" }, { type: "response.incomplete" }, (value) =>
			Result.succeed({
				type: "message_delta",
				delta: {
					stop_reason:
						value.type === "response.incomplete"
							? "max_tokens"
							: value.response.output.some((item) => item.type === "function_call")
								? "tool_use"
								: "end_turn",
				},
				usage: value.response.usage
					? { output_tokens: value.response.usage.output_tokens }
					: undefined,
			}),
		),
		Match.orElse(() =>
			Result.fail(at("event.type", "unsupported", "event cannot be represented")),
		),
	)
