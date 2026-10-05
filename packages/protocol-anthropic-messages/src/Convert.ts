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

const requestKeys = [
	"model",
	"messages",
	"max_tokens",
	"system",
	"stream",
	"tools",
	"tool_choice",
	"output_config",
	"temperature",
	"top_p",
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

type WireValue = Readonly<Record<string, unknown>>
type TextValue = Readonly<{ kind: "text" | "refusal"; value: string }>
type ToolItem = Extract<GenerationOutputItem, { readonly type: "function_call" }>

const jsonObject = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))
const argumentsObject = (value: string, path: string) =>
	Schema.decodeUnknownResult(jsonObject)(value.trim().length === 0 ? "{}" : value).pipe(
		Result.mapError((error) => fromSchema(error, path)),
	)

const argumentFragment = Schema.String.check(Schema.isPattern(/^\s*\{/))

const streamArgumentsObject = (
	value: string,
	path: string,
): Result.Result<void, ConversionError> => {
	const parsed = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Json))(
		value.trim().length === 0 ? "{}" : value,
	)
	if (Result.isFailure(parsed))
		return Schema.decodeUnknownResult(argumentFragment)(value).pipe(
			Result.map(() => undefined),
			Result.mapError((error) => fromSchema(error, path)),
		)
	return Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Json))(
		parsed.success,
	).pipe(
		Result.map(() => undefined),
		Result.mapError((error) => fromSchema(error, path)),
	)
}

const textValue = (
	part: OutputContentPart,
	path: string,
): Result.Result<TextValue, ConversionError> =>
	Result.gen(function* () {
		if (part.type === "refusal") return { kind: "refusal", value: part.refusal }
		if (part.type === "text") return { kind: "text", value: part.text }
		if (part.type !== "output_text")
			return yield* Result.fail(at(path, "unsupported", "content part"))
		if (part.annotations.length > 0)
			return yield* Result.fail(at(`${path}.annotations`, "unsupported", "text annotations"))
		if ((part.logprobs?.length ?? 0) > 0)
			return yield* Result.fail(
				at(`${path}.logprobs`, "unsupported", "text log probabilities"),
			)
		return { kind: "text", value: part.text }
	})

const assistant = (
	item: Extract<GenerationOutputItem, { readonly type: "message" }>,
	path: string,
) =>
	item.role === "assistant"
		? Result.void
		: Result.fail(at(`${path}.role`, "unsupported", "output message role"))

const toolIdentity = (item: ToolItem, path: string) =>
	Schema.decodeUnknownResult(
		Schema.Struct({ call_id: Schema.NonEmptyString, name: Schema.NonEmptyString }),
	)(item).pipe(Result.mapError((error) => fromSchema(error, path)))

const outputContent = (
	response: GenerationResponse,
	path: string,
): Result.Result<readonly WireValue[], ConversionError> =>
	response.output.reduce<Result.Result<readonly WireValue[], ConversionError>>(
		(previous, item, outputIndex) =>
			Result.gen(function* () {
				const current = yield* previous
				const itemPath = `${path}.output[${outputIndex}]`
				if (item.type === "message") {
					yield* assistant(item, itemPath)
					return yield* item.content.reduce<
						Result.Result<readonly WireValue[], ConversionError>
					>(
						(previous, part, contentIndex) =>
							Result.gen(function* () {
								const content = yield* previous
								const value = yield* textValue(
									part,
									`${itemPath}.content[${contentIndex}]`,
								)
								return [...content, { type: "text", text: value.value }]
							}),
						Result.succeed(current),
					)
				}
				if (item.type !== "function_call")
					return yield* Result.fail(at(itemPath, "unsupported", "output item"))
				yield* toolIdentity(item, itemPath)
				const input = yield* argumentsObject(item.arguments, `${itemPath}.arguments`)
				return [...current, { type: "tool_use", id: item.call_id, name: item.name, input }]
			}),
		Result.succeed([]),
	)

const stopReason = (
	response: GenerationResponse,
	path: string,
): Result.Result<string, ConversionError> =>
	response.status === "incomplete"
		? ["max_output_tokens", "max_tokens", "length"].includes(
				response.incomplete_details?.reason ?? "",
			)
			? Result.succeed("max_tokens")
			: ["content_filter", "refusal"].includes(response.incomplete_details?.reason ?? "")
				? Result.succeed("refusal")
				: Result.fail(
						at(`${path}.incomplete_details.reason`, "unsupported", "incomplete reason"),
					)
		: response.status !== "completed"
			? Result.fail(at(`${path}.status`, "unsupported", "response status"))
			: response.output.some(
						(item) =>
							item.type === "message" &&
							item.content.some((part) => part.type === "refusal"),
				  )
				? Result.succeed("refusal")
				: Result.succeed(
						response.output.some((item) => item.type === "function_call")
							? "tool_use"
							: "end_turn",
					)

const usage = (response: GenerationResponse): WireValue => ({
	input_tokens: response.usage?.input_tokens ?? 0,
	output_tokens: response.usage?.output_tokens ?? 0,
	...((response.usage?.input_tokens_details.cached_tokens ?? 0) > 0
		? { cache_read_input_tokens: response.usage?.input_tokens_details.cached_tokens }
		: {}),
})

const messageStart = (response: GenerationResponse): WireValue => ({
	type: "message_start",
	message: {
		id: response.id,
		type: "message",
		role: "assistant",
		model: response.model,
		content: [],
		stop_reason: null,
		stop_sequence: null,
		usage: usage(response),
	},
})

const messageDelta = (
	response: GenerationResponse,
	path: string,
): Result.Result<WireValue, ConversionError> =>
	stopReason(response, path).pipe(
		Result.map((reason) => ({
			type: "message_delta",
			delta: { stop_reason: reason, stop_sequence: null },
			usage: { output_tokens: response.usage?.output_tokens ?? 0 },
		})),
	)

export const encodeResponse = (
	response: GenerationResponse,
): Result.Result<Readonly<Record<string, unknown>>, ConversionError> =>
	Result.gen(function* () {
		const decoded = yield* Schema.decodeUnknownResult(GenerationResponseSchema)(response).pipe(
			Result.mapError((error) => fromSchema(error, "response")),
		)
		if (decoded.error !== null)
			return yield* Result.fail(at("response.error", "invalid", decoded.error.message))
		const content = yield* outputContent(decoded, "response")
		const reason = yield* stopReason(decoded, "response")
		return {
			id: decoded.id,
			type: "message",
			role: "assistant",
			model: decoded.model,
			content,
			stop_reason: reason,
			stop_sequence: null,
			usage: usage(decoded),
		}
	})

type BlockState = Readonly<{
	key: string
	index: number
	itemId: string
	kind: "text" | "refusal" | "tool"
	value: string
	stopped: boolean
	tool: Option.Option<Readonly<{ id: string; name: string }>>
}>
type StreamState = Readonly<{
	identity: Option.Option<Readonly<{ id: string; model: string }>>
	blocks: readonly BlockState[]
	terminal: boolean
}>
type Transition = readonly [StreamState, readonly WireValue[]]

const initial = (): StreamState => ({ identity: Option.none(), blocks: [], terminal: false })
const textKey = (outputIndex: number, contentIndex: number) => `${outputIndex}:${contentIndex}`
const toolKey = (outputIndex: number) => `${outputIndex}:tool`
const outputKey = (key: string): string => key.slice(0, key.indexOf(":"))
const currentBlock = (state: StreamState, key: string) =>
	Option.fromUndefinedOr(state.blocks.find((block) => block.key === key))
const replaceBlock = (state: StreamState, block: BlockState): StreamState => ({
	...state,
	blocks: state.blocks.map((current) => (current.key === block.key ? block : current)),
})

const startText = (
	state: StreamState,
	key: string,
	itemId: string,
	kind: TextValue["kind"],
): Result.Result<Transition, ConversionError> =>
	Result.gen(function* () {
		const existing = currentBlock(state, key)
		if (
			state.blocks.some(
				(block) =>
					(block.itemId === itemId && outputKey(block.key) !== outputKey(key)) ||
					(block.itemId !== itemId && outputKey(block.key) === outputKey(key)),
			)
		)
			return yield* Result.fail(
				at("event.item_id", "invalid", "content block identity changed"),
			)
		if (
			state.blocks.some(
				(block) => block.kind === "tool" && outputKey(block.key) === outputKey(key),
			)
		)
			return yield* Result.fail(
				at("event.output_index", "invalid", "output item kind changed"),
			)
		if (Option.isSome(existing)) {
			if (existing.value.kind !== kind || existing.value.itemId !== itemId)
				return yield* Result.fail(
					at("event.item_id", "invalid", "content block identity changed"),
				)
			return [state, []] as const
		}
		const block: BlockState = {
			key,
			index: state.blocks.length,
			itemId,
			kind,
			value: "",
			stopped: false,
			tool: Option.none(),
		}
		return [
			{ ...state, blocks: [...state.blocks, block] },
			[
				{
					type: "content_block_start",
					index: block.index,
					content_block: { type: "text", text: "" },
				},
			],
		] as const
	})

const startTool = (
	state: StreamState,
	outputIndex: number,
	item: ToolItem,
	path: string,
): Result.Result<Transition, ConversionError> =>
	Result.gen(function* () {
		yield* toolIdentity(item, path)
		const key = toolKey(outputIndex)
		const existing = currentBlock(state, key)
		if (
			state.blocks.some(
				(block) => block.kind !== "tool" && outputKey(block.key) === outputKey(key),
			)
		)
			return yield* Result.fail(at(`${path}.type`, "invalid", "output item kind changed"))
		if (
			state.blocks.some(
				(block) =>
					Option.isSome(block.tool) &&
					block.tool.value.id === item.call_id &&
					block.key !== key,
			)
		)
			return yield* Result.fail(at(`${path}.call_id`, "invalid", "duplicate tool call id"))
		if (state.blocks.some((block) => block.itemId === item.id && block.key !== key))
			return yield* Result.fail(at(`${path}.id`, "invalid", "duplicate output item id"))
		if (Option.isSome(existing)) {
			const tool = existing.value.tool
			if (
				existing.value.itemId !== item.id ||
				Option.isNone(tool) ||
				tool.value.id !== item.call_id ||
				tool.value.name !== item.name
			)
				return yield* Result.fail(at(path, "invalid", "tool call identity changed"))
			return [state, []] as const
		}
		const block: BlockState = {
			key,
			index: state.blocks.length,
			itemId: item.id,
			kind: "tool",
			value: "",
			stopped: false,
			tool: Option.some({ id: item.call_id, name: item.name }),
		}
		return [
			{ ...state, blocks: [...state.blocks, block] },
			[
				{
					type: "content_block_start",
					index: block.index,
					content_block: {
						type: "tool_use",
						id: item.call_id,
						name: item.name,
						input: {},
					},
				},
			],
		] as const
	})

const append = (
	state: StreamState,
	key: string,
	itemId: string,
	value: string,
): Result.Result<Transition, ConversionError> =>
	Result.gen(function* () {
		const block = yield* Result.fromOption(currentBlock(state, key), () =>
			at("event.output_index", "invalid", "delta before content block"),
		)
		if (block.itemId !== itemId)
			return yield* Result.fail(
				at("event.item_id", "invalid", "content block identity changed"),
			)
		if (block.stopped)
			return yield* Result.fail(
				at("event.type", "invalid", "delta after content block stopped"),
			)
		return [
			replaceBlock(state, { ...block, value: block.value + value }),
			value.length === 0
				? []
				: [
						{
							type: "content_block_delta",
							index: block.index,
							delta:
								block.kind === "tool"
									? { type: "input_json_delta", partial_json: value }
									: { type: "text_delta", text: value },
						},
					],
		] as const
	})

const reconcile = (
	state: StreamState,
	key: string,
	itemId: string,
	value: string,
	path: string,
): Result.Result<Transition, ConversionError> =>
	Result.gen(function* () {
		const block = yield* Result.fromOption(currentBlock(state, key), () =>
			at(path, "invalid", "completion before content block"),
		)
		if (block.itemId !== itemId)
			return yield* Result.fail(at(path, "invalid", "content block identity changed"))
		if (!value.startsWith(block.value))
			return yield* Result.fail(at(path, "invalid", "completion changed emitted content"))
		return value.length === block.value.length
			? ([state, []] as const)
			: yield* append(state, key, itemId, value.slice(block.value.length))
	})

const stop = (state: StreamState, key: string): Transition =>
	Option.match(currentBlock(state, key), {
		onNone: () => [state, []] as const,
		onSome: (block) =>
			block.stopped
				? ([state, []] as const)
				: ([
						replaceBlock(state, { ...block, stopped: true }),
						[{ type: "content_block_stop", index: block.index }],
					] as const),
	})

const textSnapshot = (
	state: StreamState,
	outputIndex: number,
	contentIndex: number,
	itemId: string,
	part: OutputContentPart,
	path: string,
	close: boolean,
): Result.Result<Transition, ConversionError> =>
	Result.gen(function* () {
		const value = yield* textValue(part, path)
		const key = textKey(outputIndex, contentIndex)
		const [started, startEvents] = yield* startText(state, key, itemId, value.kind)
		const [updated, deltaEvents] =
			!close && value.value.length === 0
				? ([started, []] as const)
				: yield* reconcile(started, key, itemId, value.value, path)
		const [finished, stopEvents] = close ? stop(updated, key) : ([updated, []] as const)
		return [finished, [...startEvents, ...deltaEvents, ...stopEvents]] as const
	})

const toolSnapshot = (
	state: StreamState,
	outputIndex: number,
	item: ToolItem,
	path: string,
	close: boolean,
): Result.Result<Transition, ConversionError> =>
	Result.gen(function* () {
		const [started, startEvents] = yield* startTool(state, outputIndex, item, path)
		if (!close) {
			if (item.arguments.length === 0) return [started, startEvents] as const
			yield* streamArgumentsObject(item.arguments, `${path}.arguments`)
			const [updated, deltaEvents] = yield* reconcile(
				started,
				toolKey(outputIndex),
				item.id,
				item.arguments,
				`${path}.arguments`,
			)
			return [updated, [...startEvents, ...deltaEvents]] as const
		}
		const [updated, deltaEvents] = yield* reconcile(
			started,
			toolKey(outputIndex),
			item.id,
			item.arguments,
			`${path}.arguments`,
		)
		const [finished, stopEvents] = stop(updated, toolKey(outputIndex))
		return [finished, [...startEvents, ...deltaEvents, ...stopEvents]] as const
	})

const itemSnapshot = (
	state: StreamState,
	outputIndex: number,
	item: GenerationOutputItem | null,
	path: string,
	close: boolean,
): Result.Result<Transition, ConversionError> =>
	Result.gen(function* () {
		if (item?.type === "function_call")
			return yield* toolSnapshot(state, outputIndex, item, path, close)
		if (item?.type !== "message")
			return yield* Result.fail(at(path, "unsupported", "output item"))
		yield* assistant(item, path)
		return yield* item.content.reduce<Result.Result<Transition, ConversionError>>(
			(previous, part, contentIndex) =>
				Result.gen(function* () {
					const [current, events] = yield* previous
					const partPath = `${path}.content[${contentIndex}]`
					if (!close) {
						const value = yield* textValue(part, partPath)
						if (value.value.length === 0) return [current, events] as const
						const [updated, emitted] = yield* textSnapshot(
							current,
							outputIndex,
							contentIndex,
							item.id,
							part,
							partPath,
							false,
						)
						return [updated, [...events, ...emitted]] as const
					}
					const [updated, emitted] = yield* textSnapshot(
						current,
						outputIndex,
						contentIndex,
						item.id,
						part,
						partPath,
						true,
					)
					return [updated, [...events, ...emitted]] as const
				}),
			Result.succeed([state, []] as const),
		)
	})

const validateTerminalOutput = (
	response: GenerationResponse,
	path: string,
): Result.Result<void, ConversionError> =>
	response.status === "completed"
		? outputContent(response, path).pipe(Result.map(() => undefined))
		: response.output.reduce<Result.Result<void, ConversionError>>(
				(previous, item, outputIndex) =>
					Result.gen(function* () {
						yield* previous
						const itemPath = `${path}.output[${outputIndex}]`
						if (item.type === "function_call") {
							yield* toolIdentity(item, itemPath)
							yield* streamArgumentsObject(item.arguments, `${itemPath}.arguments`)
							return
						}
						if (item.type !== "message")
							return yield* Result.fail(at(itemPath, "unsupported", "output item"))
						yield* assistant(item, itemPath)
						yield* item.content.reduce<Result.Result<void, ConversionError>>(
							(content, part, contentIndex) =>
								Result.gen(function* () {
									yield* content
									yield* textValue(part, `${itemPath}.content[${contentIndex}]`)
								}),
							Result.succeed(undefined),
						)
					}),
				Result.succeed(undefined),
			)

const terminal = (
	state: StreamState,
	response: GenerationResponse,
): Result.Result<Transition, ConversionError> =>
	Result.gen(function* () {
		const delta = yield* messageDelta(response, "event.response")
		yield* validateTerminalOutput(response, "event.response")
		const keys = response.output.flatMap((item, outputIndex) =>
			item.type === "message"
				? item.content.map((_part, contentIndex) => textKey(outputIndex, contentIndex))
				: item.type === "function_call"
					? [toolKey(outputIndex)]
					: [],
		)
		if (state.blocks.some((block) => !keys.includes(block.key)))
			return yield* Result.fail(
				at("event.response.output", "invalid", "terminal response omitted emitted content"),
			)
		const [updated, events] = yield* response.output.reduce<
			Result.Result<Transition, ConversionError>
		>(
			(previous, item, outputIndex) =>
				Result.gen(function* () {
					const [current, emitted] = yield* previous
					const [next, values] = yield* itemSnapshot(
						current,
						outputIndex,
						item,
						`event.response.output[${outputIndex}]`,
						true,
					)
					return [next, [...emitted, ...values]] as const
				}),
			Result.succeed([state, []] as const),
		)
		if (updated.blocks.some((block) => !block.stopped))
			return yield* Result.fail(
				at(
					"event.response.output",
					"invalid",
					"terminal response omitted an active content block",
				),
			)
		return [{ ...updated, terminal: true }, [...events, delta]] as const
	})

const transition = (
	state: StreamState,
	event: GenerationEvent,
): Result.Result<Transition, ConversionError> =>
	Result.gen(function* () {
		if (state.terminal)
			return yield* Result.fail(at("event.type", "invalid", "event after terminal response"))
		if (event.type === "error")
			return yield* Result.fail(
				at(event.error.param ?? "event.error", "invalid", event.error.message),
			)
		if (event.type === "response.failed")
			return yield* Result.fail(
				at(
					event.response.status === "failed"
						? "event.response.error"
						: "event.response.status",
					"invalid",
					event.response.status === "failed"
						? (event.response.error?.message ?? "upstream response failed")
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
					at("event.response.id", "invalid", "duplicate response start"),
				)
			return [
				{
					...state,
					identity: Option.some({ id: event.response.id, model: event.response.model }),
				},
				[messageStart(event.response)],
			] as const
		}
		const identity = yield* Result.fromOption(state.identity, () =>
			at("event.type", "invalid", "event before response start"),
		)
		if (
			(event.type === "response.queued" ||
				event.type === "response.in_progress" ||
				event.type === "response.completed" ||
				event.type === "response.incomplete") &&
			(identity.id !== event.response.id || identity.model !== event.response.model)
		)
			return yield* Result.fail(at("event.response", "invalid", "response identity changed"))
		return yield* Match.value(event).pipe(
			Match.whenOr({ type: "response.queued" }, { type: "response.in_progress" }, () =>
				Result.succeed([state, []] as const),
			),
			Match.when({ type: "response.output_item.added" }, (value) =>
				itemSnapshot(state, value.output_index, value.item, "event.item", false),
			),
			Match.when({ type: "response.output_item.done" }, (value) =>
				itemSnapshot(state, value.output_index, value.item, "event.item", true),
			),
			Match.whenOr(
				{ type: "response.content_part.added" },
				{ type: "response.content_part.done" },
				(value) =>
					textSnapshot(
						state,
						value.output_index,
						value.content_index,
						value.item_id,
						value.part,
						"event.part",
						value.type === "response.content_part.done",
					),
			),
			Match.whenOr(
				{ type: "response.output_text.delta" },
				{ type: "response.refusal.delta" },
				(value) =>
					Result.gen(function* () {
						if (
							value.type === "response.output_text.delta" &&
							(value.logprobs?.length ?? 0) > 0
						)
							return yield* Result.fail(
								at("event.logprobs", "unsupported", "text log probabilities"),
							)
						const key = textKey(value.output_index, value.content_index)
						const [started, startEvents] = yield* startText(
							state,
							key,
							value.item_id,
							value.type === "response.refusal.delta" ? "refusal" : "text",
						)
						const [updated, events] = yield* append(
							started,
							key,
							value.item_id,
							value.delta,
						)
						return [updated, [...startEvents, ...events]] as const
					}),
			),
			Match.whenOr(
				{ type: "response.output_text.done" },
				{ type: "response.refusal.done" },
				(value) =>
					Result.gen(function* () {
						if (
							value.type === "response.output_text.done" &&
							(value.logprobs?.length ?? 0) > 0
						)
							return yield* Result.fail(
								at("event.logprobs", "unsupported", "text log probabilities"),
							)
						const key = textKey(value.output_index, value.content_index)
						const [started, events] = yield* startText(
							state,
							key,
							value.item_id,
							value.type === "response.refusal.done" ? "refusal" : "text",
						)
						const [updated, emitted] = yield* reconcile(
							started,
							key,
							value.item_id,
							value.type === "response.refusal.done" ? value.refusal : value.text,
							value.type === "response.refusal.done" ? "event.refusal" : "event.text",
						)
						return [updated, [...events, ...emitted]] as const
					}),
			),
			Match.when({ type: "response.function_call_arguments.delta" }, (value) =>
				append(state, toolKey(value.output_index), value.item_id, value.delta),
			),
			Match.when({ type: "response.function_call_arguments.done" }, (value) =>
				Result.gen(function* () {
					yield* streamArgumentsObject(value.arguments, "event.arguments")
					return yield* reconcile(
						state,
						toolKey(value.output_index),
						value.item_id,
						value.arguments,
						"event.arguments",
					)
				}),
			),
			Match.whenOr({ type: "response.completed" }, { type: "response.incomplete" }, (value) =>
				terminal(state, value.response),
			),
			Match.orElse(() =>
				Result.fail(at("event.type", "unsupported", "event cannot be represented")),
			),
		)
	})

/** Project a fresh Anthropic block lifecycle for each subscriber; HTTP emits message_stop on success. */
export const encodeStream = <E, R>(
	events: Stream.Stream<GenerationEvent, E, R>,
): Stream.Stream<WireValue, E | ConversionError, R> =>
	Stream.concat(
		events.pipe(Stream.map(Option.some)),
		Stream.succeed(Option.none<GenerationEvent>()),
	).pipe(
		Stream.mapAccumEffect(initial, (state, event) =>
			Option.match(event, {
				onNone: () =>
					state.terminal
						? Effect.succeed([state, []] as const)
						: Effect.fail(
								at(
									"event.type",
									"invalid",
									"stream ended without a terminal response",
								),
							),
				onSome: (value) =>
					Schema.decodeUnknownEffect(GenerationEventSchema)(value).pipe(
						Effect.mapError((error) => fromSchema(error, "event")),
						Effect.flatMap((decoded) => Effect.fromResult(transition(state, decoded))),
					),
			}),
		),
	)

const encodeLeaf = (
	event: GenerationEvent,
): Result.Result<Readonly<Record<string, unknown>>, ConversionError> =>
	Match.value(event).pipe(
		Match.when({ type: "response.created" }, (value) =>
			Result.succeed(messageStart(value.response)),
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
			messageDelta(value.response, "event.response"),
		),
		Match.orElse(() =>
			Result.fail(at("event.type", "unsupported", "event cannot be represented")),
		),
	)

/** Encode a leaf event; complete block numbering and lifecycle are provided by encodeStream. */
export const encodeEvent = (
	event: GenerationEvent,
): Result.Result<Readonly<Record<string, unknown>>, ConversionError> =>
	Schema.decodeUnknownResult(GenerationEventSchema)(event).pipe(
		Result.mapError((error) => fromSchema(error, "event")),
		Result.flatMap(encodeLeaf),
	)
