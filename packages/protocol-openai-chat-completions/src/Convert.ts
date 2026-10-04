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
type WireMessage = Wire["messages"][number]
type WirePart = Exclude<NonNullable<WireMessage["content"]>, string | null>[number]

type MessageRole = "user" | "assistant" | "system" | "developer"

const decodeContent = (
	content: readonly WirePart[],
	role: MessageRole,
	index: number,
): Result.Result<readonly GenerationInputItem[], ConversionError> =>
	content.reduce<Result.Result<readonly GenerationInputItem[], ConversionError>>(
		(previous, part, partIndex) =>
			Result.gen(function* () {
				const entries = yield* previous
				const path = `request.messages[${index}].content[${partIndex}]`
				if (part.type === "text")
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
									text: part.text ?? "",
								},
							],
						},
					]
				if (part.type === "image_url") {
					if (role !== "user")
						return yield* Result.fail(
							at(`${path}.type`, "unsupported", "image input role"),
						)
					const url = part.image_url?.url
					if (!url)
						return yield* Result.fail(
							at(`${path}.image_url.url`, "invalid", "image URL"),
						)
					if (
						!/^https?:\/\/\S+$/.test(url) &&
						!/^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=]+$/.test(url)
					)
						return yield* Result.fail(
							at(`${path}.image_url.url`, "unsupported", "image URL"),
						)
					return [
						...entries,
						{
							type: "message" as const,
							role,
							content: [
								{
									type: "input_image" as const,
									image_url: url,
									...(part.image_url?.detail
										? { detail: part.image_url.detail }
										: {}),
								},
							],
						},
					]
				}
				return yield* Result.fail(at(`${path}.type`, "unsupported", "content part"))
			}),
		Result.succeed([]),
	)

const messageItems = (
	message: WireMessage,
	index: number,
): Result.Result<readonly GenerationInputItem[], ConversionError> =>
	Result.gen(function* () {
		if (
			message.role !== "user" &&
			message.role !== "assistant" &&
			message.role !== "system" &&
			message.role !== "developer" &&
			message.role !== "tool"
		)
			return yield* Result.fail(
				at(`request.messages[${index}].role`, "unsupported", "message role"),
			)
		if (message.role === "tool") {
			if (!message.tool_call_id)
				return yield* Result.fail(
					at(`request.messages[${index}].tool_call_id`, "invalid", "tool call id"),
				)
			return [
				{
					type: "function_call_output",
					call_id: message.tool_call_id,
					output: typeof message.content === "string" ? message.content : "",
				},
			]
		}
		const content = message.content ?? ""
		const role = message.role as MessageRole
		const items = yield* typeof content === "string"
			? Result.succeed<readonly GenerationInputItem[]>([
					{ type: "message" as const, role, content },
				])
			: decodeContent(content, role, index)
		const calls = message.tool_calls ?? []
		return yield* calls.reduce<Result.Result<readonly GenerationInputItem[], ConversionError>>(
			(previous, call, callIndex) =>
				Result.gen(function* () {
					const entries = yield* previous
					if (call.type !== "function" || !call.function.name)
						return yield* Result.fail(
							at(
								`request.messages[${index}].tool_calls[${callIndex}]`,
								"unsupported",
								"tool call",
							),
						)
					return [
						...entries,
						{
							type: "function_call" as const,
							call_id: call.id,
							name: call.function.name,
							arguments: call.function.arguments ?? "{}",
						},
					]
				}),
			Result.succeed(items),
		)
	})

const decodeTools = (
	request: Wire,
): Result.Result<readonly GenerationTool[] | undefined, ConversionError> =>
	(request.tools ?? [])
		.reduce<Result.Result<readonly GenerationTool[], ConversionError>>(
			(previous, tool, index) =>
				Result.gen(function* () {
					const entries = yield* previous
					if (tool.type !== "function")
						return yield* Result.fail(
							at(`request.tools[${index}].type`, "unsupported", "tool type"),
						)
					return [
						...entries,
						{
							type: "function" as const,
							name: tool.function.name,
							...(tool.function.description
								? { description: tool.function.description }
								: {}),
							...(tool.function.parameters
								? { parameters: tool.function.parameters }
								: {}),
							...(tool.function.strict === undefined
								? {}
								: { strict: tool.function.strict }),
						},
					]
				}),
			Result.succeed([]),
		)
		.pipe(Result.map((tools) => (tools.length === 0 ? undefined : tools)))

const toolChoice = (
	value: Wire["tool_choice"],
): Result.Result<GenerationRequest["tool_choice"], ConversionError> =>
	value === undefined
		? Result.succeed(undefined)
		: typeof value === "string"
			? Result.succeed(value)
			: value.type === "function"
				? Result.succeed({ type: "function", name: value.function.name })
				: Result.fail(at("request.tool_choice.type", "unsupported", "tool choice"))

const requestText = (
	value: Wire["response_format"],
): Result.Result<GenerationRequest["text"], ConversionError> =>
	value === undefined
		? Result.succeed(undefined)
		: value.type === "json_schema" && value.json_schema
			? Result.succeed({
					format: {
						type: "json_schema",
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
				})
			: value.type === "json_object"
				? Result.succeed({ format: { type: "json_object" } })
				: value.type === "text"
					? Result.succeed({ format: { type: "text" } })
					: Result.fail(
							at("request.response_format.type", "unsupported", "response format"),
						)

export const decodeRequest = (value: unknown): Result.Result<GenerationRequest, ConversionError> =>
	Result.gen(function* () {
		const request = yield* Schema.decodeUnknownResult(WireRequest)(value, {
			onExcessProperty: "error",
		}).pipe(Result.mapError((error) => fromSchema(error, "request")))
		if (request.stream_options && request.stream !== true)
			return yield* Result.fail(
				at("request.stream_options", "invalid", "stream_options requires stream=true"),
			)
		if (request.stream_options?.include_obfuscation)
			return yield* Result.fail(
				at("request.stream_options.include_obfuscation", "unsupported", "obfuscation"),
			)
		if (request.max_tokens !== undefined && request.max_completion_tokens !== undefined)
			return yield* Result.fail(at("request.max_tokens", "invalid", "choose one token limit"))
		const input = yield* request.messages.reduce<
			Result.Result<readonly GenerationInputItem[], ConversionError>
		>(
			(previous, message, index) =>
				Result.gen(function* () {
					const entries = yield* previous
					return [...entries, ...(yield* messageItems(message, index))]
				}),
			Result.succeed([]),
		)
		const tools = yield* decodeTools(request)
		const choice = yield* toolChoice(request.tool_choice)
		const text = yield* requestText(request.response_format)
		return yield* Schema.decodeUnknownResult(GenerationRequestSchema)({
			model: request.model,
			input,
			...(request.stream === undefined ? {} : { stream: request.stream }),
			...(request.max_completion_tokens === undefined && request.max_tokens === undefined
				? {}
				: { max_output_tokens: request.max_completion_tokens ?? request.max_tokens }),
			...(request.temperature === undefined ? {} : { temperature: request.temperature }),
			...(request.top_p === undefined ? {} : { top_p: request.top_p }),
			...(request.presence_penalty === undefined
				? {}
				: { presence_penalty: request.presence_penalty }),
			...(request.frequency_penalty === undefined
				? {}
				: { frequency_penalty: request.frequency_penalty }),
			...(request.parallel_tool_calls === undefined
				? {}
				: { parallel_tool_calls: request.parallel_tool_calls }),
			...(request.metadata === undefined ? {} : { metadata: request.metadata }),
			...(request.store === undefined ? {} : { store: request.store }),
			...(tools === undefined ? {} : { tools }),
			...(choice === undefined ? {} : { tool_choice: choice }),
			...(text === undefined ? {} : { text }),
		}).pipe(Result.mapError((error) => fromSchema(error, "request")))
	})

type ChatCall = {
	readonly id: string
	readonly type: "function"
	readonly function: { readonly name: string; readonly arguments: string }
}
type Output = {
	readonly content: string
	readonly refusal: string | null
	readonly tool_calls: readonly ChatCall[]
}

const projectOutput = (response: GenerationResponse): Result.Result<Output, ConversionError> =>
	response.output.reduce<Result.Result<Output, ConversionError>>(
		(previous, item, index) =>
			Result.gen(function* () {
				const current = yield* previous
				if (item.type === "message")
					return yield* item.content.reduce<Result.Result<Output, ConversionError>>(
						(content, part) =>
							Result.gen(function* () {
								const value = yield* content
								if (part.type === "output_text")
									return { ...value, content: value.content + part.text }
								if (part.type === "refusal")
									return {
										...value,
										refusal: (value.refusal ?? "") + part.refusal,
									}
								return yield* Result.fail(
									at(
										`response.output[${index}].content`,
										"unsupported",
										"content part",
									),
								)
							}),
						Result.succeed(current),
					)
				if (item.type === "function_call")
					return {
						...current,
						tool_calls: [
							...current.tool_calls,
							{
								id: item.call_id,
								type: "function" as const,
								function: { name: item.name, arguments: item.arguments },
							},
						],
					}
				return yield* Result.fail(
					at(`response.output[${index}]`, "unsupported", "output item"),
				)
			}),
		Result.succeed({ content: "", refusal: null, tool_calls: [] }),
	)

export const encodeResponse = (
	response: GenerationResponse,
): Result.Result<Readonly<Record<string, unknown>>, ConversionError> =>
	Result.gen(function* () {
		const value = yield* projectOutput(response)
		const finish_reason =
			response.status === "incomplete"
				? response.incomplete_details?.reason === "max_output_tokens"
					? "length"
					: "content_filter"
				: value.tool_calls.length > 0
					? "tool_calls"
					: "stop"
		return {
			id: response.id,
			object: "chat.completion",
			created: response.created_at,
			model: response.model,
			choices: [
				{
					index: 0,
					message: {
						role: "assistant",
						content: value.content || null,
						refusal: value.refusal,
						...(value.tool_calls.length ? { tool_calls: value.tool_calls } : {}),
					},
					finish_reason,
				},
			],
			...(response.usage
				? {
						usage: {
							prompt_tokens: response.usage.input_tokens,
							completion_tokens: response.usage.output_tokens,
							total_tokens: response.usage.total_tokens,
						},
					}
				: {}),
		}
	})

export const encodeEvent = (
	event: GenerationEvent,
): Result.Result<Readonly<Record<string, unknown>>, ConversionError> =>
	Match.value(event).pipe(
		Match.when({ type: "response.created" }, (value) =>
			Result.succeed({
				id: value.response.id,
				object: "chat.completion.chunk",
				created: value.response.created_at,
				model: value.response.model,
				choices: [
					{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
				],
			}),
		),
		Match.when({ type: "response.output_text.delta" }, (value) =>
			Result.succeed({
				id: value.item_id,
				object: "chat.completion.chunk",
				created: 0,
				model: "unknown",
				choices: [
					{
						index: value.output_index,
						delta: { content: value.delta },
						finish_reason: null,
					},
				],
			}),
		),
		Match.when({ type: "response.output_item.added" }, (value) =>
			value.item?.type === "function_call"
				? Result.succeed({
						id: value.item.id,
						object: "chat.completion.chunk",
						created: 0,
						model: "unknown",
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: value.output_index,
											id: value.item.call_id,
											type: "function",
											function: { name: value.item.name, arguments: "" },
										},
									],
								},
								finish_reason: null,
							},
						],
					})
				: Result.fail(at("event.item", "unsupported", "output item")),
		),
		Match.when({ type: "response.function_call_arguments.delta" }, (value) =>
			Result.succeed({
				id: value.item_id,
				object: "chat.completion.chunk",
				created: 0,
				model: "unknown",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: value.output_index,
									function: { arguments: value.delta },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
		),
		Match.whenOr({ type: "response.completed" }, { type: "response.incomplete" }, (value) =>
			projectOutput(value.response).pipe(
				Result.map((output) => ({
					id: value.response.id,
					object: "chat.completion.chunk",
					created: value.response.created_at,
					model: value.response.model,
					choices: [
						{
							index: 0,
							delta: {},
							finish_reason:
								value.type === "response.incomplete"
									? "length"
									: output.tool_calls.length > 0
										? "tool_calls"
										: "stop",
						},
					],
				})),
			),
		),
		Match.orElse(() =>
			Result.fail(at("event.type", "unsupported", "event cannot be represented")),
		),
	)
