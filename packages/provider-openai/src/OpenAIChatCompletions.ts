import {
	Effect,
	Exit,
	HashMap,
	Match,
	Option,
	Redacted,
	Result,
	Schema,
	SchemaIssue,
	Scope,
	Stream,
} from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import type {
	GenerationInputItem,
	GenerationRequest,
	GenerationResponse,
	MessageContentPart,
} from "@better-router/core/Generation"
import * as Generation from "@better-router/core/Generation"
import { Request as RequestSchema } from "@better-router/core/GenerationSchema"
import { Error as ProviderError } from "@better-router/core/Provider"
import * as Capability from "@better-router/core/Capability"
import { fromNative } from "./GenerationAssembler.js"
import type { NativeChunk } from "./GenerationAssembler.js"

type FinishReason = Extract<NativeChunk, { readonly type: "finish" }>["reason"]

export interface Config {
	readonly model: string
	readonly apiKey: Redacted.Redacted<string>
	readonly url?: URL | undefined
	readonly organization?: string | undefined
}

export const ConfigSchema = Schema.Struct({
	model: Schema.NonEmptyString,
	apiKey: Schema.Redacted(Schema.String),
	url: Schema.optional(Schema.URL),
	organization: Schema.optional(Schema.String),
})

export class ConfigError extends Schema.TaggedError<ConfigError>()(
	"OpenAIChatCompletionsConfigError",
	{ message: Schema.String },
) {}

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
	"provider.openai.chat-completions",
	"provider",
	"generation"
> = Capability.make({
	id: "provider.openai.chat-completions",
	version: 1,
	kind: "provider",
	projections: ["generation"],
	endpoints: [
		{
			id: "chat-completions",
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
		Match.when(429, () => failure("rate_limited", "OpenAI rate limited the request", true)),
		Match.whenOr(401, 403, () => failure("unauthorized", "OpenAI authentication failed")),
		Match.whenOr(408, 504, () => failure("timeout", "OpenAI request timed out", true)),
		Match.orElse((value) =>
			value >= 500
				? failure("unavailable", "OpenAI is unavailable", true)
				: failure("invalid_request", `OpenAI rejected the request (${value})`),
		),
	)

const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const usageSchema = Schema.Struct({
	prompt_tokens: NonNegativeInt,
	completion_tokens: NonNegativeInt,
	total_tokens: NonNegativeInt,
	prompt_tokens_details: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				cached_tokens: Schema.optional(NonNegativeInt),
				audio_tokens: Schema.optional(NonNegativeInt),
			}),
		),
	),
	completion_tokens_details: Schema.optional(
		Schema.NullOr(
			Schema.Struct({
				reasoning_tokens: Schema.optional(NonNegativeInt),
				audio_tokens: Schema.optional(NonNegativeInt),
				accepted_prediction_tokens: Schema.optional(NonNegativeInt),
				rejected_prediction_tokens: Schema.optional(NonNegativeInt),
			}),
		),
	),
})
const toolFunctionSchema = Schema.Struct({
	name: Schema.optional(Schema.NonEmptyString),
	arguments: Schema.optional(Schema.String),
})
const toolCallSchema = Schema.Struct({
	index: NonNegativeInt,
	id: Schema.optional(Schema.NonEmptyString),
	type: Schema.optional(Schema.Literal("function")),
	function: toolFunctionSchema,
})
const deltaSchema = Schema.Struct({
	role: Schema.optional(Schema.Literal("assistant")),
	content: Schema.optional(Schema.NullOr(Schema.String)),
	tool_calls: Schema.optional(Schema.Array(toolCallSchema)),
	refusal: Schema.optional(Schema.NullOr(Schema.String)),
	function_call: Schema.optional(toolFunctionSchema),
})
const choiceSchema = Schema.Struct({
	index: Schema.optional(NonNegativeInt),
	delta: deltaSchema,
	finish_reason: Schema.optional(
		Schema.NullOr(Schema.Literals(["stop", "length", "tool_calls", "content_filter"])),
	),
	logprobs: Schema.optional(Schema.Unknown),
})
const chunkSchema = Schema.Struct({
	id: Schema.NonEmptyString,
	created: Schema.Finite,
	model: Schema.NonEmptyString,
	choices: Schema.Array(choiceSchema),
	usage: Schema.optional(Schema.NullOr(usageSchema)),
})

type WireChunk = typeof chunkSchema.Type
type ToolCall = typeof toolCallSchema.Type
type Identity = Readonly<Pick<WireChunk, "id" | "created" | "model">>
type ToolState = {
	readonly indices: HashMap.HashMap<number, string>
	readonly names: HashMap.HashMap<string, string>
}
type ParserState = {
	readonly identity: Option.Option<Identity>
	readonly tools: ToolState
	readonly usage: GenerationResponse["usage"]
	readonly finish: Option.Option<FinishReason>
	readonly postFinishUsage: boolean
	readonly done: boolean
}
type ToolTransition = readonly [ToolState, readonly NativeChunk[]]
type Transition = readonly [ParserState, readonly NativeChunk[]]

const protocolFailure = (
	path: readonly PropertyKey[],
	message: string,
	kind: ProviderError["kind"] = "unknown",
): ProviderError =>
	failure(
		kind,
		message,
		false,
		new Schema.SchemaError(
			new SchemaIssue.Pointer(path, new SchemaIssue.InvalidValue({ message })),
		),
	)

const toolTransition = (
	state: ToolState,
	call: ToolCall,
	position: number,
): Result.Result<ToolTransition, ProviderError> =>
	Result.gen(function* () {
		const path = ["choices", 0, "delta", "tool_calls", position] as const
		const mappedId = HashMap.get(state.indices, call.index)
		if (Option.isSome(mappedId) && call.id !== undefined && mappedId.value !== call.id)
			return yield* Result.fail(
				protocolFailure([...path, "id"], "Chat tool index changed its call id"),
			)
		const id = yield* Result.fromOption(
			Option.orElse(Option.fromUndefinedOr(call.id), () => mappedId),
			() => protocolFailure([...path, "id"], "Chat tool start requires a call id"),
		)
		const knownName = HashMap.get(state.names, id)
		if (Option.isNone(mappedId) && Option.isSome(knownName))
			return yield* Result.fail(
				protocolFailure([...path, "index"], "Chat tool call id changed its index"),
			)
		const name = yield* Result.fromOption(
			Option.orElse(Option.fromUndefinedOr(call.function.name), () => knownName),
			() =>
				protocolFailure(
					[...path, "function", "name"],
					"Chat tool start requires a function name",
				),
		)
		if (Option.isSome(knownName) && knownName.value !== name)
			return yield* Result.fail(
				protocolFailure([...path, "function", "name"], "Chat tool function name changed"),
			)
		const start: readonly NativeChunk[] = Option.isSome(knownName)
			? []
			: [{ type: "tool_start", id, name }]
		const delta: readonly NativeChunk[] = Option.match(
			Option.fromUndefinedOr(call.function.arguments),
			{
				onNone: () => [],
				onSome: (value) => [{ type: "tool_delta", id, value }],
			},
		)
		return [
			{
				indices: HashMap.set(state.indices, call.index, id),
				names: HashMap.set(state.names, id, name),
			},
			[...start, ...delta],
		] as const
	})

const usage = (value: typeof usageSchema.Type): GenerationResponse["usage"] => ({
	input_tokens: value.prompt_tokens,
	output_tokens: value.completion_tokens,
	total_tokens: value.total_tokens,
	input_tokens_details: { cached_tokens: value.prompt_tokens_details?.cached_tokens ?? 0 },
	output_tokens_details: {
		reasoning_tokens: value.completion_tokens_details?.reasoning_tokens ?? 0,
	},
})

const chunkTransition = (
	state: ParserState,
	chunk: WireChunk,
): Result.Result<Transition, ProviderError> =>
	Result.gen(function* () {
		if (Option.isSome(state.identity)) {
			const identity = state.identity.value
			const changed = Option.fromUndefinedOr(
				(["id", "created", "model"] as const).find((key) => identity[key] !== chunk[key]),
			)
			if (Option.isSome(changed))
				return yield* Result.fail(
					protocolFailure(
						[changed.value],
						"Chat response identity changed during the stream",
					),
				)
		}
		if (chunk.choices.length > 1)
			return yield* Result.fail(
				protocolFailure(
					["choices"],
					"Chat Completions streaming does not support multiple choices",
					"unsupported",
				),
			)
		const choice = Option.fromUndefinedOr(chunk.choices[0])
		if (Option.isNone(choice)) {
			if (Option.isNone(state.finish))
				return yield* Result.fail(
					protocolFailure(
						["choices"],
						"Chat emitted a usage-only chunk before finishing",
					),
				)
			if (state.postFinishUsage)
				return yield* Result.fail(
					protocolFailure(["usage"], "Chat emitted duplicate usage after finishing"),
				)
			const finalUsage = yield* Result.fromOption(Option.fromNullishOr(chunk.usage), () =>
				protocolFailure(["usage"], "Chat usage-only chunk must carry usage"),
			)
			return [{ ...state, usage: usage(finalUsage), postFinishUsage: true }, []] as const
		}
		if (Option.isSome(state.finish))
			return yield* Result.fail(
				protocolFailure(["choices"], "Chat emitted output after the finish reason"),
			)
		const value = choice.value
		if (value.index !== undefined && value.index !== 0)
			return yield* Result.fail(
				protocolFailure(
					["choices", 0, "index"],
					"Chat Completions streaming requires choice index zero",
					"unsupported",
				),
			)
		if (value.delta.refusal !== undefined && value.delta.refusal !== null)
			return yield* Result.fail(
				protocolFailure(
					["choices", 0, "delta", "refusal"],
					"Chat Completions refusal deltas are not portable",
					"unsupported",
				),
			)
		if (value.delta.function_call !== undefined)
			return yield* Result.fail(
				protocolFailure(
					["choices", 0, "delta", "function_call"],
					"Chat Completions legacy function call deltas are not portable",
					"unsupported",
				),
			)
		if (value.logprobs !== undefined && value.logprobs !== null)
			return yield* Result.fail(
				protocolFailure(
					["choices", 0, "logprobs"],
					"Chat Completions log probability deltas are not portable",
					"unsupported",
				),
			)
		const identity = Option.getOrElse(state.identity, () => ({
			id: chunk.id,
			created: chunk.created,
			model: chunk.model,
		}))
		const initial: readonly NativeChunk[] = Option.isSome(state.identity)
			? []
			: [
					{
						type: "start",
						id: identity.id,
						createdAt: identity.created,
						model: identity.model,
					},
				]
		const text: readonly NativeChunk[] = Option.match(
			Option.fromNullishOr(value.delta.content),
			{
				onNone: () => [],
				onSome: (content) => [{ type: "text", value: content }],
			},
		)
		const [tools, toolOutput] = yield* (value.delta.tool_calls ?? []).reduce<
			Result.Result<ToolTransition, ProviderError>
		>(
			(previous, call, index) =>
				Result.gen(function* () {
					const [current, output] = yield* previous
					const [next, events] = yield* toolTransition(current, call, index)
					return [next, [...output, ...events]] as const
				}),
			Result.succeed([state.tools, []] as const),
		)
		return [
			{
				...state,
				identity: Option.some(identity),
				tools,
				usage: Option.match(Option.fromNullishOr(chunk.usage), {
					onNone: () => state.usage,
					onSome: usage,
				}),
				finish: Option.fromNullishOr(value.finish_reason),
			},
			[...initial, ...text, ...toolOutput],
		] as const
	})

const terminalTransition = (state: ParserState): Result.Result<Transition, ProviderError> =>
	Option.match(state.finish, {
		onNone: () =>
			Result.fail(
				protocolFailure(
					["choices", 0, "finish_reason"],
					"Chat stream ended without a finish reason",
				),
			),
		onSome: (reason) =>
			Result.succeed([
				{ ...state, done: true },
				[
					{
						type: "finish" as const,
						reason,
						...(state.usage === null ? {} : { usage: state.usage }),
					},
				],
			] as const),
	})

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
				identity: Option.none(),
				tools: { indices: HashMap.empty(), names: HashMap.empty() },
				usage: null,
				finish: Option.none(),
				postFinishUsage: false,
				done: false,
			}),
			(state, entry): Effect.Effect<Transition, ProviderError> =>
				entry.type === "end"
					? state.done
						? Effect.succeed([state, []] as const)
						: Effect.fromResult(terminalTransition(state))
					: state.done
						? Effect.fail(protocolFailure([], "Chat emitted data after [DONE]"))
						: entry.frame.data === "[DONE]"
							? Effect.fromResult(terminalTransition(state))
							: Effect.gen(function* () {
									const value = yield* json(entry.frame.data).pipe(
										Effect.mapError((cause) =>
											failure(
												"unknown",
												"Invalid Chat Completions SSE JSON",
												false,
												cause,
											),
										),
									)
									const chunk = yield* Schema.decodeUnknownEffect(chunkSchema)(
										value,
									).pipe(
										Effect.mapError((cause) =>
											failure(
												"unknown",
												"Invalid Chat Completions chunk",
												false,
												cause,
											),
										),
									)
									return yield* Effect.fromResult(chunkTransition(state, chunk))
								}),
		),
		Stream.mapError((cause) =>
			Schema.is(ProviderError)(cause)
				? cause
				: failure("unknown", "Chat Completions stream failed", false, cause),
		),
	)
}
type WireMessage = Readonly<Record<string, unknown>>

const messageContent = (
	content: string | readonly MessageContentPart[],
): string | readonly WireMessage[] =>
	typeof content === "string"
		? content
		: content.flatMap<WireMessage>((part): readonly WireMessage[] =>
				part.type === "input_text" || part.type === "output_text"
					? [{ type: "text", text: part.text }]
					: part.type === "input_image" && part.image_url
						? [
								{
									type: "image_url",
									image_url: {
										url: part.image_url,
										...(part.detail ? { detail: part.detail } : {}),
									},
								},
							]
						: [],
			)

const requestMessages = (request: Request): readonly WireMessage[] => {
	const input: readonly GenerationInputItem[] =
		typeof request.input === "string"
			? [{ type: "message", role: "user", content: request.input }]
			: (request.input ?? [])
	return [
		...(request.instructions ? [{ role: "system", content: request.instructions }] : []),
		...input.flatMap<WireMessage>((item): readonly WireMessage[] =>
			item.type === "message"
				? [{ role: item.role, content: messageContent(item.content) }]
				: item.type === "function_call"
					? [
							{
								role: "assistant",
								content: null,
								tool_calls: [
									{
										id: item.call_id,
										type: "function",
										function: { name: item.name, arguments: item.arguments },
									},
								],
							},
						]
					: item.type === "function_call_output"
						? [
								{
									role: "tool",
									tool_call_id: item.call_id,
									content:
										typeof item.output === "string"
											? item.output
											: JSON.stringify(item.output),
								},
							]
						: [],
		),
	]
}

const requestTools = (request: Request): readonly WireMessage[] =>
	(request.tools ?? []).flatMap((tool) =>
		tool.type === "function"
			? [
					{
						type: "function",
						function: {
							name: tool.name,
							...(tool.description ? { description: tool.description } : {}),
							...(tool.parameters ? { parameters: tool.parameters } : {}),
							...(tool.strict == null ? {} : { strict: tool.strict }),
						},
					},
				]
			: [],
	)

const requestBody = (request: Request): Readonly<Record<string, unknown>> => {
	const choice = request.tool_choice ?? undefined
	return {
		model: request.model,
		messages: requestMessages(request),
		stream: true,
		stream_options: { include_usage: true },
		...(requestTools(request).length ? { tools: requestTools(request) } : {}),
		...(choice === undefined
			? {}
			: {
					tool_choice:
						typeof choice === "string"
							? choice
							: choice.type === "function"
								? { type: "function", function: { name: choice.name } }
								: "auto",
				}),
		...(request.text?.format?.type === "json_schema"
			? {
					response_format: {
						type: "json_schema",
						json_schema: {
							name: request.text.format.name,
							...(request.text.format.description
								? { description: request.text.format.description }
								: {}),
							...(request.text.format.schema
								? { schema: request.text.format.schema }
								: {}),
							...(request.text.format.strict == null
								? {}
								: { strict: request.text.format.strict }),
						},
					},
				}
			: request.text?.format?.type === "json_object"
				? { response_format: { type: "json_object" } }
				: {}),
		...(request.temperature == null ? {} : { temperature: request.temperature }),
		...(request.top_p == null ? {} : { top_p: request.top_p }),
		...(request.max_output_tokens == null ? {} : { max_tokens: request.max_output_tokens }),
		...(request.presence_penalty == null ? {} : { presence_penalty: request.presence_penalty }),
		...(request.frequency_penalty == null
			? {}
			: { frequency_penalty: request.frequency_penalty }),
		...(request.parallel_tool_calls == null
			? {}
			: { parallel_tool_calls: request.parallel_tool_calls }),
		...(request.store == null ? {} : { store: request.store }),
	}
}

const portableRequest = (request: Request): Result.Result<Request, ProviderError> =>
	Result.gen(function* () {
		const parsed = yield* Schema.decodeUnknownResult(RequestSchema)(request).pipe(
			Result.mapError((cause) =>
				failure("invalid_request", "Invalid generation request", false, cause),
			),
		)
		const input = typeof parsed.input === "string" ? [] : (parsed.input ?? [])
		if (
			input.some(
				(item) =>
					item.type !== "message" &&
					item.type !== "function_call" &&
					item.type !== "function_call_output",
			)
		)
			return yield* Result.fail(
				failure("unsupported", "Chat Completions cannot represent this input item"),
			)
		if ((parsed.tools ?? []).some((tool) => tool.type !== "function"))
			return yield* Result.fail(
				failure("unsupported", "Chat Completions cannot represent this tool"),
			)
		if (
			parsed.tool_choice &&
			typeof parsed.tool_choice !== "string" &&
			(parsed.tool_choice.type !== "function" || !parsed.tool_choice.name)
		)
			return yield* Result.fail(
				failure("unsupported", "Chat Completions cannot represent this tool choice"),
			)
		if (parsed.text?.verbosity)
			return yield* Result.fail(
				failure("unsupported", "Chat Completions cannot represent text verbosity"),
			)
		if (
			input.some(
				(item) =>
					item.type === "message" &&
					typeof item.content !== "string" &&
					item.content.some(
						(part) =>
							part.type !== "input_text" &&
							part.type !== "output_text" &&
							(part.type !== "input_image" || !part.image_url),
					),
			)
		)
			return yield* Result.fail(
				failure("unsupported", "Chat Completions cannot represent this message content"),
			)
		if (
			parsed.previous_response_id ||
			(parsed.include && parsed.include.length > 0) ||
			parsed.background ||
			parsed.max_tool_calls != null ||
			parsed.reasoning ||
			parsed.safety_identifier ||
			parsed.prompt_cache_key ||
			parsed.truncation ||
			parsed.service_tier ||
			parsed.top_logprobs != null ||
			parsed.metadata
		)
			return yield* Result.fail(
				failure("unsupported", "Chat Completions cannot represent one or more options"),
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
					const organization = config.organization
						? HttpClientRequest.setHeader("openai-organization", config.organization)
						: (value: HttpClientRequest.HttpClientRequest) => value
					const outgoing = HttpClientRequest.post(
						(
							config.url ?? new URL("https://api.openai.com/v1/chat/completions")
						).toString(),
					).pipe(
						HttpClientRequest.bearerToken(config.apiKey),
						HttpClientRequest.setHeader("content-type", "application/json"),
						HttpClientRequest.bodyJsonUnsafe(
							requestBody({ ...parsed, model: config.model }),
						),
						organization,
					)
					const response = yield* HttpClient.withScope(client)
						.execute(outgoing)
						.pipe(
							Scope.provide(requestScope),
							Effect.mapError((cause) =>
								failure("unavailable", "OpenAI connection failed", true, cause),
							),
						)
					if (response.status < 200 || response.status >= 300)
						return yield* Effect.fail(classifyStatus(response.status))
					const contentType = response.headers["content-type"]?.toLowerCase() ?? ""
					if (!contentType.startsWith("text/event-stream"))
						return yield* Effect.fail(
							failure(
								"unsupported",
								"Chat Completions provider requires an event stream",
							),
						)
					const source = nativeEvents(response.stream)
					const process = yield* Generation.Process.make(
						fromNative(parsed, source).pipe(
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
		Result.map((parsed) => {
			const url = (
				config.url ?? new URL("https://api.openai.com/v1/chat/completions")
			).toString()
			return {
				url,
				method: "POST",
				headers: {
					authorization: `Bearer ${Redacted.value(config.apiKey)}`,
					"content-type": "application/json",
					...(config.organization === undefined
						? {}
						: { "openai-organization": config.organization }),
				},
				body: requestBody({ ...parsed, model: config.model }),
			} satisfies EncodedRequest
		}),
	)

export const make = (config: unknown): Result.Result<Config, ConfigError> =>
	Schema.decodeUnknownResult(ConfigSchema)(config).pipe(
		Result.mapError((cause) => ConfigError.make({ message: cause.message })),
		Result.flatMap(validateConfig),
	)
