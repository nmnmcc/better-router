import { Effect, Layer, Match, Option, Schema, Stream } from "effect"
import { AiError, LanguageModel, Model, Prompt, Response, Tool } from "effect/ai"
import * as Execution from "./Execution.js"
import type {
	FunctionCallOutputItem,
	GenerationEvent,
	GenerationInputItem,
	GenerationOutputItem,
	GenerationRequest,
	GenerationResponse,
	GenerationTool,
	JsonObject,
	MessageInput,
	MessageContentPart,
	OutputContentPart,
	TextConfig,
} from "./Generation.js"
import { ProviderError } from "./Deployment.js"
import { RouterError, RouterRuntime } from "./Router.js"

const MODULE = "BetterRouter"
const JsonString = Schema.fromJsonString(Schema.Unknown)

type ResponsePart = Response.PartEncoded
type StreamResponsePart = Response.StreamPartEncoded
type InputItems = readonly GenerationInputItem[]

interface ToolCallState {
	readonly id: string
	readonly itemId: string
	readonly name: string
	readonly started: boolean
	readonly ended: boolean
}

interface TextState {
	readonly id: string
	readonly ended: boolean
}

interface StreamState {
	readonly metadata: boolean
	readonly finished: boolean
	readonly text: readonly TextState[]
	readonly reasoning: readonly TextState[]
	readonly tools: readonly ToolCallState[]
}

const initialStreamState = (): StreamState => ({
	metadata: false,
	finished: false,
	text: [],
	reasoning: [],
	tools: [],
})

const aiError = (method: string, reason: AiError.AiErrorReason): AiError.AiError =>
	AiError.make({ module: MODULE, method, reason })

const invalidInput = (method: string, description: string): AiError.AiError =>
	aiError(method, new AiError.InvalidUserInputError({ description }))

const invalidRequest = (method: string, description: string): AiError.AiError =>
	aiError(method, new AiError.InvalidRequestError({ description }))

const invalidOutput = (method: string, description: string): AiError.AiError =>
	aiError(method, new AiError.InvalidOutputError({ description }))

const unknownError = (method: string, description: string): AiError.AiError =>
	aiError(method, new AiError.UnknownError({ description }))

const unsupportedSchema = (method: string, description: string): AiError.AiError =>
	aiError(method, new AiError.UnsupportedSchemaError({ description }))

const toolConfiguration = (
	method: string,
	toolName: string,
	description: string,
): AiError.AiError => aiError(method, new AiError.ToolConfigurationError({ toolName, description }))

const toolResultEncoding = (
	method: string,
	toolName: string,
	toolResult: unknown,
	description: string,
): AiError.AiError =>
	aiError(method, new AiError.ToolResultEncodingError({ toolName, toolResult, description }))

const schemaDescription = (error: Schema.SchemaError): string => error.message

const failWith = <Value>(error: AiError.AiError): Effect.Effect<Value, AiError.AiError> =>
	Effect.fail(error)

const ensurePortableOptions = (
	options: Prompt.ProviderOptions,
	method: string,
	path: string,
): Effect.Effect<void, AiError.AiError> =>
	Object.keys(options).length === 0
		? Effect.void
		: failWith(invalidInput(method, `${path} contains unsupported provider options`))

const encodeJson = (
	value: unknown,
	method: string,
	path: string,
): Effect.Effect<string, AiError.AiError> =>
	Schema.encodeUnknownEffect(JsonString)(value).pipe(
		Effect.mapError((error) => invalidInput(method, `${path}: ${schemaDescription(error)}`)),
	)

const decodeJson = (
	value: string,
	method: string,
	path: string,
): Effect.Effect<unknown, AiError.AiError> =>
	Schema.decodeUnknownEffect(JsonString)(value).pipe(
		Effect.mapError((error) => invalidOutput(method, `${path}: ${schemaDescription(error)}`)),
	)

const flatten = <Value>(groups: readonly (readonly Value[])[]): Value[] =>
	groups.reduce<Value[]>((all, group) => [...all, ...group], [])

const unsupportedPart = (
	method: string,
	path: string,
	part: string,
): Effect.Effect<never, AiError.AiError> =>
	failWith(invalidInput(method, `${path}: ${part} is not portable through Better Router`))

const messageItem = (
	role: MessageInput["role"],
	content: MessageInput["content"],
): MessageInput => ({ type: "message", role, content })

const inputTextPart = (
	part: Prompt.TextPart,
	method: string,
	path: string,
): Effect.Effect<MessageContentPart, AiError.AiError> =>
	ensurePortableOptions(part.options, method, `${path}.options`).pipe(
		Effect.as({ type: "input_text" as const, text: part.text }),
	)

const outputTextPart = (
	part: Prompt.TextPart,
	method: string,
	path: string,
): Effect.Effect<MessageContentPart, AiError.AiError> =>
	ensurePortableOptions(part.options, method, `${path}.options`).pipe(
		Effect.as({ type: "output_text" as const, text: part.text }),
	)

const reasoningInput = (
	part: Prompt.ReasoningPart,
	method: string,
	path: string,
): Effect.Effect<GenerationInputItem, AiError.AiError> =>
	ensurePortableOptions(part.options, method, `${path}.options`).pipe(
		Effect.as({
			type: "reasoning" as const,
			summary: [{ type: "summary_text" as const, text: part.text }],
		}),
	)

const functionCallInput = (
	part: Prompt.ToolCallPart,
	method: string,
	path: string,
): Effect.Effect<GenerationInputItem, AiError.AiError> =>
	Effect.gen(function* () {
		yield* ensurePortableOptions(part.options, method, `${path}.options`)
		const argumentsValue = yield* encodeJson(part.params, method, `${path}.params`)
		return {
			type: "function_call" as const,
			call_id: part.id,
			name: part.name,
			arguments: argumentsValue,
		}
	})

const functionCallOutputInput = (
	part: Prompt.ToolResultPart,
	method: string,
	path: string,
): Effect.Effect<GenerationInputItem, AiError.AiError> =>
	Effect.gen(function* () {
		yield* ensurePortableOptions(part.options, method, `${path}.options`)
		const output = yield* encodeJson(part.result, method, `${path}.result`).pipe(
			Effect.mapError((error) =>
				toolResultEncoding(method, part.name, part.result, error.message),
			),
		)
		return {
			type: "function_call_output" as const,
			call_id: part.id,
			output,
		}
	})

const userMessage = (
	message: Prompt.UserMessage,
	method: string,
	index: number,
): Effect.Effect<readonly GenerationInputItem[], AiError.AiError> =>
	Effect.gen(function* () {
		yield* ensurePortableOptions(message.options, method, `prompt[${index}].options`)
		const content =
			typeof message.content === "string"
				? Effect.succeed<MessageInput["content"]>(message.content)
				: Effect.forEach(message.content, (part, partIndex) =>
						part.type === "text"
							? inputTextPart(part, method, `prompt[${index}].content[${partIndex}]`)
							: unsupportedPart(
									method,
									`prompt[${index}].content[${partIndex}]`,
									"file input",
								),
					)
		return [messageItem("user", yield* content)]
	})

const assistantPart = (
	part: Prompt.AssistantMessagePart,
	method: string,
	path: string,
): Effect.Effect<readonly GenerationInputItem[], AiError.AiError> => {
	if (part.type === "text")
		return outputTextPart(part, method, path).pipe(
			Effect.map((content) => [messageItem("assistant", [content])]),
		)
	if (part.type === "reasoning")
		return reasoningInput(part, method, path).pipe(Effect.map((item) => [item]))
	if (part.type === "tool-call")
		return functionCallInput(part, method, path).pipe(Effect.map((item) => [item]))
	if (part.type === "tool-result")
		return functionCallOutputInput(part, method, path).pipe(Effect.map((item) => [item]))
	return unsupportedPart(method, path, part.type)
}

const assistantMessage = (
	message: Prompt.AssistantMessage,
	method: string,
	index: number,
): Effect.Effect<readonly GenerationInputItem[], AiError.AiError> =>
	Effect.gen(function* () {
		yield* ensurePortableOptions(message.options, method, `prompt[${index}].options`)
		if (typeof message.content === "string") {
			return [messageItem("assistant", [{ type: "output_text", text: message.content }])]
		}
		const groups = yield* Effect.forEach(message.content, (part, partIndex) =>
			assistantPart(part, method, `prompt[${index}].content[${partIndex}]`),
		)
		return flatten(groups)
	})

const toolMessage = (
	message: Prompt.ToolMessage,
	method: string,
	index: number,
): Effect.Effect<readonly GenerationInputItem[], AiError.AiError> =>
	Effect.gen(function* () {
		yield* ensurePortableOptions(message.options, method, `prompt[${index}].options`)
		const groups = yield* Effect.forEach(message.content, (part, partIndex) =>
			part.type === "tool-result"
				? functionCallOutputInput(
						part,
						method,
						`prompt[${index}].content[${partIndex}]`,
					).pipe(Effect.map((item) => [item]))
				: unsupportedPart(method, `prompt[${index}].content[${partIndex}]`, part.type),
		)
		return flatten(groups)
	})

const promptItems = (
	prompt: Prompt.Prompt,
	method: string,
): Effect.Effect<InputItems, AiError.AiError> =>
	Effect.forEach(prompt.content, (message, index) => {
		if (message.role === "system")
			return ensurePortableOptions(message.options, method, `prompt[${index}].options`).pipe(
				Effect.as([messageItem("system", message.content)]),
			)
		if (message.role === "user") return userMessage(message, method, index)
		if (message.role === "assistant") return assistantMessage(message, method, index)
		return toolMessage(message, method, index)
	}).pipe(Effect.map(flatten))

const toolChoice = (
	choice: NonNullable<LanguageModel.ProviderOptions["toolChoice"]>,
): NonNullable<GenerationRequest["tool_choice"]> =>
	typeof choice === "string"
		? choice
		: "tool" in choice
			? { type: "function", name: choice.tool }
			: {
					type: "allowed_tools",
					mode: choice.mode ?? "auto",
					tools: choice.oneOf.map((name) => ({ type: "function" as const, name })),
				}

const toolDefinitions = (
	tools: ReadonlyArray<Tool.Any>,
	method: string,
): Effect.Effect<readonly GenerationTool[], AiError.AiError> =>
	Effect.forEach(tools, (tool): Effect.Effect<GenerationTool, AiError.AiError> => {
		if (Tool.isProviderDefined(tool) || Tool.isDynamic(tool))
			return failWith<GenerationTool>(
				toolConfiguration(
					method,
					tool.name,
					"only user-defined function tools are portable through Better Router",
				),
			)
		const description = Tool.getDescription(tool)
		return Effect.try({
			try: () => Tool.getJsonSchema(tool) as unknown as JsonObject,
			catch: (error) =>
				unsupportedSchema(method, error instanceof Error ? error.message : String(error)),
		}).pipe(
			Effect.map((parameters): GenerationTool => ({
				type: "function" as const,
				name: tool.name,
				...(description === undefined ? {} : { description }),
				parameters,
			})),
		)
	})

const responseFormat = (
	format: LanguageModel.ProviderOptions["responseFormat"],
	method: string,
): Effect.Effect<TextConfig, AiError.AiError> =>
	format.type === "text"
		? Effect.succeed({ format: { type: "text" as const } })
		: Effect.try({
				try: () => Schema.toJsonSchemaDocument(format.schema),
				catch: (error) =>
					unsupportedSchema(
						method,
						error instanceof Error ? error.message : String(error),
					),
			}).pipe(
				Effect.map((schema): TextConfig => ({
					format: {
						type: "json_schema" as const,
						name: format.objectName,
						schema: schema as unknown as JsonObject,
						strict: true,
					},
				})),
			)

const request = (
	alias: string,
	options: LanguageModel.ProviderOptions,
	stream: boolean,
	method: string,
): Effect.Effect<GenerationRequest, AiError.AiError> =>
	Effect.gen(function* () {
		const prompt = options.incrementalPrompt ?? options.prompt
		const input = yield* promptItems(prompt, method)
		const tools = yield* toolDefinitions(options.tools, method)
		const text = yield* responseFormat(options.responseFormat, method)
		return {
			model: alias,
			input,
			stream,
			text,
			tool_choice: toolChoice(options.toolChoice ?? "none"),
			...(tools.length === 0 ? {} : { tools }),
			...(options.previousResponseId === undefined
				? {}
				: { previous_response_id: options.previousResponseId }),
			...(stream ? { stream_options: { include_obfuscation: false } } : {}),
		}
	})

const usage = (response: GenerationResponse): Response.FinishPartEncoded["usage"] =>
	response.usage === null
		? { inputTokens: {}, outputTokens: {} }
		: {
				inputTokens: {
					uncached:
						response.usage.input_tokens -
						response.usage.input_tokens_details.cached_tokens,
					total: response.usage.input_tokens,
					cacheRead: response.usage.input_tokens_details.cached_tokens,
				},
				outputTokens: {
					total: response.usage.output_tokens,
					text:
						response.usage.output_tokens -
						response.usage.output_tokens_details.reasoning_tokens,
					reasoning: response.usage.output_tokens_details.reasoning_tokens,
				},
			}

const finishReason = (
	status: string,
	response: GenerationResponse,
): Response.FinishPartEncoded["reason"] =>
	status === "completed"
		? response.output.some((item) => item.type === "function_call")
			? "tool-calls"
			: "stop"
		: status === "incomplete"
			? response.incomplete_details?.reason === "max_output_tokens"
				? "length"
				: response.incomplete_details?.reason === "content_filter"
					? "content-filter"
					: "other"
			: "error"

const metadataPart = (response: GenerationResponse): Response.ResponseMetadataPartEncoded => ({
	type: "response-metadata",
	id: response.id,
	modelId: response.model,
})

const finishPart = (response: GenerationResponse): Response.FinishPartEncoded => ({
	type: "finish",
	reason: finishReason(response.status, response),
	usage: usage(response),
})

const responseErrorPart = (response: GenerationResponse): readonly StreamResponsePart[] =>
	response.error === null ? [] : [{ type: "error", error: response.error }]

const outputContentPart = (
	part: OutputContentPart,
	method: string,
	path: string,
): Effect.Effect<ResponsePart[], AiError.AiError> => {
	if (part.type === "output_text" || part.type === "text")
		return Effect.succeed([{ type: "text", text: part.text }])
	if (part.type === "summary_text" || part.type === "reasoning_text")
		return Effect.succeed([{ type: "reasoning", text: part.text }])
	return failWith(invalidOutput(method, `${path}: unsupported output content ${part.type}`))
}

const functionCallPart = (
	item: FunctionCallOutputItem,
	method: string,
	path: string,
): Effect.Effect<ResponsePart[], AiError.AiError> =>
	decodeJson(item.arguments, method, `${path}.arguments`).pipe(
		Effect.map((params): ResponsePart[] => [
			{
				type: "tool-call" as const,
				id: item.call_id,
				name: item.name,
				params,
				providerExecuted: false,
			},
		]),
	)

const outputItemParts = (
	item: GenerationOutputItem,
	method: string,
	path: string,
): Effect.Effect<ResponsePart[], AiError.AiError> => {
	if (item.type === "message")
		return Effect.forEach(item.content, (part, index) =>
			outputContentPart(part, method, `${path}.content[${index}]`),
		).pipe(Effect.map(flatten))
	if (item.type === "function_call") return functionCallPart(item, method, path)
	if (item.type === "reasoning")
		return Effect.forEach(item.summary, (part, index) =>
			outputContentPart(part, method, `${path}.summary[${index}]`),
		).pipe(Effect.map(flatten))
	return failWith(invalidOutput(method, `${path}: unsupported output item ${item.type}`))
}

const responseParts = (
	response: GenerationResponse,
	method: string,
): Effect.Effect<ResponsePart[], AiError.AiError> =>
	Effect.forEach(response.output, (item, index) =>
		outputItemParts(item, method, `response.output[${index}]`),
	).pipe(
		Effect.map(flatten),
		Effect.map((parts) => [metadataPart(response), ...parts, finishPart(response)]),
	)

const findText = (entries: readonly TextState[], id: string): Option.Option<TextState> =>
	Option.fromUndefinedOr(entries.find((entry) => entry.id === id))

const streamMetadata = (
	state: StreamState,
	response: GenerationResponse,
): readonly [StreamState, readonly StreamResponsePart[]] =>
	state.metadata ? [state, []] : [{ ...state, metadata: true }, [metadataPart(response)]]

const streamTextStart = (
	state: StreamState,
	id: string,
	reasoning: boolean,
): readonly [StreamState, readonly StreamResponsePart[]] => {
	const entries = reasoning ? state.reasoning : state.text
	return Option.isSome(findText(entries, id))
		? [state, []]
		: [
				{
					...state,
					...(reasoning
						? { reasoning: [...state.reasoning, { id, ended: false }] }
						: { text: [...state.text, { id, ended: false }] }),
				},
				[reasoning ? { type: "reasoning-start", id } : { type: "text-start", id }],
			]
}

const streamTextEnd = (
	state: StreamState,
	id: string,
	reasoning: boolean,
): readonly [StreamState, readonly StreamResponsePart[]] => {
	const entries = reasoning ? state.reasoning : state.text
	const current = findText(entries, id)
	return Option.match(current, {
		onNone: () => {
			const [started, start] = streamTextStart(state, id, reasoning)
			const [ended, end] = streamTextEnd(started, id, reasoning)
			return [ended, [...start, ...end]]
		},
		onSome: (entry) =>
			entry.ended
				? [state, []]
				: [
						{
							...state,
							...(reasoning
								? {
										reasoning: state.reasoning.map((value) =>
											value.id === id ? { ...value, ended: true } : value,
										),
									}
								: {
										text: state.text.map((value) =>
											value.id === id ? { ...value, ended: true } : value,
										),
									}),
						},
						[reasoning ? { type: "reasoning-end", id } : { type: "text-end", id }],
					],
	})
}

const streamToolStart = (
	state: StreamState,
	itemId: string,
	id: string,
	name: string,
): readonly [StreamState, readonly StreamResponsePart[]] => {
	const current = Option.fromUndefinedOr(
		state.tools.find((entry) => entry.itemId === itemId || entry.id === itemId),
	)
	return Option.match(current, {
		onNone: () => [
			{
				...state,
				tools: [...state.tools, { id, itemId, name, started: true, ended: false }],
			},
			[{ type: "tool-params-start", id, name, providerExecuted: false }],
		],
		onSome: (value) =>
			value.started
				? [state, []]
				: [
						{
							...state,
							tools: state.tools.map((entry) =>
								entry.id === id ? { ...entry, started: true } : entry,
							),
						},
						[{ type: "tool-params-start", id, name, providerExecuted: false }],
					],
	})
}

const streamEventParts = (
	state: StreamState,
	event: GenerationEvent,
	method: string,
): Effect.Effect<readonly [StreamState, readonly StreamResponsePart[]], AiError.AiError> => {
	if (state.finished)
		return failWith(invalidOutput(method, "events followed the terminal response"))
	if (
		event.type === "response.created" ||
		event.type === "response.queued" ||
		event.type === "response.in_progress"
	)
		return Effect.succeed(streamMetadata(state, event.response))
	if (
		event.type === "response.completed" ||
		event.type === "response.incomplete" ||
		event.type === "response.failed"
	) {
		const [withMetadata, metadata] = streamMetadata(state, event.response)
		const error = event.type === "response.failed" ? responseErrorPart(event.response) : []
		return Effect.succeed([
			{ ...withMetadata, finished: true },
			[...metadata, ...error, finishPart(event.response)],
		])
	}
	if (event.type === "response.output_item.added" && event.item?.type === "function_call") {
		const [next, parts] = streamToolStart(
			state,
			event.item.id,
			event.item.call_id,
			event.item.name,
		)
		return Effect.succeed([next, parts])
	}
	if (event.type === "response.reasoning_summary_part.added") {
		if (event.part.type === "summary_text" || event.part.type === "reasoning_text")
			return Effect.succeed(
				streamTextStart(state, `${event.item_id}:summary:${event.summary_index}`, true),
			)
		return failWith(invalidOutput(method, `unsupported reasoning part ${event.part.type}`))
	}
	if (event.type === "response.reasoning_summary_part.done") {
		if (event.part.type === "summary_text" || event.part.type === "reasoning_text")
			return Effect.succeed(
				streamTextEnd(state, `${event.item_id}:summary:${event.summary_index}`, true),
			)
		return failWith(invalidOutput(method, `unsupported reasoning part ${event.part.type}`))
	}
	if (event.type === "response.content_part.added") {
		if (event.part.type === "output_text" || event.part.type === "text")
			return Effect.succeed(
				streamTextStart(state, `${event.item_id}:${event.content_index}`, false),
			)
		if (event.part.type === "summary_text" || event.part.type === "reasoning_text")
			return Effect.succeed(
				streamTextStart(state, `${event.item_id}:${event.content_index}`, true),
			)
		return failWith(invalidOutput(method, `unsupported content part ${event.part.type}`))
	}
	if (event.type === "response.content_part.done") {
		if (event.part.type === "output_text" || event.part.type === "text")
			return Effect.succeed(
				streamTextEnd(state, `${event.item_id}:${event.content_index}`, false),
			)
		if (event.part.type === "summary_text" || event.part.type === "reasoning_text")
			return Effect.succeed(
				streamTextEnd(state, `${event.item_id}:${event.content_index}`, true),
			)
		return failWith(invalidOutput(method, `unsupported content part ${event.part.type}`))
	}
	if (event.type === "response.output_text.delta") {
		const id = `${event.item_id}:${event.content_index}`
		const [next, start] = streamTextStart(state, id, false)
		return Effect.succeed([next, [...start, { type: "text-delta", id, delta: event.delta }]])
	}
	if (event.type === "response.output_text.done") {
		const id = `${event.item_id}:${event.content_index}`
		const [next, end] = streamTextEnd(state, id, false)
		return Effect.succeed([next, end])
	}
	if (
		event.type === "response.reasoning.delta" ||
		event.type === "response.reasoning_summary_text.delta"
	) {
		const id =
			event.type === "response.reasoning.delta"
				? `${event.item_id}:${event.content_index}`
				: `${event.item_id}:summary:${event.summary_index}`
		const [next, start] = streamTextStart(state, id, true)
		return Effect.succeed([
			next,
			[...start, { type: "reasoning-delta", id, delta: event.delta }],
		])
	}
	if (
		event.type === "response.reasoning.done" ||
		event.type === "response.reasoning_summary_text.done"
	) {
		const id =
			event.type === "response.reasoning.done"
				? `${event.item_id}:${event.content_index}`
				: `${event.item_id}:summary:${event.summary_index}`
		const [next, end] = streamTextEnd(state, id, true)
		return Effect.succeed([next, end])
	}
	if (event.type === "response.function_call_arguments.delta") {
		const tool = Option.fromUndefinedOr(
			state.tools.find(
				(entry) => entry.itemId === event.item_id || entry.id === event.item_id,
			),
		)
		return Option.match(tool, {
			onNone: () => failWith(invalidOutput(method, `missing function call ${event.item_id}`)),
			onSome: (value) =>
				Effect.succeed([
					state,
					[{ type: "tool-params-delta", id: value.id, delta: event.delta }],
				]),
		})
	}
	if (event.type === "response.function_call_arguments.done") {
		const tool = Option.fromUndefinedOr(
			state.tools.find(
				(entry) => entry.itemId === event.item_id || entry.id === event.item_id,
			),
		)
		return Option.match(tool, {
			onNone: () => failWith(invalidOutput(method, `missing function call ${event.item_id}`)),
			onSome: (value) =>
				value.ended
					? Effect.succeed([state, []])
					: decodeJson(
							event.arguments,
							method,
							`function_call[${event.item_id}].arguments`,
						).pipe(
							Effect.map((params) => [
								{
									...state,
									tools: state.tools.map((entry) =>
										entry.id === value.id ? { ...entry, ended: true } : entry,
									),
								},
								[
									{ type: "tool-params-end", id: value.id },
									{
										type: "tool-call" as const,
										id: value.id,
										name: value.name,
										params,
										providerExecuted: false,
									},
								],
							]),
						),
		})
	}
	if (event.type === "error") return failWith(unknownError(method, event.error.message))
	if (event.type === "response.refusal.delta" || event.type === "response.refusal.done")
		return failWith(invalidOutput(method, "refusal output is not portable through Effect AI"))
	return Effect.succeed([state, []])
}

const responseStream = (
	events: Stream.Stream<GenerationEvent, RouterError>,
	method: string,
): Stream.Stream<StreamResponsePart, AiError.AiError> =>
	Stream.concat(
		events.pipe(Stream.map((event) => ({ type: "event" as const, event }))),
		Stream.succeed({ type: "end" as const }),
	).pipe(
		Stream.mapError((error) =>
			error instanceof Error && "_tag" in error
				? toRouterError(method, error as RouterError)
				: unknownError(method, String(error)),
		),
		Stream.mapAccumEffect(initialStreamState, (state, entry) =>
			entry.type === "end"
				? state.finished
					? Effect.succeed([state, []])
					: failWith(
							invalidOutput(method, "generation ended without a terminal response"),
						)
				: streamEventParts(state, entry.event, method),
		),
	)

const providerErrorReason = (method: string, error: ProviderError): AiError.AiError =>
	Match.value(error.kind).pipe(
		Match.when("rate_limited", () => aiError(method, new AiError.RateLimitError({}))),
		Match.when("unauthorized", () =>
			aiError(
				method,
				new AiError.AuthenticationError({ kind: "Unknown", description: error.message }),
			),
		),
		Match.whenOr("timeout", "unavailable", () =>
			aiError(method, new AiError.InternalProviderError({ description: error.message })),
		),
		Match.whenOr("invalid_request", "unsupported", () => invalidRequest(method, error.message)),
		Match.orElse(() => unknownError(method, error.message)),
	)

const toRouterError = (method: string, error: RouterError): AiError.AiError =>
	error._tag === "ProviderFailed"
		? providerErrorReason(method, error.cause)
		: error._tag === "InvalidResponse"
			? invalidOutput(method, error.message)
			: error._tag === "MiddlewareFailed"
				? unknownError(
						method,
						error.cause instanceof Error ? error.cause.message : String(error.cause),
					)
				: error._tag === "RoutingFailed"
					? unknownError(method, error.cause.message)
					: error._tag === "InvalidRequest"
						? invalidRequest(method, error.message)
						: error._tag === "NoRoute" || error._tag === "NoAvailableDeployment"
							? invalidRequest(
									method,
									`No route is available for model ${error.model}`,
								)
							: invalidRequest(method, `${error._tag}: ${error.model}`)

const invoke = (
	router: RouterRuntime["Service"],
	alias: string,
	options: LanguageModel.ProviderOptions,
	stream: boolean,
	method: string,
): Effect.Effect<Execution.Execution, AiError.AiError> =>
	request(alias, options, stream, method).pipe(
		Effect.flatMap((generation) =>
			router
				.invoke({ type: "generation", request: generation })
				.pipe(Effect.mapError((error) => toRouterError(method, error))),
		),
	)

const languageModel = (
	alias: string,
): Effect.Effect<LanguageModel.LanguageModel, never, RouterRuntime> =>
	Effect.gen(function* () {
		const router = yield* RouterRuntime
		return yield* LanguageModel.make({
			generateText: (options) =>
				invoke(router, alias, options, false, "generateText").pipe(
					Effect.flatMap((execution) =>
						execution.type === "generation"
							? Execution.complete(execution.events).pipe(
									Effect.mapError((error) =>
										toRouterError("generateText", error),
									),
									Effect.flatMap((response) =>
										responseParts(response, "generateText"),
									),
									Effect.ensuring(execution.cancel),
								)
							: failWith<ResponsePart[]>(
									invalidOutput(
										"generateText",
										"Router returned an opaque execution",
									),
								).pipe(Effect.ensuring(execution.cancel)),
					),
				),
			streamText: (options) =>
				Stream.unwrap(
					invoke(router, alias, options, true, "streamText").pipe(
						Effect.map((execution) =>
							execution.type === "generation"
								? responseStream(execution.events, "streamText").pipe(
										Stream.ensuring(execution.cancel),
									)
								: Stream.fail(
										invalidOutput(
											"streamText",
											"Router returned an opaque execution",
										),
									).pipe(Stream.ensuring(execution.cancel)),
						),
					),
				),
		})
	})

/** Exposes a Better Router model through Effect AI's standard provider Layer. */
export const model = <const Alias extends string>(
	alias: Alias,
): Model.Model<"better-router", LanguageModel.LanguageModel, RouterRuntime> =>
	Model.make(
		"better-router",
		alias,
		Layer.effect(LanguageModel.LanguageModel, languageModel(alias)),
	)
