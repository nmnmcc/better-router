import { Context, Effect, Layer, Match, Redacted, Result, Schema, Stream } from "effect"
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

export class AnthropicMessages extends Context.Service<AnthropicMessages, Service>()(
	"BetterRouterAnthropicMessages",
) {}

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

const statusError = (status: number): ProviderError =>
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
const record = Schema.Record(Schema.String, Schema.Unknown)
const eventSchema = Schema.Struct({
	type: Schema.String,
	message: Schema.optional(record),
	index: Schema.optional(Schema.Number),
	delta: Schema.optional(record),
	content_block: Schema.optional(record),
	usage: Schema.optional(record),
})

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const recordValue = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	typeof value === "object" && value !== null
		? (value as Readonly<Record<string, unknown>>)
		: undefined

type ParserState = {
	readonly started: boolean
	readonly id: string
	readonly model: string
	readonly createdAt: number
	readonly tools: readonly string[]
	readonly blocks: Readonly<Record<string, string>>
	readonly usage: Generation.GenerationResponse["usage"]
}

const nativeEvents = (
	bytes: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<NativeChunk, ProviderError> => {
	const frames = bytes.pipe(
		Stream.decodeText(),
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
			}),
			(state, entry) =>
				entry.type === "end"
					? Effect.succeed([state, [] as readonly NativeChunk[]] as const)
					: Effect.gen(function* () {
							const value = yield* json(entry.frame.data).pipe(
								Effect.mapError((cause) =>
									failure("unknown", "Invalid Anthropic SSE JSON", false, cause),
								),
							)
							const event = yield* Schema.decodeUnknownEffect(eventSchema)(
								value,
							).pipe(
								Effect.mapError((cause) =>
									failure("unknown", "Invalid Anthropic event", false, cause),
								),
							)
							const message = recordValue(event.message)
							const delta = recordValue(event.delta)
							const block = recordValue(event.content_block)
							const identity =
								event.type === "message_start"
									? {
											id: text(message?.id) ?? "anthropic-response",
											model: text(message?.model) ?? state.model,
											createdAt: 0,
										}
									: {
											id: state.id || "anthropic-response",
											model: state.model,
											createdAt: state.createdAt,
										}
							const initial = state.started
								? []
								: ([
										{
											type: "start" as const,
											id: identity.id,
											createdAt: identity.createdAt,
											model: identity.model,
										},
									] satisfies readonly NativeChunk[])
							const deltaType = text(delta?.type)
							const textValue = text(delta?.text)
							const partial = text(delta?.partial_json)
							const blockIndex =
								typeof event.index === "number" ? String(event.index) : undefined
							const toolId =
								text(block?.id) ??
								(blockIndex === undefined ? undefined : state.blocks[blockIndex])
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
									? [{ type: "tool_delta" as const, id: toolId, value: partial }]
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
							const inputTokens =
								usageValue && typeof usageValue.input_tokens === "number"
									? usageValue.input_tokens
									: (state.usage?.input_tokens ?? 0)
							const outputTokens =
								usageValue && typeof usageValue.output_tokens === "number"
									? usageValue.output_tokens
									: (state.usage?.output_tokens ?? 0)
							const usage =
								usageValue || state.usage
									? {
											input_tokens: inputTokens,
											output_tokens: outputTokens,
											total_tokens: inputTokens + outputTokens,
											input_tokens_details: { cached_tokens: 0 },
											output_tokens_details: { reasoning_tokens: 0 },
										}
									: null
							const finish: readonly NativeChunk[] = stopReason
								? [
										{
											type: "finish" as const,
											reason:
												stopReason === "max_tokens"
													? "length"
													: stopReason === "tool_use"
														? "tool_calls"
														: "stop",
											...(usage === null ? {} : { usage }),
										},
									]
								: []
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
								},
								[...initial, ...toolStart, ...toolDelta, ...textChunk, ...finish],
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

const generate = (
	client: HttpClient.HttpClient,
	config: Config,
	request: Request,
): Effect.Effect<Process, ProviderError> =>
	Effect.gen(function* () {
		const parsed = yield* Schema.decodeUnknownEffect(RequestSchema)(request).pipe(
			Effect.mapError((cause) =>
				failure("invalid_request", "Invalid generation request", false, cause),
			),
		)
		if (parsed.previous_response_id)
			return yield* Effect.fail(
				failure("unsupported", "Anthropic does not support response continuation"),
			)
		if (parsed.include && parsed.include.length > 0)
			return yield* Effect.fail(
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
			return yield* Effect.fail(
				failure("unsupported", "Anthropic cannot represent one or more request options"),
			)
		if (parsed.text?.verbosity)
			return yield* Effect.fail(
				failure("unsupported", "Anthropic cannot represent text verbosity"),
			)
		if ((parsed.tools ?? []).some((tool) => tool.type === "function" && tool.strict != null))
			return yield* Effect.fail(
				failure("unsupported", "Anthropic does not support function tool strictness"),
			)
		if (parsed.temperature != null && (parsed.temperature < 0 || parsed.temperature > 1))
			return yield* Effect.fail(
				failure("invalid_request", "Anthropic temperature must be between 0 and 1"),
			)
		if (parsed.top_p != null && (parsed.top_p < 0 || parsed.top_p > 1))
			return yield* Effect.fail(
				failure("invalid_request", "Anthropic top_p must be between 0 and 1"),
			)
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
		const response = yield* client
			.execute(outgoing)
			.pipe(
				Effect.mapError((cause) =>
					failure("unavailable", "Anthropic connection failed", true, cause),
				),
			)
		if (response.status < 200 || response.status >= 300)
			return yield* Effect.fail(statusError(response.status))
		const contentType = response.headers["content-type"]?.toLowerCase() ?? ""
		if (!contentType.startsWith("text/event-stream"))
			return yield* Effect.fail(
				failure("unsupported", "Anthropic provider requires an event stream"),
			)
		return yield* Generation.Process.make(fromNative(parsed, nativeEvents(response.stream)))
	})

export const layer = (
	config: unknown,
): Layer.Layer<AnthropicMessages, ConfigError, HttpClient.HttpClient> =>
	Layer.effect(
		AnthropicMessages,
		Effect.gen(function* () {
			const parsed = yield* Schema.decodeUnknownEffect(ConfigSchema)(config).pipe(
				Effect.mapError((cause) => ConfigError.make({ message: cause.message })),
				Effect.flatMap((value) => Effect.fromResult(validateConfig(value))),
			)
			const client = yield* HttpClient.HttpClient
			return { generate: (request: Request) => generate(client, parsed, request) }
		}),
	)

export const make = (config: unknown): Result.Result<Config, ConfigError> =>
	Schema.decodeUnknownResult(ConfigSchema)(config).pipe(
		Result.mapError((cause) => ConfigError.make({ message: cause.message })),
		Result.flatMap(validateConfig),
	)
