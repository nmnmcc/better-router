import { Effect, Match, Option, Result, Schema, Stream } from "effect"
import type {
	GenerationEvent,
	GenerationInputItem,
	GenerationOutputItem,
	GenerationRequest,
	GenerationResponse,
	GenerationTool,
	OutputContentPart,
} from "@better-router/core/Generation"
import { at, ConversionError, fromSchema } from "@better-router/core/Convert"
import {
	Event as GenerationEventSchema,
	Request as GenerationRequestSchema,
	Response as GenerationResponseSchema,
} from "@better-router/core/GenerationSchema"
import { Request as WireRequest } from "./Api.js"

type Wire = typeof WireRequest.Type
type WireMessage = Wire["messages"][number]
type WirePart = Exclude<NonNullable<WireMessage["content"]>, string | null>[number]

/** Decode wire-only projection options separately from the provider-neutral request. */
export const decodeStreamOptions = (
	value: unknown,
): Result.Result<Readonly<{ includeUsage: boolean }>, ConversionError> =>
	Schema.decodeUnknownResult(WireRequest)(value, { onExcessProperty: "error" }).pipe(
		Result.mapError((error) => fromSchema(error, "request")),
		Result.map((request) => ({ includeUsage: request.stream_options?.include_usage === true })),
	)

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

const requestKeys = [
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
] as const

const rejectUnknownRequestKeys = (request: Wire): Result.Result<void, ConversionError> => {
	const key = Object.keys(request).find(
		(candidate) => !(requestKeys as readonly string[]).includes(candidate),
	)
	return key === undefined
		? Result.void
		: Result.fail(at(`request.${key}`, "unsupported", "request parameter"))
}

export const decodeRequest = (value: unknown): Result.Result<GenerationRequest, ConversionError> =>
	Result.gen(function* () {
		const request = yield* Schema.decodeUnknownResult(WireRequest)(value, {
			onExcessProperty: "error",
		}).pipe(Result.mapError((error) => fromSchema(error, "request")))
		yield* rejectUnknownRequestKeys(request)
		if (request.stream_options && request.stream !== true)
			return yield* Result.fail(
				at("request.stream_options", "invalid", "stream_options requires stream=true"),
			)
		if (request.stream_options?.include_obfuscation !== undefined)
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

const emptyOutput = (): Output => ({ content: "", refusal: null, tool_calls: [] })

const portablePart = (
	part: OutputContentPart,
	path: string,
): Result.Result<void, ConversionError> =>
	part.type === "refusal"
		? Result.void
		: part.type !== "output_text"
			? Result.fail(at(`${path}.type`, "unsupported", "content part"))
			: part.annotations.length > 0
				? Result.fail(at(`${path}.annotations`, "unsupported", "annotations"))
				: part.logprobs && part.logprobs.length > 0
					? Result.fail(at(`${path}.logprobs`, "unsupported", "log probabilities"))
					: Result.void

const projectItem = (
	current: Output,
	item: GenerationOutputItem,
	path: string,
): Result.Result<Output, ConversionError> =>
	Result.gen(function* () {
		if (item.type === "message") {
			if (item.role !== "assistant")
				return yield* Result.fail(at(`${path}.role`, "unsupported", "output message role"))
			return yield* item.content.reduce<Result.Result<Output, ConversionError>>(
				(previous, part, index) =>
					Result.gen(function* () {
						const value = yield* previous
						yield* portablePart(part, `${path}.content[${index}]`)
						return part.type === "output_text"
							? { ...value, content: value.content + part.text }
							: part.type === "refusal"
								? { ...value, refusal: (value.refusal ?? "") + part.refusal }
								: value
					}),
				Result.succeed(current),
			)
		}
		if (item.type === "function_call") {
			if (!item.call_id)
				return yield* Result.fail(at(`${path}.call_id`, "invalid", "tool call id"))
			if (!item.name) return yield* Result.fail(at(`${path}.name`, "invalid", "tool name"))
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
		}
		return yield* Result.fail(at(`${path}.type`, "unsupported", "output item"))
	})

const projectOutput = (
	response: GenerationResponse,
	path = "response",
): Result.Result<Output, ConversionError> =>
	response.output.reduce<Result.Result<Output, ConversionError>>(
		(previous, item, index) =>
			Result.flatMap(previous, (current) =>
				projectItem(current, item, `${path}.output[${index}]`),
			),
		Result.succeed(emptyOutput()),
	)

type FinishReason = "stop" | "tool_calls" | "length" | "content_filter"

const finishReason = (
	response: GenerationResponse,
	output: Output,
	path: string,
): Result.Result<FinishReason, ConversionError> =>
	response.status === "completed"
		? Result.succeed(output.tool_calls.length > 0 ? "tool_calls" : "stop")
		: response.status === "incomplete"
			? response.incomplete_details?.reason === "max_output_tokens" ||
				response.incomplete_details?.reason === "length"
				? Result.succeed("length")
				: response.incomplete_details?.reason === "content_filter"
					? Result.succeed("content_filter")
					: Result.fail(
							at(
								`${path}.incomplete_details.reason`,
								"unsupported",
								"incomplete reason",
							),
						)
			: Result.fail(
					at(`${path}.status`, "invalid", "expected a successful terminal response"),
				)

const projectUsage = (usage: NonNullable<GenerationResponse["usage"]>) => ({
	prompt_tokens: usage.input_tokens,
	completion_tokens: usage.output_tokens,
	total_tokens: usage.total_tokens,
	prompt_tokens_details: { cached_tokens: usage.input_tokens_details.cached_tokens },
	completion_tokens_details: { reasoning_tokens: usage.output_tokens_details.reasoning_tokens },
})

export const encodeResponse = (
	value: GenerationResponse,
): Result.Result<Readonly<Record<string, unknown>>, ConversionError> =>
	Result.gen(function* () {
		const response = yield* Schema.decodeUnknownResult(GenerationResponseSchema)(value).pipe(
			Result.mapError((error) => fromSchema(error, "response")),
		)
		const output = yield* projectOutput(response)
		const finish_reason = yield* finishReason(response, output, "response")
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
						content: output.content || null,
						refusal: output.refusal,
						...(output.tool_calls.length ? { tool_calls: output.tool_calls } : {}),
					},
					finish_reason,
				},
			],
			...(response.usage ? { usage: projectUsage(response.usage) } : {}),
		}
	})

type Chunk = Readonly<Record<string, unknown>>
export type StreamOptions = Readonly<{ includeUsage?: boolean }>
type Identity = Readonly<{ id: string; created: number; model: string }>
type ToolState = Readonly<{
	outputIndex: number
	index: number
	itemId: string
	callId: string
	name: string
	arguments: string
}>
type MessageState = Readonly<{
	outputIndex: number
	itemId: string
	text: string
	refusal: string
	parts: readonly Readonly<{
		index: number
		type: "output_text" | "refusal"
		value: string
	}>[]
}>
type StreamState = Readonly<{
	identity: Option.Option<Identity>
	tools: readonly ToolState[]
	messages: readonly MessageState[]
	terminal: boolean
	completedTools: readonly number[]
	completedMessages: readonly string[]
}>
type Transition = readonly [StreamState, readonly Chunk[]]

const initial = (): StreamState => ({
	identity: Option.none(),
	tools: [],
	messages: [],
	terminal: false,
	completedTools: [],
	completedMessages: [],
})

const identity = (response: GenerationResponse): Result.Result<Identity, ConversionError> =>
	!response.id
		? Result.fail(at("event.response.id", "invalid", "response id"))
		: !response.model
			? Result.fail(at("event.response.model", "invalid", "response model"))
			: Result.succeed({
					id: response.id,
					created: response.created_at,
					model: response.model,
				})

const chunk = (
	identity: Identity,
	delta: Readonly<Record<string, unknown>>,
	finish_reason: FinishReason | null = null,
	usage: GenerationResponse["usage"] = null,
): Chunk => ({
	...identity,
	object: "chat.completion.chunk",
	choices: [{ index: 0, delta, finish_reason }],
	...(usage ? { usage: projectUsage(usage) } : {}),
})

const usageChunk = (
	identity: Identity,
	usage: NonNullable<GenerationResponse["usage"]>,
): Chunk => ({
	...identity,
	object: "chat.completion.chunk",
	choices: [],
	usage: projectUsage(usage),
})

const snapshotIdentity = (
	current: Identity,
	response: GenerationResponse,
): Result.Result<void, ConversionError> =>
	current.id !== response.id
		? Result.fail(at("event.response.id", "invalid", "response identity changed"))
		: current.model !== response.model
			? Result.fail(at("event.response.model", "invalid", "response model changed"))
			: current.created !== response.created_at
				? Result.fail(
						at(
							"event.response.created_at",
							"invalid",
							"response creation time changed",
						),
					)
				: Result.void

const toolFor = (
	state: StreamState,
	outputIndex: number,
	itemId: string,
): Result.Result<ToolState, ConversionError> =>
	Result.gen(function* () {
		const tool = yield* Result.fromOption(
			Option.fromUndefinedOr(state.tools.find((entry) => entry.outputIndex === outputIndex)),
			() => at("event.output_index", "invalid", "tool arguments before tool call"),
		)
		return tool.itemId === itemId
			? tool
			: yield* Result.fail(at("event.item_id", "invalid", "tool item identity changed"))
	})

const messageFor = (
	state: StreamState,
	outputIndex: number,
	itemId: string,
): Result.Result<readonly [StreamState, MessageState], ConversionError> =>
	Result.gen(function* () {
		if (state.tools.some((tool) => tool.outputIndex === outputIndex))
			return yield* Result.fail(
				at("event.output_index", "invalid", "output index belongs to a tool"),
			)
		if (state.completedMessages.includes(itemId))
			return yield* Result.fail(
				at("event.item_id", "invalid", "message event after item.done"),
			)
		const existing = Option.fromUndefinedOr(
			state.messages.find((entry) => entry.outputIndex === outputIndex),
		)
		if (Option.isSome(existing))
			return existing.value.itemId === itemId
				? ([state, existing.value] as const)
				: yield* Result.fail(
						at("event.item_id", "invalid", "message item identity changed"),
					)
		if (state.messages.some((entry) => entry.itemId === itemId))
			return yield* Result.fail(
				at("event.item_id", "invalid", "message output index changed"),
			)
		const next: MessageState = { outputIndex, itemId, text: "", refusal: "", parts: [] }
		return [{ ...state, messages: [...state.messages, next] }, next] as const
	})

const updateMessage = (
	state: StreamState,
	itemId: string,
	update: (message: MessageState) => MessageState,
): StreamState => ({
	...state,
	messages: state.messages.map((message) =>
		message.itemId === itemId ? update(message) : message,
	),
})

const partFor = (
	state: StreamState,
	outputIndex: number,
	itemId: string,
	contentIndex: number,
	type: "output_text" | "refusal",
): Result.Result<readonly [StreamState, string], ConversionError> =>
	Result.gen(function* () {
		const [next, message] = yield* messageFor(state, outputIndex, itemId)
		const part = Option.fromUndefinedOr(
			message.parts.find((part) => part.index === contentIndex),
		)
		if (Option.isSome(part)) {
			if (part.value.type !== type)
				return yield* Result.fail(
					at("event.content_index", "invalid", "content part type changed"),
				)
			return [next, part.value.value] as const
		}
		return [
			updateMessage(next, itemId, (message) => ({
				...message,
				parts: [...message.parts, { index: contentIndex, type, value: "" }],
			})),
			"",
		] as const
	})

const appendPart = (
	state: StreamState,
	itemId: string,
	contentIndex: number,
	type: "output_text" | "refusal",
	delta: string,
): StreamState =>
	updateMessage(state, itemId, (message) => ({
		...message,
		text: type === "output_text" ? message.text + delta : message.text,
		refusal: type === "refusal" ? message.refusal + delta : message.refusal,
		parts: message.parts.map((part) =>
			part.index === contentIndex ? { ...part, value: part.value + delta } : part,
		),
	}))

const outputFor = (
	item: GenerationOutputItem,
	path: string,
): Result.Result<Output, ConversionError> => projectItem(emptyOutput(), item, path)

const requireEmptySnapshot = (
	response: GenerationResponse,
	path: string,
): Result.Result<void, ConversionError> =>
	response.output.length === 0
		? Result.void
		: Result.fail(at(`${path}.output`, "unsupported", "snapshot output"))

const reconcileOutput = (
	state: StreamState,
	response: GenerationResponse,
	path: string,
): Result.Result<void, ConversionError> => {
	const missing = [...state.messages, ...state.tools].some(
		(tracked) => !response.output.some((item) => item.id === tracked.itemId),
	)
	return missing
		? Result.fail(at(`${path}.output`, "invalid", "terminal response omitted streamed output"))
		: response.output.reduce<Result.Result<void, ConversionError>>(
				(previous, item, index) =>
					Result.gen(function* () {
						yield* previous
						const output = yield* outputFor(item, `${path}.output[${index}]`)
						if (item.type === "message") {
							const tracked = state.messages.find(
								(message) => message.itemId === item.id,
							)
							if (tracked === undefined)
								return yield* Result.fail(
									at(
										`${path}.output[${index}].content`,
										"invalid",
										"terminal output was not streamed",
									),
								)
							if (tracked.outputIndex !== index)
								return yield* Result.fail(
									at(
										`${path}.output[${index}]`,
										"invalid",
										"terminal output index changed",
									),
								)
							if (
								tracked !== undefined &&
								(tracked.text !== output.content ||
									tracked.refusal !== (output.refusal ?? ""))
							)
								return yield* Result.fail(
									at(
										`${path}.output[${index}].content`,
										"invalid",
										"terminal output differs from streamed output",
									),
								)
						}
						if (item.type === "function_call") {
							const tracked = state.tools.find((tool) => tool.itemId === item.id)
							if (tracked === undefined)
								return yield* Result.fail(
									at(
										`${path}.output[${index}].arguments`,
										"invalid",
										"terminal arguments were not streamed",
									),
								)
							if (tracked.callId !== item.call_id || tracked.name !== item.name)
								return yield* Result.fail(
									at(
										`${path}.output[${index}]`,
										"invalid",
										"terminal tool identity changed",
									),
								)
							if (tracked.outputIndex !== index)
								return yield* Result.fail(
									at(
										`${path}.output[${index}]`,
										"invalid",
										"terminal output index changed",
									),
								)
							if (tracked.arguments !== item.arguments)
								return yield* Result.fail(
									at(
										`${path}.output[${index}].arguments`,
										"invalid",
										"terminal arguments differ from streamed arguments",
									),
								)
						}
						return yield* Result.void
					}),
				Result.void,
			)
}

const transition = (
	state: StreamState,
	event: GenerationEvent,
	options: StreamOptions,
): Result.Result<Transition, ConversionError> =>
	Result.gen(function* () {
		if (state.terminal)
			return yield* Result.fail(at("event.type", "invalid", "event after terminal response"))
		if (event.type === "error")
			return yield* Result.fail(at("event.error", "invalid", event.error.message))
		if (event.type === "response.failed")
			return yield* Result.fail(
				at(
					event.response.status === "failed"
						? "event.response.error"
						: "event.response.status",
					"invalid",
					event.response.status === "failed"
						? (event.response.error?.message ?? "response failed")
						: "terminal response status disagrees with event",
				),
			)
		if (
			(event.type === "response.completed" && event.response.status !== "completed") ||
			(event.type === "response.incomplete" && event.response.status !== "incomplete")
		)
			return yield* Result.fail(
				at(
					"event.response.status",
					"invalid",
					"terminal response status disagrees with event",
				),
			)
		if (
			(event.type === "response.completed" || event.type === "response.incomplete") &&
			event.response.error !== null
		)
			return yield* Result.fail(
				at(
					"event.response.error",
					"invalid",
					"successful terminal response contains an error",
				),
			)
		if (event.type === "response.created") {
			if (Option.isSome(state.identity))
				return yield* Result.fail(
					at("event.type", "invalid", "duplicate response creation"),
				)
			const current = yield* identity(event.response)
			yield* requireEmptySnapshot(event.response, "event.response")
			return [
				{ ...state, identity: Option.some(current) },
				[chunk(current, { role: "assistant", content: "" })],
			] as const
		}
		const current = yield* Result.fromOption(state.identity, () =>
			at("event.type", "invalid", "output before response.created"),
		)
		return yield* Match.value(event).pipe(
			Match.whenOr({ type: "response.in_progress" }, { type: "response.queued" }, (value) =>
				Result.gen(function* () {
					yield* snapshotIdentity(current, value.response)
					yield* requireEmptySnapshot(value.response, "event.response")
					return [state, []] as const
				}),
			),
			Match.when({ type: "response.output_item.added" }, (value) =>
				Result.gen(function* () {
					if (value.item === null)
						return yield* Result.fail(
							at("event.item", "invalid", "missing output item"),
						)
					const itemOutput = yield* projectItem(emptyOutput(), value.item, "event.item")
					if (value.item.type === "message") {
						if (itemOutput.content.length > 0 || (itemOutput.refusal ?? "").length > 0)
							return yield* Result.fail(
								at("event.item.content", "unsupported", "snapshot content"),
							)
						const itemId = value.item.id
						if (state.tools.some((tool) => tool.itemId === itemId))
							return yield* Result.fail(
								at("event.item.id", "invalid", "duplicate item id"),
							)
						const [next] = yield* messageFor(state, value.output_index, value.item.id)
						return [next, []] as const
					}
					if (value.item.type !== "function_call") return [state, []] as const
					const item = value.item
					if (!item.id)
						return yield* Result.fail(at("event.item.id", "invalid", "tool item id"))
					if (
						state.tools.some(
							(tool) =>
								tool.outputIndex === value.output_index ||
								tool.itemId === item.id ||
								tool.callId === item.call_id,
						) ||
						state.messages.some((message) => message.itemId === item.id)
					)
						return yield* Result.fail(
							at("event.item", "invalid", "duplicate tool call"),
						)
					const tool: ToolState = {
						outputIndex: value.output_index,
						index: state.tools.length,
						itemId: item.id,
						callId: item.call_id,
						name: item.name,
						arguments: item.arguments,
					}
					if (state.messages.some((entry) => entry.outputIndex === value.output_index))
						return yield* Result.fail(
							at(
								"event.output_index",
								"invalid",
								"output index already belongs to a message",
							),
						)
					return [
						{ ...state, tools: [...state.tools, tool] },
						[
							chunk(current, {
								tool_calls: [
									{
										index: tool.index,
										id: item.call_id,
										type: "function",
										function: { name: item.name, arguments: item.arguments },
									},
								],
							}),
						],
					] as const
				}),
			),
			Match.when({ type: "response.output_item.done" }, (value) =>
				Result.gen(function* () {
					if (value.item === null)
						return yield* Result.fail(
							at("event.item", "invalid", "missing output item"),
						)
					const itemOutput = yield* projectItem(emptyOutput(), value.item, "event.item")
					if (value.item.type === "function_call") {
						const tool = yield* toolFor(state, value.output_index, value.item.id)
						if (state.completedTools.includes(tool.index))
							return yield* Result.fail(
								at("event.item", "invalid", "duplicate tool item.done"),
							)
						if (tool.callId !== value.item.call_id || tool.name !== value.item.name)
							return yield* Result.fail(
								at("event.item", "invalid", "tool call changed"),
							)
						if (tool.arguments !== value.item.arguments)
							return yield* Result.fail(
								at("event.item.arguments", "invalid", "tool arguments changed"),
							)
						return [
							{ ...state, completedTools: [...state.completedTools, tool.index] },
							[],
						] as const
					}
					if (value.item.type === "message") {
						const itemId = value.item.id
						const [next] = yield* messageFor(state, value.output_index, itemId)
						const tracked = next.messages.find((message) => message.itemId === itemId)
						if (
							tracked === undefined ||
							tracked.text !== itemOutput.content ||
							tracked.refusal !== (itemOutput.refusal ?? "")
						)
							return yield* Result.fail(
								at(
									"event.item.content",
									"invalid",
									"item content differs from streamed content",
								),
							)
						return [
							{ ...next, completedMessages: [...next.completedMessages, itemId] },
							[],
						] as const
					}
					return [state, []] as const
				}),
			),
			Match.whenOr(
				{ type: "response.content_part.added" },
				{ type: "response.content_part.done" },
				(value) =>
					Result.gen(function* () {
						yield* portablePart(value.part, "event.part")
						if (
							value.type === "response.content_part.added" &&
							((value.part.type === "output_text" && value.part.text.length > 0) ||
								(value.part.type === "refusal" && value.part.refusal.length > 0))
						)
							return yield* Result.fail(
								at("event.part", "unsupported", "snapshot content"),
							)
						const [next, partValue] = yield* partFor(
							state,
							value.output_index,
							value.item_id,
							value.content_index,
							value.part.type === "output_text" ? "output_text" : "refusal",
						)
						if (
							value.type === "response.content_part.done" &&
							value.part.type === "output_text" &&
							partValue !== value.part.text
						)
							return yield* Result.fail(
								at("event.part.text", "invalid", "text differs from streamed text"),
							)
						if (
							value.type === "response.content_part.done" &&
							value.part.type === "refusal" &&
							partValue !== value.part.refusal
						)
							return yield* Result.fail(
								at(
									"event.part.refusal",
									"invalid",
									"refusal differs from streamed refusal",
								),
							)
						return [next, []] as const
					}),
			),
			Match.when({ type: "response.output_text.delta" }, (value) =>
				Result.gen(function* () {
					if (value.logprobs && value.logprobs.length > 0)
						return yield* Result.fail(
							at("event.logprobs", "unsupported", "log probabilities"),
						)
					const [next] = yield* partFor(
						state,
						value.output_index,
						value.item_id,
						value.content_index,
						"output_text",
					)
					return [
						appendPart(
							next,
							value.item_id,
							value.content_index,
							"output_text",
							value.delta,
						),
						[chunk(current, { content: value.delta })],
					] as const
				}),
			),
			Match.when({ type: "response.refusal.delta" }, (value) =>
				partFor(
					state,
					value.output_index,
					value.item_id,
					value.content_index,
					"refusal",
				).pipe(
					Result.map(
						([next]) =>
							[
								appendPart(
									next,
									value.item_id,
									value.content_index,
									"refusal",
									value.delta,
								),
								[chunk(current, { refusal: value.delta })],
							] as const,
					),
				),
			),
			Match.whenOr(
				{ type: "response.output_text.done" },
				{ type: "response.refusal.done" },
				(value) =>
					Result.gen(function* () {
						if (
							value.type === "response.output_text.done" &&
							value.logprobs &&
							value.logprobs.length > 0
						)
							return yield* Result.fail(
								at("event.logprobs", "unsupported", "log probabilities"),
							)
						const [next, partValue] = yield* partFor(
							state,
							value.output_index,
							value.item_id,
							value.content_index,
							value.type === "response.output_text.done" ? "output_text" : "refusal",
						)
						if (value.type === "response.output_text.done" && partValue !== value.text)
							return yield* Result.fail(
								at("event.text", "invalid", "text differs from streamed text"),
							)
						if (value.type === "response.refusal.done" && partValue !== value.refusal)
							return yield* Result.fail(
								at(
									"event.refusal",
									"invalid",
									"refusal differs from streamed refusal",
								),
							)
						return [next, []] as const
					}),
			),
			Match.when({ type: "response.function_call_arguments.delta" }, (value) =>
				Result.gen(function* () {
					const tool = yield* toolFor(state, value.output_index, value.item_id)
					if (state.completedTools.includes(tool.index))
						return yield* Result.fail(
							at("event.item_id", "invalid", "tool arguments after item.done"),
						)
					const tools = state.tools.map((entry) =>
						entry.index === tool.index
							? { ...entry, arguments: entry.arguments + value.delta }
							: entry,
					)
					return [
						{ ...state, tools },
						[
							chunk(current, {
								tool_calls: [
									{ index: tool.index, function: { arguments: value.delta } },
								],
							}),
						],
					] as const
				}),
			),
			Match.when({ type: "response.function_call_arguments.done" }, (value) =>
				Result.gen(function* () {
					const tool = yield* toolFor(state, value.output_index, value.item_id)
					if (state.completedTools.includes(tool.index))
						return yield* Result.fail(
							at("event.item_id", "invalid", "tool arguments after item.done"),
						)
					if (tool.arguments !== value.arguments)
						return yield* Result.fail(
							at("event.arguments", "invalid", "tool arguments changed"),
						)
					return [state, []] as const
				}),
			),
			Match.whenOr({ type: "response.completed" }, { type: "response.incomplete" }, (value) =>
				Result.gen(function* () {
					yield* snapshotIdentity(current, value.response)
					if (value.response.status !== value.type.slice("response.".length))
						return yield* Result.fail(
							at("event.response.status", "invalid", "terminal status"),
						)
					const output = yield* projectOutput(value.response, "event.response")
					yield* reconcileOutput(state, value.response, "event.response")
					const reason = yield* finishReason(value.response, output, "event.response")
					const terminal = chunk(current, {}, reason)
					const usage =
						options.includeUsage === true && value.response.usage !== null
							? [usageChunk(current, value.response.usage)]
							: []
					return [{ ...state, terminal: true }, [terminal, ...usage]] as const
				}),
			),
			Match.orElse(() =>
				Result.fail(at("event.type", "unsupported", "event cannot be represented")),
			),
		)
	})

/** Project a complete semantic stream with fresh immutable state for every subscription. */
export const encodeStream = <E, R>(
	events: Stream.Stream<GenerationEvent, E, R>,
	options: StreamOptions = {},
): Stream.Stream<Chunk, E | ConversionError, R> =>
	Stream.concat(
		Stream.map(events, (event) => ({ type: "event" as const, event })),
		Stream.succeed({ type: "end" as const }),
	).pipe(
		Stream.mapAccumEffect(initial, (state, entry) =>
			entry.type === "end"
				? state.terminal
					? Effect.succeed([state, []] as const)
					: Effect.fail(
							at("event.type", "invalid", "stream ended without a terminal response"),
						)
				: Effect.fromResult(
						Schema.decodeUnknownResult(GenerationEventSchema)(entry.event).pipe(
							Result.mapError((error) => fromSchema(error, "event")),
							Result.flatMap((event) => transition(state, event, options)),
						),
					),
		),
	)

/** Snapshot-only helper; deltas require encodeStream to retain identity and tool indices. */
export const encodeEvent = (value: GenerationEvent): Result.Result<Chunk, ConversionError> =>
	Result.gen(function* () {
		const event = yield* Schema.decodeUnknownResult(GenerationEventSchema)(value).pipe(
			Result.mapError((error) => fromSchema(error, "event")),
		)
		if (event.type === "response.created") {
			const current = yield* identity(event.response)
			yield* requireEmptySnapshot(event.response, "event.response")
			return chunk(current, { role: "assistant", content: "" })
		}
		if (event.type === "response.completed" || event.type === "response.incomplete") {
			const current = yield* identity(event.response)
			if (event.response.status !== event.type.slice("response.".length))
				return yield* Result.fail(at("event.response.status", "invalid", "terminal status"))
			const output = yield* projectOutput(event.response, "event.response")
			const reason = yield* finishReason(event.response, output, "event.response")
			return chunk(current, {}, reason, event.response.usage)
		}
		return yield* Result.fail(
			at("event.type", "unsupported", "event requires the stateful encodeStream projection"),
		)
	})
