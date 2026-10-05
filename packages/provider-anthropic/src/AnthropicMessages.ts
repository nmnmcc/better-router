import { Effect, Exit, Match, Redacted, Result, Schema, Scope, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import type {
	GenerationInputItem,
	GenerationRequest,
	JsonObject,
	MessageContentPart,
} from "@better-router/core/Generation"
import * as Generation from "@better-router/core/Generation"
import { Request as RequestSchema } from "@better-router/core/GenerationSchema"
import { Error as ProviderError } from "@better-router/core/Provider"
import * as Capability from "@better-router/core/Capability"
import { fromNative } from "./GenerationAssembler.js"
import type { NativeChunk } from "./GenerationAssembler.js"

export interface Config {
	readonly model: string
	readonly apiKey: Redacted.Redacted<string>
	readonly defaultMaxTokens: number
	readonly url?: URL | undefined
	readonly version?: string | undefined
}

export const ConfigSchema = Schema.Struct({
	model: Schema.NonEmptyString,
	apiKey: Schema.Redacted(Schema.String),
	defaultMaxTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	url: Schema.optional(Schema.URL),
	version: Schema.optional(Schema.String),
})

export class ConfigError extends Schema.TaggedError<ConfigError>()("AnthropicMessagesConfigError", {
	message: Schema.String,
}) {}

export type Request = GenerationRequest
export type Process = Generation.GenerationProcess<ProviderError>

export interface Service {
	readonly generate: (request: Request) => Effect.Effect<Process, ProviderError>
}

export interface EncodedRequest {
	readonly url: string
	readonly method: "POST"
	readonly headers: Readonly<Record<string, string>>
	readonly body: Readonly<Record<string, unknown>>
}

/** Stable endpoint capability; Deployment owns model, credentials, and limits. */
export const capability: Capability.Capability<
	"provider.anthropic.messages",
	"provider",
	"generation"
> = Capability.make({
	id: "provider.anthropic.messages",
	version: 1,
	kind: "provider",
	projections: ["generation"],
	endpoints: [
		{
			id: "messages",
			parameters: [
				"input",
				"instructions",
				"tools",
				"stream",
				"temperature",
				"top_p",
				"max_output_tokens",
			],
			streaming: true,
		},
	],
} as const)

const failure = (
	kind: ProviderError["kind"],
	message: string,
	retryable = false,
	cause?: unknown,
): ProviderError =>
	ProviderError.make({ kind, message, retryable, ...(cause === undefined ? {} : { cause }) })

const validateConfig = (config: Config): Result.Result<Config, ConfigError> =>
	config.url && config.url.protocol !== "http:" && config.url.protocol !== "https:"
		? Result.fail(ConfigError.make({ message: "url must use HTTP(S)" }))
		: Result.succeed(config)

export const classifyStatus = (status: number): ProviderError =>
	Match.value(status).pipe(
		Match.when(429, () => failure("rate_limited", "Anthropic rate limited the request", true)),
		Match.whenOr(401, 403, () => failure("unauthorized", "Anthropic authentication failed")),
		Match.whenOr(408, 504, () => failure("timeout", "Anthropic request timed out", true)),
		Match.orElse((value) =>
			value >= 500
				? failure("unavailable", "Anthropic is unavailable", true)
				: failure("invalid_request", `Anthropic rejected the request (${value})`),
		),
	)

const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const usageSchema = Schema.Struct({
	input_tokens: Schema.optional(nonNegativeInt),
	output_tokens: Schema.optional(nonNegativeInt),
	cache_read_input_tokens: Schema.optional(nonNegativeInt),
	cache_creation_input_tokens: Schema.optional(nonNegativeInt),
})
const stopReasonSchema = Schema.Literals([
	"end_turn",
	"max_tokens",
	"stop_sequence",
	"tool_use",
	"refusal",
])
const messageSchema = Schema.Struct({
	id: Schema.optional(Schema.NonEmptyString),
	model: Schema.optional(Schema.NonEmptyString),
	stop_reason: Schema.optional(Schema.NullOr(stopReasonSchema)),
	usage: Schema.optional(usageSchema),
})
const deltaSchema = Schema.Struct({
	type: Schema.optional(Schema.String),
	text: Schema.optional(Schema.String),
	partial_json: Schema.optional(Schema.String),
	stop_reason: Schema.optional(Schema.NullOr(stopReasonSchema)),
	usage: Schema.optional(usageSchema),
})
const contentBlockSchema = Schema.Struct({
	type: Schema.optional(Schema.String),
	id: Schema.optional(Schema.NonEmptyString),
	name: Schema.optional(Schema.NonEmptyString),
})
const errorSchema = Schema.Struct({
	type: Schema.optional(Schema.String),
	message: Schema.optional(Schema.String),
})
const eventSchema = Schema.Struct({
	type: Schema.String,
	message: Schema.optional(messageSchema),
	index: Schema.optional(nonNegativeInt),
	delta: Schema.optional(deltaSchema),
	content_block: Schema.optional(contentBlockSchema),
	usage: Schema.optional(usageSchema),
	error: Schema.optional(errorSchema),
})

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const recordValue = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	typeof value === "object" && value !== null
		? (value as Readonly<Record<string, unknown>>)
		: undefined

const numberValue = (value: unknown, key: string): number | undefined => {
	const record = recordValue(value)
	return typeof record?.[key] === "number" ? record[key] : undefined
}

const anthropicStopReasons = [
	"end_turn",
	"max_tokens",
	"stop_sequence",
	"tool_use",
	"refusal",
] as const

const isStopReason = (value: string): value is (typeof anthropicStopReasons)[number] =>
	(anthropicStopReasons as readonly string[]).includes(value)

const anthropicEventTypes = [
	"message_start",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
	"message_delta",
	"message_stop",
	"ping",
	"error",
] as const

const isEventType = (value: string): value is (typeof anthropicEventTypes)[number] =>
	(anthropicEventTypes as readonly string[]).includes(value)

const anthropicDeltaTypes = [
	"text_delta",
	"input_json_delta",
	"thinking_delta",
	"signature_delta",
	"citations_delta",
] as const

const isDeltaType = (value: string): value is (typeof anthropicDeltaTypes)[number] =>
	(anthropicDeltaTypes as readonly string[]).includes(value)

/** Decode provider bytes strictly, including an explicit final decoder flush. */
const decodeUtf8 = (bytes: Stream.Stream<Uint8Array, unknown>): Stream.Stream<string, unknown> =>
	Stream.concat(
		Stream.map(bytes, (chunk) => ({ type: "chunk" as const, chunk })),
		Stream.succeed({ type: "end" as const }),
	).pipe(
		Stream.mapAccumEffect(
			() => new TextDecoder("utf-8", { fatal: true }),
			(decoder, entry) =>
				Effect.try({
					try: () =>
						entry.type === "chunk"
							? ([decoder, [decoder.decode(entry.chunk, { stream: true })]] as const)
							: ([decoder, [decoder.decode()]] as const),
					catch: (cause) => cause,
				}),
		),
	)

const streamError = (value: Readonly<Record<string, unknown>> | undefined): ProviderError => {
	const type = text(value?.type)
	const message = text(value?.message) ?? "Anthropic returned a stream error"
	return type === "overloaded_error" || type === "api_error"
		? failure("unavailable", message, true)
		: type === "rate_limit_error"
			? failure("rate_limited", message, true)
			: type === "authentication_error" || type === "permission_error"
				? failure("unauthorized", message)
				: type === "invalid_request_error" || type === "not_found_error"
					? failure("invalid_request", message)
					: failure("unknown", message)
}

type ParserState = {
	readonly started: boolean
	readonly id: string
	readonly model: string
	readonly createdAt: number
	readonly tools: readonly string[]
	readonly blocks: Readonly<Record<string, string>>
	readonly usage: Generation.GenerationResponse["usage"]
	readonly finish: Extract<NativeChunk, { readonly type: "finish" }>["reason"] | undefined
	readonly done: boolean
}

const nativeEvents = (
	bytes: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<NativeChunk, ProviderError> => {
	const frames = decodeUtf8(bytes).pipe(
		Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1024 * 1024 })),
	)
	return Stream.concat(
		Stream.map(frames, (frame) => ({ type: "frame" as const, frame })),
		Stream.succeed({ type: "end" as const }),
	).pipe(
		Stream.mapAccumEffect(
			(): ParserState => ({
				started: false,
				id: "",
				model: "",
				createdAt: 0,
				tools: [],
				blocks: {},
				usage: null,
				finish: undefined,
				done: false,
			}),
			(state, entry) =>
				entry.type === "end"
					? state.done
						? Effect.succeed([state, [] as readonly NativeChunk[]] as const)
						: Effect.fail(
								failure("unknown", "Anthropic stream ended without message_stop"),
							)
					: state.done
						? Effect.fail(
								failure("unknown", "Anthropic emitted an event after message_stop"),
							)
						: Effect.gen(function* () {
								const value = yield* json(entry.frame.data).pipe(
									Effect.mapError((cause) =>
										failure(
											"unknown",
											"Invalid Anthropic SSE JSON",
											false,
											cause,
										),
									),
								)
								const event = yield* Schema.decodeUnknownEffect(eventSchema)(
									value,
								).pipe(
									Effect.mapError((cause) =>
										failure("unknown", "Invalid Anthropic event", false, cause),
									),
								)
								if (!isEventType(event.type))
									return yield* Effect.fail(
										failure(
											"unknown",
											`Unsupported Anthropic event type: ${event.type}`,
										),
									)
								if (event.type === "error")
									return yield* Effect.fail(streamError(event.error))
								if (event.type === "ping")
									return [state, [] as readonly NativeChunk[]] as const
								if (!state.started && event.type !== "message_start")
									return yield* Effect.fail(
										failure(
											"unknown",
											"Anthropic emitted output before message_start",
										),
									)
								if (state.started && event.type === "message_start")
									return yield* Effect.fail(
										failure(
											"unknown",
											"Anthropic emitted duplicate message_start",
										),
									)
								if (event.type === "message_stop")
									return state.finish === undefined
										? yield* Effect.fail(
												failure(
													"unknown",
													"Anthropic message_stop has no stop reason",
												),
											)
										: ([
												{ ...state, done: true },
												[
													{
														type: "finish" as const,
														reason: state.finish,
														...(state.usage === null
															? {}
															: { usage: state.usage }),
													},
												],
											] as const)
								const message = recordValue(event.message)
								const delta = recordValue(event.delta)
								const block = recordValue(event.content_block)
								if (
									event.type === "message_start" &&
									(!text(message?.id) || !text(message?.model))
								)
									return yield* Effect.fail(
										failure(
											"unknown",
											"Anthropic message_start has no identity",
										),
									)
								const identity =
									event.type === "message_start"
										? {
												id: text(message?.id) as string,
												model: text(message?.model) as string,
												createdAt: 0,
											}
										: {
												id: state.id || "anthropic-response",
												model: state.model,
												createdAt: state.createdAt,
											}
								const deltaType = text(delta?.type)
								const textValue = text(delta?.text)
								const partial = text(delta?.partial_json)
								const blockIndex =
									typeof event.index === "number"
										? String(event.index)
										: undefined
								const toolId =
									text(block?.id) ??
									(blockIndex === undefined
										? undefined
										: state.blocks[blockIndex])
								const toolName = text(block?.name)
								const toolStart =
									toolId && !state.tools.includes(toolId)
										? [
												{
													type: "tool_start" as const,
													id: toolId,
													name: toolName ?? "function",
												},
											]
										: []
								const toolDelta =
									partial && toolId
										? [
												{
													type: "tool_delta" as const,
													id: toolId,
													value: partial,
												},
											]
										: []
								const textChunk =
									deltaType === "text_delta" && textValue
										? [{ type: "text" as const, value: textValue }]
										: []
								const stopReason =
									text(delta?.stop_reason) ?? text(message?.stop_reason)
								const usageValue =
									recordValue(event.usage) ??
									recordValue(delta?.usage) ??
									recordValue(message?.usage)
								const initialUsage =
									usageValue === undefined && state.usage === null
										? null
										: (usageValue ?? state.usage)
								const inputTokens =
									numberValue(initialUsage, "input_tokens") ??
									state.usage?.input_tokens ??
									0
								const outputTokens =
									numberValue(initialUsage, "output_tokens") ??
									state.usage?.output_tokens ??
									0
								const cachedTokens =
									numberValue(initialUsage, "cache_read_input_tokens") ??
									state.usage?.input_tokens_details.cached_tokens ??
									0
								const usage = initialUsage
									? {
											input_tokens: inputTokens,
											output_tokens: outputTokens,
											total_tokens: inputTokens + outputTokens,
											input_tokens_details: {
												cached_tokens: cachedTokens,
											},
											output_tokens_details: { reasoning_tokens: 0 },
										}
									: null
								const initial = state.started
									? []
									: ([
											{
												type: "start" as const,
												id: identity.id,
												createdAt: identity.createdAt,
												model: identity.model,
												...(usage === null ? {} : { usage }),
											},
										] satisfies readonly NativeChunk[])
								if (stopReason !== undefined && !isStopReason(stopReason))
									return yield* Effect.fail(
										failure(
											"unknown",
											`Unsupported Anthropic stop reason: ${stopReason}`,
										),
									)
								const blockType = text(block?.type)
								if (
									event.type === "content_block_start" &&
									(event.index === undefined ||
										(blockType !== "text" && blockType !== "tool_use"))
								)
									return yield* Effect.fail(
										failure(
											"unknown",
											"Anthropic content block has an unsupported type",
										),
									)
								if (
									(event.type === "content_block_delta" ||
										event.type === "content_block_stop") &&
									event.index === undefined
								)
									return yield* Effect.fail(
										failure(
											"unknown",
											"Anthropic content block event has no index",
										),
									)
								if (deltaType !== undefined && !isDeltaType(deltaType))
									return yield* Effect.fail(
										failure(
											"unknown",
											`Unsupported Anthropic delta type: ${deltaType}`,
										),
									)
								if (
									event.type === "content_block_delta" &&
									deltaType === "input_json_delta" &&
									toolId === undefined
								)
									return yield* Effect.fail(
										failure(
											"unknown",
											"Anthropic tool delta precedes its tool block",
										),
									)
								if (
									event.type === "content_block_delta" &&
									deltaType === "input_json_delta" &&
									toolId === undefined
								)
									return yield* Effect.fail(
										failure(
											"unknown",
											"Anthropic tool delta precedes its tool block",
										),
									)
								if (
									event.type === "content_block_start" &&
									blockType === "tool_use" &&
									(!toolId || !toolName)
								)
									return yield* Effect.fail(
										failure("unknown", "Anthropic tool block has no identity"),
									)
								const finish =
									stopReason === undefined
										? state.finish
										: stopReason === "max_tokens"
											? ("length" as const)
											: stopReason === "tool_use"
												? ("tool_calls" as const)
												: ("stop" as const)
								return [
									{
										started: true,
										id: identity.id,
										model: identity.model,
										createdAt: identity.createdAt,
										tools:
											toolId && !state.tools.includes(toolId)
												? [...state.tools, toolId]
												: state.tools,
										blocks:
											blockIndex && toolId
												? { ...state.blocks, [blockIndex]: toolId }
												: state.blocks,
										usage,
										finish,
										done: false,
									},
									[...initial, ...toolStart, ...toolDelta, ...textChunk],
								]
							}),
		),
		Stream.mapError((cause) =>
			Schema.is(ProviderError)(cause)
				? cause
				: failure("unknown", "Anthropic stream failed", false, cause),
		),
	) as unknown as Stream.Stream<NativeChunk, ProviderError>
}

type WireMessage = Readonly<Record<string, unknown>>
type RequestBodyError = Readonly<{
	kind: ProviderError["kind"]
	message: string
}>

const bodyError = (kind: RequestBodyError["kind"], message: string): RequestBodyError => ({
	kind,
	message,
})

const jsonObject = Schema.Record(Schema.String, Schema.Json)

const decodeJsonObject = (value: string): Result.Result<JsonObject, RequestBodyError> =>
	Schema.decodeUnknownResult(Schema.fromJsonString(jsonObject))(value).pipe(
		Result.mapError(() =>
			bodyError("invalid_request", "Function call arguments must be a JSON object"),
		),
	)

const dataImage = (value: string): Result.Result<WireMessage, RequestBodyError> => {
	const match = /^data:([^;,]+);base64,(.+)$/.exec(value)
	return match
		? Result.succeed({
				type: "image",
				source: { type: "base64", media_type: match[1], data: match[2] },
			})
		: Result.fail(bodyError("unsupported", "Anthropic requires a valid base64 data image URL"))
}

const contentBlock = (part: MessageContentPart): Result.Result<WireMessage, RequestBodyError> =>
	part.type === "input_text" || part.type === "output_text"
		? Result.succeed({ type: "text", text: part.text })
		: part.type === "input_image" && part.image_url
			? part.image_url.startsWith("data:")
				? dataImage(part.image_url)
				: Result.succeed({ type: "image", source: { type: "url", url: part.image_url } })
			: Result.fail(bodyError("unsupported", `Anthropic cannot represent ${part.type}`))

const contentBlocks = (
	content: string | readonly MessageContentPart[],
): Result.Result<string | readonly WireMessage[], RequestBodyError> =>
	typeof content === "string"
		? Result.succeed(content)
		: content.reduce<Result.Result<readonly WireMessage[], RequestBodyError>>(
				(previous, part) =>
					Result.gen(function* () {
						const values = yield* previous
						return [...values, yield* contentBlock(part)]
					}),
				Result.succeed([]),
			)

const requestMessages = (
	request: Request,
): Result.Result<readonly WireMessage[], RequestBodyError> => {
	const input: readonly GenerationInputItem[] =
		typeof request.input === "string"
			? [{ type: "message", role: "user", content: request.input }]
			: (request.input ?? [])
	return input.reduce<Result.Result<readonly WireMessage[], RequestBodyError>>(
		(previous, item) =>
			Result.gen(function* () {
				const messages = yield* previous
				if (item.type === "message") {
					if (item.role !== "user" && item.role !== "assistant")
						return yield* Result.fail(
							bodyError(
								"unsupported",
								`Anthropic cannot represent ${item.role} messages`,
							),
						)
					return [
						...messages,
						{ role: item.role, content: yield* contentBlocks(item.content) },
					]
				}
				if (item.type === "function_call")
					return [
						...messages,
						{
							role: "assistant",
							content: [
								{
									type: "tool_use",
									id: item.call_id,
									name: item.name,
									input: yield* decodeJsonObject(item.arguments || "{}"),
								},
							],
						},
					]
				if (item.type === "function_call_output")
					return [
						...messages,
						{
							role: "user",
							content: [
								{
									type: "tool_result",
									tool_use_id: item.call_id,
									content:
										typeof item.output === "string"
											? item.output
											: yield* contentBlocks(item.output),
								},
							],
						},
					]
				return yield* Result.fail(
					bodyError("unsupported", `Anthropic cannot represent ${item.type} input`),
				)
			}),
		Result.succeed([]),
	)
}

const requestTools = (request: Request): Result.Result<readonly WireMessage[], RequestBodyError> =>
	(request.tools ?? []).reduce<Result.Result<readonly WireMessage[], RequestBodyError>>(
		(previous, tool) =>
			Result.gen(function* () {
				const tools = yield* previous
				if (tool.type !== "function")
					return yield* Result.fail(
						bodyError("unsupported", `Anthropic cannot represent ${tool.type} tools`),
					)
				return [
					...tools,
					{
						name: tool.name,
						...(tool.description ? { description: tool.description } : {}),
						input_schema: tool.parameters ?? { type: "object" },
					},
				]
			}),
		Result.succeed([]),
	)

const requestToolChoice = (
	request: Request,
): Result.Result<WireMessage | undefined, RequestBodyError> => {
	const choice = request.tool_choice ?? undefined
	if (choice === undefined)
		return request.parallel_tool_calls === false
			? Result.succeed({ type: "auto", disable_parallel_tool_use: true })
			: Result.succeed(undefined)
	if (typeof choice === "string")
		return choice === "none"
			? Result.succeed(undefined)
			: Result.succeed({
					type: choice === "required" ? "any" : "auto",
					...(request.parallel_tool_calls === false
						? { disable_parallel_tool_use: true }
						: {}),
				})
	if (choice.type !== "function")
		return Result.fail(bodyError("unsupported", "Anthropic cannot restrict tools to a list"))
	if (!choice.name)
		return Result.fail(
			bodyError("invalid_request", "Anthropic tool choice requires a tool name"),
		)
	return Result.succeed({
		type: "tool",
		name: choice.name,
		...(request.parallel_tool_calls === false ? { disable_parallel_tool_use: true } : {}),
	})
}

const requestBody = (
	request: Request,
	config: Config,
): Result.Result<Readonly<Record<string, unknown>>, RequestBodyError> =>
	Result.gen(function* () {
		const messages = yield* requestMessages(request)
		const tools = yield* requestTools(request)
		const toolChoice = yield* requestToolChoice(request)
		const format = request.text?.format
		if (format?.type === "json_object")
			return yield* Result.fail(
				bodyError("unsupported", "Anthropic requires a JSON schema for structured output"),
			)
		return {
			model: config.model,
			max_tokens: request.max_output_tokens ?? config.defaultMaxTokens,
			messages,
			stream: true,
			...(request.instructions ? { system: request.instructions } : {}),
			...(request.metadata ? { metadata: request.metadata } : {}),
			...(tools.length ? { tools } : {}),
			...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
			...(format?.type === "json_schema"
				? { output_config: { format: { type: "json_schema", schema: format.schema } } }
				: {}),
			...(request.temperature == null ? {} : { temperature: request.temperature }),
			...(request.top_p == null ? {} : { top_p: request.top_p }),
		}
	})

const portableRequest = (request: Request): Result.Result<Request, ProviderError> =>
	Result.gen(function* () {
		const parsed = yield* Schema.decodeUnknownResult(RequestSchema)(request).pipe(
			Result.mapError((cause) =>
				failure("invalid_request", "Invalid generation request", false, cause),
			),
		)
		if (parsed.previous_response_id)
			return yield* Result.fail(
				failure("unsupported", "Anthropic does not support response continuation"),
			)
		if (parsed.include && parsed.include.length > 0)
			return yield* Result.fail(
				failure("unsupported", "Anthropic does not support response include fields"),
			)
		if (
			parsed.background ||
			parsed.max_tool_calls != null ||
			parsed.reasoning ||
			parsed.safety_identifier ||
			parsed.prompt_cache_key ||
			parsed.truncation ||
			parsed.service_tier ||
			parsed.top_logprobs != null ||
			parsed.presence_penalty != null ||
			parsed.frequency_penalty != null ||
			parsed.store
		)
			return yield* Result.fail(
				failure("unsupported", "Anthropic cannot represent one or more request options"),
			)
		if (parsed.text?.verbosity)
			return yield* Result.fail(
				failure("unsupported", "Anthropic cannot represent text verbosity"),
			)
		if ((parsed.tools ?? []).some((tool) => tool.type === "function" && tool.strict != null))
			return yield* Result.fail(
				failure("unsupported", "Anthropic does not support function tool strictness"),
			)
		if (parsed.temperature != null && (parsed.temperature < 0 || parsed.temperature > 1))
			return yield* Result.fail(
				failure("invalid_request", "Anthropic temperature must be between 0 and 1"),
			)
		if (parsed.top_p != null && (parsed.top_p < 0 || parsed.top_p > 1))
			return yield* Result.fail(
				failure("invalid_request", "Anthropic top_p must be between 0 and 1"),
			)
		return parsed
	})

const generate = (
	client: HttpClient.HttpClient,
	config: Config,
	request: Request,
): Effect.Effect<Process, ProviderError> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const requestScope = yield* Scope.make()
			return yield* restore(
				Effect.gen(function* () {
					const parsed = yield* Effect.fromResult(portableRequest(request))
					const body = yield* Effect.fromResult(requestBody(parsed, config)).pipe(
						Effect.mapError((error) => failure(error.kind, error.message)),
					)
					const version = HttpClientRequest.setHeader(
						"anthropic-version",
						config.version ?? "2023-06-01",
					)
					const outgoing = HttpClientRequest.post(
						(config.url ?? new URL("https://api.anthropic.com/v1/messages")).toString(),
					).pipe(
						HttpClientRequest.setHeader("x-api-key", Redacted.value(config.apiKey)),
						HttpClientRequest.setHeader("content-type", "application/json"),
						HttpClientRequest.bodyJsonUnsafe(body),
						version,
					)
					const response = yield* HttpClient.withScope(client)
						.execute(outgoing)
						.pipe(
							Scope.provide(requestScope),
							Effect.mapError((cause) =>
								failure("unavailable", "Anthropic connection failed", true, cause),
							),
						)
					if (response.status < 200 || response.status >= 300)
						return yield* Effect.fail(classifyStatus(response.status))
					const contentType = response.headers["content-type"]?.toLowerCase() ?? ""
					if (!contentType.startsWith("text/event-stream"))
						return yield* Effect.fail(
							failure("unsupported", "Anthropic provider requires an event stream"),
						)
					const process = yield* Generation.Process.make(
						fromNative(parsed, nativeEvents(response.stream)).pipe(
							Stream.onExit((exit) => Scope.close(requestScope, exit)),
						),
					)
					return {
						...process,
						cancel: process.cancel.pipe(
							Effect.andThen(Scope.close(requestScope, Exit.void)),
						),
					}
				}),
			).pipe(
				Effect.onExit((exit) =>
					Exit.isFailure(exit) ? Scope.close(requestScope, exit) : Effect.void,
				),
			)
		}),
	)

/** Build an executor scoped to one deployment, without a singleton Context service. */
export const makeService = (config: Config, client: HttpClient.HttpClient): Service => ({
	generate: (request) => generate(client, config, request),
})

/** Pure request encoding used by transports and contract inspection tools. */
export const encodeRequest = (
	config: Config,
	request: Request,
): Result.Result<EncodedRequest, ProviderError> =>
	portableRequest(request).pipe(
		Result.flatMap((parsed) =>
			requestBody(parsed, config).pipe(
				Result.mapError((cause) => failure(cause.kind, cause.message)),
				Result.map(
					(body) =>
						({
							url: (
								config.url ?? new URL("https://api.anthropic.com/v1/messages")
							).toString(),
							method: "POST",
							headers: {
								"x-api-key": Redacted.value(config.apiKey),
								"anthropic-version": config.version ?? "2023-06-01",
								"content-type": "application/json",
							},
							body,
						}) satisfies EncodedRequest,
				),
			),
		),
	)

export const make = (config: unknown): Result.Result<Config, ConfigError> =>
	Schema.decodeUnknownResult(ConfigSchema)(config).pipe(
		Result.mapError((cause) => ConfigError.make({ message: cause.message })),
		Result.flatMap(validateConfig),
	)
