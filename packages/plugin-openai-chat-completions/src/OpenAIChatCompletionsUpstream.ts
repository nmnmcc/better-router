import { Effect, HashMap, Match, Option, Redacted, Result, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ProviderError } from "@better-router/core/Deployment"
import type { Deployment, GenerationExecutor } from "@better-router/core/Deployment"
import type { ProtocolResponse, SelectedRequest } from "@better-router/core/Pipeline"
import type {
	GenerationInputItem,
	GenerationRequest,
	GenerationResponse,
} from "@better-router/core/Generation"
import { fromNative } from "@better-router/core/GenerationEvents"
import type { NativeChunk } from "@better-router/core/GenerationEvents"
import { Request } from "@better-router/core/GenerationSchema"

export interface OpenAIChatCompletionsDeploymentConfig<Id extends string = string> {
	readonly id: Id
	readonly model: string
	readonly apiKey: Redacted.Redacted<string>
	readonly url?: URL
	readonly organization?: string
}

export const DeploymentConfig = Schema.Struct({
	id: Schema.String,
	model: Schema.String,
	apiKey: Schema.Redacted(Schema.String),
	url: Schema.optional(Schema.URL),
	organization: Schema.optional(Schema.String),
})
export class DeploymentError extends Schema.TaggedError<DeploymentError>()("DeploymentError", {
	message: Schema.String,
}) {}

export interface OpenAIChatCompletionsDeployment<Id extends string = string> extends Deployment<
	HttpClient.HttpClient,
	Id,
	"openai",
	"openai.chat-completions"
> {
	readonly provider: "openai"
	readonly protocol: "openai.chat-completions"
	readonly execute: {
		readonly http: GenerationExecutor<HttpClient.HttpClient>
		readonly websocket?: never
		readonly direct?: (
			request: SelectedRequest,
		) => Effect.Effect<ProtocolResponse, ProviderError, HttpClient.HttpClient>
	}
}

const fail = (
	kind: ProviderError["kind"],
	message: string,
	retryable = false,
	cause?: unknown,
): ProviderError =>
	ProviderError.make({ kind, message, retryable, ...(cause === undefined ? {} : { cause }) })
const isError = Schema.is(ProviderError)

type ChatTextPart = {
	readonly type: "text"
	readonly text: string
}

type ChatImagePart = {
	readonly type: "image_url"
	readonly image_url: {
		readonly url: string
		readonly detail: "auto" | "low" | "high"
	}
}

type ChatContent = string | readonly (ChatTextPart | ChatImagePart)[]

type ChatFunctionCall = {
	readonly id: string
	readonly type: "function"
	readonly function: {
		readonly name: string
		readonly arguments: string
	}
}

type ChatInstructionMessage = {
	readonly role: "system" | "developer" | "user"
	readonly content: ChatContent
}

type ChatAssistantMessage = {
	readonly role: "assistant"
	readonly content: ChatContent | null
	readonly tool_calls?: readonly ChatFunctionCall[]
}

type ChatToolMessage = {
	readonly role: "tool"
	readonly tool_call_id: string
	readonly content: string | readonly ChatTextPart[]
}

type ChatMessage = ChatInstructionMessage | ChatAssistantMessage | ChatToolMessage

type ChatTool = {
	readonly type: "function"
	readonly function: {
		readonly name: string
		readonly description?: string
		readonly parameters?: Record<string, unknown>
		readonly strict?: boolean
	}
}

/** Translate an OpenResponses request into a single-choice Chat Completions request. */
export function toChatRequest(
	request: GenerationRequest,
): Result.Result<Record<string, unknown>, ProviderError> {
	return Result.gen(function* () {
		const allowed = [
			"model",
			"input",
			"instructions",
			"tools",
			"tool_choice",
			"text",
			"max_output_tokens",
			"temperature",
			"top_p",
			"presence_penalty",
			"frequency_penalty",
			"parallel_tool_calls",
			"stream",
			"store",
			"metadata",
		] as const
		const extra = Object.entries(request).find(
			([key, value]) =>
				value !== undefined && !allowed.includes(key as (typeof allowed)[number]),
		)
		if (extra)
			return yield* Result.fail(
				fail("unsupported", `Cannot map ${extra[0]} to Chat Completions`),
			)
		if (request.store === true)
			return yield* Result.fail(
				fail("unsupported", "Cannot map store: true to Chat Completions"),
			)
		const input: readonly GenerationInputItem[] =
			typeof request.input === "string"
				? [{ type: "message", role: "user", content: request.input }]
				: (request.input ?? [])
		const messageResult = input.reduce<Result.Result<readonly ChatMessage[], ProviderError>>(
			(current, item, index) =>
				Result.gen(function* () {
					const output = yield* current
					const path = `input[${index}]`
					return yield* Match.value(item.type).pipe(
						Match.when(
							"message",
							(): Result.Result<readonly ChatMessage[], ProviderError> =>
								Result.gen(function* () {
									const value = item as Extract<
										typeof item,
										{ readonly type: "message" }
									>
									if (value.status && value.status !== "completed")
										return yield* Result.fail(
											fail(
												"unsupported",
												`Cannot map ${path}.status to Chat Completions`,
											),
										)
									if ("phase" in value && value.phase !== undefined)
										return yield* Result.fail(
											fail(
												"unsupported",
												`Cannot map ${path}.phase to Chat Completions`,
											),
										)
									if (
										value.role !== "user" &&
										value.role !== "assistant" &&
										value.role !== "system" &&
										value.role !== "developer"
									) {
										return yield* Result.fail(
											fail(
												"unsupported",
												`Cannot map ${path}.role to Chat Completions`,
											),
										)
									}
									const content =
										typeof value.content === "string"
											? value.content
											: yield* value.content.reduce<
													Result.Result<
														readonly (ChatTextPart | ChatImagePart)[],
														ProviderError
													>
												>(
													(parts, part, partIndex) =>
														Result.gen(function* () {
															const entries = yield* parts
															const field = `${path}.content[${partIndex}]`
															return yield* Match.value(
																part.type,
															).pipe(
																Match.whenOr(
																	"input_text",
																	"output_text",
																	() => {
																		const text =
																			part as Extract<
																				typeof part,
																				{
																					readonly type:
																						| "input_text"
																						| "output_text"
																				}
																			>
																		if (
																			text.type ===
																				"output_text" &&
																			(text.annotations
																				?.length ??
																				0)
																		) {
																			return Result.fail(
																				fail(
																					"unsupported",
																					`Cannot map ${field}.annotations to Chat Completions`,
																				),
																			)
																		}
																		return Result.succeed([
																			...entries,
																			{
																				type: "text" as const,
																				text: text.text,
																			},
																		])
																	},
																),
																Match.when("input_image", () => {
																	const image = part as Extract<
																		typeof part,
																		{
																			readonly type: "input_image"
																		}
																	>
																	if (value.role !== "user")
																		return Result.fail(
																			fail(
																				"unsupported",
																				`Cannot map ${field} to Chat Completions`,
																			),
																		)
																	if (!image.image_url)
																		return Result.fail(
																			fail(
																				"invalid_request",
																				`Invalid ${field}.image_url`,
																			),
																		)
																	return Result.succeed([
																		...entries,
																		{
																			type: "image_url" as const,
																			image_url: {
																				url: image.image_url,
																				detail:
																					image.detail ??
																					"auto",
																			},
																		},
																	])
																}),
																Match.orElse(() =>
																	Result.fail(
																		fail(
																			"unsupported",
																			`Cannot map ${field} to Chat Completions`,
																		),
																	),
																),
															)
														}),
													Result.succeed([]),
												)
									const message: ChatMessage =
										value.role === "assistant"
											? { role: "assistant", content }
											: { role: value.role, content }
									return [...output, message]
								}),
						),
						Match.when(
							"function_call",
							(): Result.Result<readonly ChatMessage[], ProviderError> =>
								Result.gen(function* () {
									const value = item as Extract<
										typeof item,
										{ readonly type: "function_call" }
									>
									if (value.status && value.status !== "completed")
										return yield* Result.fail(
											fail(
												"unsupported",
												`Cannot map ${path}.status to Chat Completions`,
											),
										)
									const call: ChatFunctionCall = {
										id: value.call_id,
										type: "function",
										function: { name: value.name, arguments: value.arguments },
									}
									const last = output.at(-1)
									return last?.role === "assistant"
										? [
												...output.slice(0, -1),
												{
													...last,
													tool_calls: [...(last.tool_calls ?? []), call],
												},
											]
										: [
												...output,
												{
													role: "assistant" as const,
													content: null,
													tool_calls: [call],
												},
											]
								}),
						),
						Match.when(
							"function_call_output",
							(): Result.Result<readonly ChatMessage[], ProviderError> =>
								Result.gen(function* () {
									const value = item as Extract<
										typeof item,
										{ readonly type: "function_call_output" }
									>
									if (value.status && value.status !== "completed")
										return yield* Result.fail(
											fail(
												"unsupported",
												`Cannot map ${path}.status to Chat Completions`,
											),
										)
									const content =
										typeof value.output === "string"
											? value.output
											: yield* value.output.reduce<
													Result.Result<
														readonly ChatTextPart[],
														ProviderError
													>
												>(
													(parts, part, partIndex) =>
														Result.gen(function* () {
															const entries = yield* parts
															return yield* Match.value(
																part.type,
															).pipe(
																Match.when("input_text", () => {
																	const text = part as Extract<
																		typeof part,
																		{
																			readonly type: "input_text"
																		}
																	>
																	return Result.succeed([
																		...entries,
																		{
																			type: "text" as const,
																			text: text.text,
																		},
																	])
																}),
																Match.orElse(() =>
																	Result.fail(
																		fail(
																			"unsupported",
																			`Cannot map ${path}.output[${partIndex}] to Chat Completions`,
																		),
																	),
																),
															)
														}),
													Result.succeed([]),
												)
									return [
										...output,
										{
											role: "tool" as const,
											tool_call_id: value.call_id,
											content,
										},
									]
								}),
						),
						Match.orElse(() =>
							Result.fail(
								fail("unsupported", `Cannot map ${path}.type to Chat Completions`),
							),
						),
					)
				}),
			Result.succeed(
				(request.instructions
					? [{ role: "system" as const, content: request.instructions }]
					: []) as readonly ChatMessage[],
			),
		)
		const messages = yield* messageResult
		const toolResult = (request.tools ?? []).reduce<
			Result.Result<readonly ChatTool[], ProviderError>
		>(
			(current, tool, index) =>
				Result.gen(function* () {
					const entries = yield* current
					return yield* Match.value(tool.type).pipe(
						Match.when("function", () => {
							const value = tool as Extract<
								typeof tool,
								{ readonly type: "function" }
							>
							return Result.succeed([
								...entries,
								{
									type: "function" as const,
									function: {
										name: value.name,
										...(value.description
											? { description: value.description }
											: {}),
										...(value.parameters
											? { parameters: value.parameters }
											: {}),
										...(value.strict == null ? {} : { strict: value.strict }),
									},
								},
							])
						}),
						Match.orElse(() =>
							Result.fail(
								fail(
									"unsupported",
									`Cannot map tools[${index}] to Chat Completions`,
								),
							),
						),
					)
				}),
			Result.succeed([] as readonly ChatTool[]),
		)
		const tools = yield* toolResult
		const choice = request.tool_choice
		if (choice && typeof choice !== "string")
			yield* Match.value(choice.type).pipe(
				Match.when("function", () => Result.succeed(void 0)),
				Match.orElse(() =>
					Result.fail(fail("unsupported", "Cannot map tool_choice to Chat Completions")),
				),
			)
		const format = request.text?.format
		if (request.text?.verbosity)
			return yield* Result.fail(
				fail("unsupported", "Cannot map text.verbosity to Chat Completions"),
			)
		if (format)
			yield* Match.value(format.type).pipe(
				Match.whenOr("text", "json_schema", () => Result.succeed(void 0)),
				Match.orElse(() =>
					Result.fail(fail("unsupported", "Cannot map text.format to Chat Completions")),
				),
			)
		return {
			model: request.model,
			messages,
			stream: true,
			stream_options: { include_usage: true },
			...(request.tools ? { tools } : {}),
			...(choice
				? {
						tool_choice: Match.value(choice).pipe(
							Match.when(Schema.is(Schema.String), (value) => value),
							Match.when({ type: "function" }, (value) => ({
								type: "function" as const,
								function: { name: value.name },
							})),
							Match.orElse(() => "auto" as const),
						),
					}
				: {}),
			...(format
				? {
						response_format: Match.value(format).pipe(
							Match.when({ type: "text" }, () => ({ type: "text" as const })),
							Match.when({ type: "json_schema" }, (value) => ({
								type: "json_schema" as const,
								json_schema: {
									name: value.name,
									schema: value.schema,
									strict: value.strict,
									...(value.description
										? { description: value.description }
										: {}),
								},
							})),
							Match.orElse(() => ({ type: "text" as const })),
						),
					}
				: {}),
			...(request.max_output_tokens != null
				? { max_completion_tokens: request.max_output_tokens }
				: {}),
			...Object.fromEntries(
				(
					[
						"temperature",
						"top_p",
						"presence_penalty",
						"frequency_penalty",
						"parallel_tool_calls",
						"metadata",
					] as const
				)
					.filter((key) => request[key] !== undefined && request[key] !== null)
					.map((key) => [key, request[key]]),
			),
		}
	})
}

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const
const fields = <S extends Schema.StructWithRest.Objects>(schema: S) =>
	Schema.StructWithRest(schema, rest)
const ChatChunk = fields(
	Schema.Struct({
		object: Schema.Literal("chat.completion.chunk"),
		id: Schema.String,
		created: Schema.Number,
		model: Schema.String,
		choices: Schema.Array(
			fields(
				Schema.Struct({
					index: Schema.Number,
					delta: fields(
						Schema.Struct({
							role: Schema.optional(Schema.String),
							content: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
							refusal: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
							tool_calls: Schema.optional(
								Schema.Array(
									fields(
										Schema.Struct({
											index: Schema.Number,
											id: Schema.optional(Schema.String),
											type: Schema.optional(Schema.String),
											function: Schema.optional(
												fields(
													Schema.Struct({
														name: Schema.optional(Schema.String),
														arguments: Schema.optional(Schema.String),
													}),
												),
											),
										}),
									),
								),
							),
						}),
					),
					finish_reason: Schema.optional(
						Schema.Union([
							Schema.Literals(["stop", "tool_calls", "length", "content_filter"]),
							Schema.Null,
						]),
					),
				}),
			),
		),
		usage: Schema.optional(
			Schema.Union([
				fields(
					Schema.Struct({
						prompt_tokens: Schema.Number,
						completion_tokens: Schema.Number,
						total_tokens: Schema.Number,
						prompt_tokens_details: Schema.optional(
							fields(
								Schema.Struct({ cached_tokens: Schema.optional(Schema.Number) }),
							),
						),
						completion_tokens_details: Schema.optional(
							fields(
								Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Number) }),
							),
						),
					}),
				),
				Schema.Null,
			]),
		),
	}),
)

const only = (
	value: object,
	path: string,
	allowed: readonly string[],
): Result.Result<void, ProviderError> => {
	const extra = Object.keys(value).find((key) => !allowed.includes(key))
	return extra
		? Result.fail(fail("unsupported", `Cannot map ${path}.${extra} to Chat Completions`))
		: Result.void
}

interface ChunkState {
	readonly identity: Option.Option<string>
	readonly reason: Option.Option<Extract<NativeChunk, { readonly type: "finish" }>>
	readonly usage: Option.Option<NonNullable<GenerationResponse["usage"]>>
	readonly done: boolean
	readonly tools: HashMap.HashMap<number, string>
}

const initial = (): ChunkState => ({
	identity: Option.none(),
	reason: Option.none(),
	usage: Option.none(),
	done: false,
	tools: HashMap.empty(),
})

const toolChunks = (
	state: ChunkState,
	calls: NonNullable<(typeof ChatChunk.Type)["choices"][number]["delta"]["tool_calls"]>,
) =>
	calls.reduce<Result.Result<readonly [ChunkState, readonly NativeChunk[]], ProviderError>>(
		(current, call) =>
			Result.gen(function* () {
				const [previous, output] = yield* current
				yield* only(call, `chunk.choices[0].delta.tool_calls[${call.index}]`, [
					"index",
					"id",
					"type",
					"function",
				])
				if (call.type !== undefined && call.type !== "function")
					return yield* Result.fail(fail("unsupported", "Chat tool call type"))
				if (call.function)
					yield* only(
						call.function,
						`chunk.choices[0].delta.tool_calls[${call.index}].function`,
						["name", "arguments"],
					)
				if (!Number.isInteger(call.index) || call.index < 0)
					return yield* Result.fail(fail("unknown", "Invalid Chat tool index"))
				if (call.id !== undefined && HashMap.has(previous.tools, call.index)) {
					return yield* Result.fail(fail("unknown", "Duplicate Chat tool call"))
				}
				const tools =
					call.id === undefined
						? previous.tools
						: HashMap.set(previous.tools, call.index, call.id)
				const id = yield* Result.fromOption(HashMap.get(tools, call.index), () =>
					fail("unknown", "Chat tool index"),
				)
				if (call.id !== undefined && !call.function?.name)
					return yield* Result.fail(fail("unknown", "Invalid Chat tool name"))
				return [
					{ ...previous, tools },
					[
						...output,
						...(call.id === undefined
							? []
							: [{ type: "tool_start" as const, id, name: call.function!.name! }]),
						...(call.function?.arguments === undefined
							? []
							: [
									{
										type: "tool_delta" as const,
										id,
										value: call.function.arguments,
									},
								]),
					],
				] as const
			}),
		Result.succeed([state, []]),
	)

function transition(
	state: ChunkState,
	entry:
		| { readonly kind: "end" }
		| { readonly kind: "frame"; readonly event: string | undefined; readonly data: string },
): Result.Result<readonly [ChunkState, readonly NativeChunk[]], ProviderError> {
	return Match.value(entry).pipe(
		Match.when({ kind: "end" }, () =>
			Result.gen(function* () {
				if (!state.done)
					return yield* Result.fail(fail("unknown", "Chat stream ended without [DONE]"))
				return [state, []] as const
			}),
		),
		Match.when({ kind: "frame" }, ({ event, data }) =>
			Result.gen(function* () {
				if (event !== "message")
					return yield* Result.fail(fail("unknown", "Unexpected Chat SSE event"))
				if (data === "[DONE]") {
					if (
						state.done ||
						Option.isNone(state.reason) ||
						Option.isNone(state.identity)
					) {
						return yield* Result.fail(
							fail("unknown", "Chat stream ended before its finish reason"),
						)
					}
					return [
						{ ...state, done: true },
						[
							{
								...state.reason.value,
								...Option.match(state.usage, {
									onNone: () => ({}),
									onSome: (usage) => ({ usage }),
								}),
							},
						],
					] as const
				}
				if (state.done)
					return yield* Result.fail(fail("unknown", "Events followed Chat [DONE]"))
				const body = yield* Result.mapError(
					Schema.decodeUnknownResult(Schema.fromJsonString(ChatChunk))(data),
					(error) => fail("unknown", `Invalid Chat SSE chunk: ${error.message}`),
				)
				yield* only(body, "chunk", [
					"object",
					"id",
					"created",
					"model",
					"choices",
					"usage",
					"system_fingerprint",
					"service_tier",
				])
				if (body.usage) {
					yield* only(body.usage, "chunk.usage", [
						"prompt_tokens",
						"completion_tokens",
						"total_tokens",
						"prompt_tokens_details",
						"completion_tokens_details",
					])
					if (body.usage.prompt_tokens_details)
						yield* only(
							body.usage.prompt_tokens_details,
							"chunk.usage.prompt_tokens_details",
							["cached_tokens"],
						)
					if (body.usage.completion_tokens_details)
						yield* only(
							body.usage.completion_tokens_details,
							"chunk.usage.completion_tokens_details",
							["reasoning_tokens"],
						)
				}
				if (body.choices.length === 0) {
					const usage = body.usage
						? Option.some({
								input_tokens: body.usage.prompt_tokens,
								output_tokens: body.usage.completion_tokens,
								total_tokens: body.usage.total_tokens,
								input_tokens_details: {
									cached_tokens:
										body.usage.prompt_tokens_details?.cached_tokens ?? 0,
								},
								output_tokens_details: {
									reasoning_tokens:
										body.usage.completion_tokens_details?.reasoning_tokens ?? 0,
								},
							})
						: state.usage
					return [{ ...state, usage }, []] as const
				}
				if (body.choices.length !== 1 || body.choices[0].index !== 0) {
					return yield* Result.fail(
						fail("unsupported", "Multiple Chat choices are not portable"),
					)
				}
				if (Option.isSome(state.identity) && state.identity.value !== body.id) {
					return yield* Result.fail(fail("unknown", "Chat response identity changed"))
				}
				const first = Option.isNone(state.identity)
				const choice = body.choices[0]
				yield* only(choice, "chunk.choices[0]", ["index", "delta", "finish_reason"])
				yield* only(choice.delta, "chunk.choices[0].delta", [
					"role",
					"content",
					"refusal",
					"tool_calls",
				])
				if (choice.delta.role !== undefined && choice.delta.role !== "assistant") {
					return yield* Result.fail(
						fail("unsupported", "Chat delta role is not assistant"),
					)
				}
				if (choice.delta.refusal)
					return yield* Result.fail(
						fail("unsupported", "Chat refusal delta requires a portable mapping"),
					)
				const [withTools, toolEvents] = yield* toolChunks(
					state,
					choice.delta.tool_calls ?? [],
				)
				if (choice.finish_reason && Option.isSome(state.reason))
					return yield* Result.fail(fail("unknown", "Duplicate Chat finish reason"))
				const reason: ChunkState["reason"] =
					choice.finish_reason === null || choice.finish_reason === undefined
						? state.reason
						: Option.some({ type: "finish" as const, reason: choice.finish_reason })
				return [
					{
						...withTools,
						identity: Option.some(body.id),
						reason,
					},
					[
						...(first
							? [
									{
										type: "start" as const,
										id: body.id,
										createdAt: body.created,
										model: body.model,
									},
								]
							: []),
						...(choice.delta.content == null
							? []
							: [{ type: "text" as const, value: choice.delta.content }]),
						...toolEvents,
					],
				] as const
			}),
		),
		Match.orElse(() => Result.fail(fail("unknown", "Unexpected Chat stream entry"))),
	)
}

function chunks(
	bytes: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<NativeChunk, ProviderError> {
	const frames = bytes.pipe(
		Stream.decodeText(),
		Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1024 * 1024 })),
	)
	return Stream.concat(
		Stream.map(frames, (frame) => ({
			kind: "frame" as const,
			event: frame.event,
			data: frame.data,
		})),
		Stream.succeed({ kind: "end" as const }),
	).pipe(
		Stream.mapAccumEffect(initial, (state, entry) =>
			Effect.fromResult(transition(state, entry)),
		),
		Stream.mapError((cause): ProviderError =>
			isError(cause)
				? (cause as ProviderError)
				: fail("unknown", "Chat stream failed", false, cause),
		),
	)
}

interface NativeChunkState {
	readonly identity: Option.Option<string>
	readonly finished: boolean
	readonly done: boolean
	readonly pending: readonly Uint8Array[]
}

const initialNativeChunkState = (): NativeChunkState => ({
	identity: Option.none(),
	finished: false,
	done: false,
	pending: [],
})

const nativeChunks = (
	bytes: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<Uint8Array, ProviderError> => {
	const frames = bytes.pipe(
		Stream.decodeText(),
		Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1024 * 1024 })),
	)
	return Stream.concat(
		Stream.map(frames, (frame) => ({ kind: "frame" as const, frame })),
		Stream.succeed({ kind: "end" as const }),
	).pipe(
		Stream.mapAccumEffect(initialNativeChunkState, (state, entry) =>
			Effect.gen(function* () {
				const terminal = yield* Match.value(entry).pipe(
					Match.when({ kind: "end" }, () =>
						state.done
							? Effect.succeed([state, state.pending] as const)
							: Effect.fail(fail("unknown", "Chat stream ended without [DONE]")),
					),
					Match.orElse(() => Effect.succeed(undefined)),
				)
				if (terminal !== undefined) return terminal
				const frame = (entry as Extract<typeof entry, { readonly kind: "frame" }>).frame
				if (state.done)
					return yield* Effect.fail(fail("unknown", "Events followed Chat [DONE]"))
				if (frame.event !== undefined && frame.event !== "message")
					return yield* Effect.fail(fail("unknown", "Unexpected Chat SSE event"))
				if (frame.data === "[DONE]") {
					if (Option.isNone(state.identity) || !state.finished)
						return yield* Effect.fail(
							fail("unknown", "Chat stream ended before its finish reason"),
						)
					const encoded = new TextEncoder().encode(
						Sse.encoder.write({
							_tag: "Event",
							event: frame.event,
							id: frame.id,
							data: frame.data,
						}),
					)
					return [
						{ ...state, done: true, pending: [...state.pending, encoded] },
						[],
					] as const
				}
				const body = yield* Effect.fromResult(
					Result.mapError(
						Schema.decodeUnknownResult(Schema.fromJsonString(ChatChunk))(frame.data),
						(error) =>
							fail(
								"unknown",
								`Invalid Chat SSE chunk: ${error.message}`,
								false,
								error,
							),
					),
				)
				const identity = Option.isNone(state.identity)
					? Option.some(body.id)
					: state.identity
				if (Option.isSome(state.identity) && state.identity.value !== body.id)
					return yield* Effect.fail(fail("unknown", "Chat response identity changed"))
				if (state.finished && body.choices.length > 0)
					return yield* Effect.fail(fail("unknown", "Events followed Chat finish reason"))
				const finished =
					state.finished ||
					body.choices.some(
						(choice) =>
							choice.finish_reason !== null && choice.finish_reason !== undefined,
					)
				const encoded = new TextEncoder().encode(
					Sse.encoder.write({
						_tag: "Event",
						event: frame.event,
						id: frame.id,
						data: frame.data,
					}),
				)
				return finished
					? ([
							{ ...state, identity, finished, pending: [...state.pending, encoded] },
							[],
						] as const)
					: ([{ ...state, identity }, [encoded]] as const)
			}),
		),
		Stream.mapError((cause): ProviderError =>
			isError(cause) ? cause : fail("unknown", "Chat native stream failed", false, cause),
		),
	)
}

const statusError = (status: number): ProviderError =>
	Match.value(status).pipe(
		Match.when(429, () => fail("rate_limited", "Chat upstream rate limited the request", true)),
		Match.whenOr(401, 403, () => fail("unauthorized", "Chat upstream authentication failed")),
		Match.whenOr(408, 504, () => fail("timeout", "Chat upstream request timed out")),
		Match.orElse((value) =>
			value >= 500
				? fail("unavailable", "Chat upstream is unavailable", true)
				: fail("invalid_request", `Chat upstream rejected the request (${value})`),
		),
	)

/** Bind a private Chat Completions model to the router's event interface. */
export function make<const Id extends string>(
	config: OpenAIChatCompletionsDeploymentConfig<Id>,
): Result.Result<OpenAIChatCompletionsDeployment<Id>, DeploymentError> {
	const parsed = Schema.decodeUnknownResult(DeploymentConfig)(config)
	if (Result.isFailure(parsed))
		return Result.fail(DeploymentError.make({ message: parsed.failure.message }))
	const url = parsed.success.url ?? new URL("https://api.openai.com/v1/chat/completions")
	if (url.protocol !== "http:" && url.protocol !== "https:")
		return Result.fail(
			DeploymentError.make({ message: "Chat Completions URL must use HTTP(S)" }),
		)
	return Result.succeed({
		id: config.id,
		provider: "openai",
		protocol: "openai.chat-completions",
		model: parsed.success.model,
		execute: {
			direct: (request) =>
				Effect.gen(function* () {
					const body = yield* Schema.decodeUnknownEffect(
						Schema.Record(Schema.String, Schema.Unknown),
					)(request.body).pipe(
						Effect.mapError((cause) =>
							fail("invalid_request", cause.message, false, cause),
						),
					)
					const client = yield* HttpClient.HttpClient
					const organization = parsed.success.organization
						? HttpClientRequest.setHeader(
								"openai-organization",
								parsed.success.organization,
							)
						: (outgoing: HttpClientRequest.HttpClientRequest) => outgoing
					const outgoing = HttpClientRequest.post(url.toString()).pipe(
						HttpClientRequest.bearerToken(parsed.success.apiKey),
						HttpClientRequest.setHeader("content-type", "application/json"),
						HttpClientRequest.bodyJsonUnsafe({ ...body, model: request.targetModel }),
						organization,
					)
					const response = yield* client
						.execute(outgoing)
						.pipe(
							Effect.mapError((cause) =>
								fail(
									"unavailable",
									"Chat upstream connection failed",
									false,
									cause,
								),
							),
						)
					if (response.status < 200 || response.status >= 300)
						return yield* Effect.fail(statusError(response.status))
					return {
						status: response.status,
						headers: Object.fromEntries(Object.entries(response.headers)),
						body: nativeChunks(response.stream),
					}
				}),
			http: (request) =>
				Effect.gen(function* () {
					const parsedRequest = yield* Schema.decodeUnknownEffect(Request)(request).pipe(
						Effect.mapError((cause) =>
							fail("invalid_request", cause.message, false, cause),
						),
					)
					const body = yield* Effect.fromResult(toChatRequest(parsedRequest))
					const client = yield* HttpClient.HttpClient
					const outgoing = HttpClientRequest.post(url.toString()).pipe(
						HttpClientRequest.bearerToken(parsed.success.apiKey),
						HttpClientRequest.setHeader("content-type", "application/json"),
						HttpClientRequest.bodyJsonUnsafe(body),
						parsed.success.organization
							? HttpClientRequest.setHeader(
									"openai-organization",
									parsed.success.organization,
								)
							: (value: HttpClientRequest.HttpClientRequest) => value,
					)
					const response = yield* client
						.execute(outgoing)
						.pipe(
							Effect.mapError((cause) =>
								fail(
									"unavailable",
									"Chat upstream connection failed",
									false,
									cause,
								),
							),
						)
					if (response.status < 200 || response.status >= 300)
						return yield* Effect.fail(statusError(response.status))
					if (
						!response.headers["content-type"]
							?.toLowerCase()
							.startsWith("text/event-stream")
					) {
						return yield* Effect.fail(fail("unknown", "Expected a Chat event stream"))
					}
					return fromNative(request, chunks(response.stream))
				}),
		},
	})
}
