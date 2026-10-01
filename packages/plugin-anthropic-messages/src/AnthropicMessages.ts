import {
	Clock,
	Effect,
	HashMap,
	Match,
	Option,
	Redacted,
	Result,
	Schema,
	Stream,
	Struct,
	Tuple,
} from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ProviderError } from "@better-router/core/Deployment"
import type { Deployment, GenerationExecutor } from "@better-router/core/Deployment"
import type { ProtocolResponse, SelectedRequest } from "@better-router/core/Pipeline"
import type { GenerationInputItem, GenerationRequest } from "@better-router/core/Generation"
import { fromNative } from "@better-router/core/GenerationEvents"
import type { NativeChunk } from "@better-router/core/GenerationEvents"
import { Request } from "@better-router/core/GenerationSchema"
import { fromSchema } from "@better-router/core/Conversion"

export interface AnthropicMessagesDeploymentConfig<Id extends string = string> {
	readonly id: Id
	readonly model: string
	readonly apiKey: Redacted.Redacted<string>
	readonly url?: URL
	readonly defaultMaxTokens: number
	readonly version?: string
}

export const DeploymentConfig = Schema.Struct({
	id: Schema.String,
	model: Schema.String,
	apiKey: Schema.Redacted(Schema.String),
	url: Schema.optional(Schema.URL),
	defaultMaxTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(16)),
	version: Schema.optional(Schema.String),
})
export class DeploymentError extends Schema.TaggedError<DeploymentError>()("DeploymentError", {
	message: Schema.String,
}) {}

export interface AnthropicMessagesDeployment<
	Requirements = never,
	Id extends string = string,
> extends Deployment<Requirements, Id, "anthropic", "anthropic.messages"> {
	readonly provider: "anthropic"
	readonly protocol: "anthropic.messages"
	readonly execute: {
		readonly http: GenerationExecutor<Requirements>
		readonly websocket?: never
		readonly direct?: (
			request: SelectedRequest,
		) => Effect.Effect<ProtocolResponse, ProviderError, Requirements>
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
const rejected = (field: string): ProviderError =>
	fail("unsupported", `Cannot map ${field} to Anthropic Messages`)
const malformed = (field: string): ProviderError => fail("invalid_request", `Invalid ${field}`)

type AnthropicTextBlock = {
	readonly type: "text"
	readonly text: string
}

type AnthropicImageBlock = {
	readonly type: "image"
	readonly source: {
		readonly type: "url" | "base64"
		readonly url?: string
		readonly media_type?: string
		readonly data?: string
	}
}

type AnthropicToolUseBlock = {
	readonly type: "tool_use"
	readonly id: string
	readonly name: string
	readonly input: Readonly<Record<string, unknown>>
}

type AnthropicToolResultBlock = {
	readonly type: "tool_result"
	readonly tool_use_id: string
	readonly content: string | readonly (AnthropicTextBlock | AnthropicImageBlock)[]
}

type AnthropicBlock =
	AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock

type MessageContent =
	| { readonly kind: "string"; readonly value: string }
	| { readonly kind: "blocks"; readonly value: readonly AnthropicBlock[] }

type Message = { readonly role: "user" | "assistant"; readonly content: MessageContent }
type State = { readonly system: Option.Option<string>; readonly messages: readonly Message[] }

type AnthropicTool = {
	readonly name: string
	readonly description: string
	readonly input_schema: Readonly<Record<string, unknown>>
}

function image(url: string, path: string): Result.Result<AnthropicImageBlock, ProviderError> {
	if (url.startsWith("data:")) {
		const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(url)
		return match
			? Result.succeed({
					type: "image",
					source: { type: "base64", media_type: match[1], data: match[2] },
				})
			: Result.fail(malformed(path))
	}
	return /^https?:\/\/\S+$/.test(url)
		? Result.succeed({ type: "image", source: { type: "url", url } })
		: Result.fail(malformed(path))
}

const append = (
	messages: readonly Message[],
	role: Message["role"],
	block: AnthropicBlock,
): readonly Message[] => {
	const last = messages.at(-1)
	const content =
		last?.role === role
			? last.content.kind === "string"
				? [{ type: "text" as const, text: last.content.value }]
				: last.content.value
			: []
	return last?.role === role
		? [
				...messages.slice(0, -1),
				{ ...last, content: { kind: "blocks", value: [...content, block] } },
			]
		: [...messages, { role, content: { kind: "blocks", value: [block] } }]
}

const wireMessage = (message: Message) => ({ role: message.role, content: message.content.value })

type InputMessage = Extract<GenerationInputItem, { readonly type: "message" }>
type FunctionCallInput = Extract<GenerationInputItem, { readonly type: "function_call" }>
type FunctionCallOutputInput = Extract<
	GenerationInputItem,
	{ readonly type: "function_call_output" }
>
type InputMessagePart = Exclude<InputMessage["content"], string>[number]
type Tool = NonNullable<GenerationRequest["tools"]>[number]

const convertMessageParts = (
	parts: readonly InputMessagePart[],
	role: InputMessage["role"],
	path: string,
): Result.Result<readonly AnthropicBlock[], ProviderError> =>
	parts.reduce<Result.Result<readonly AnthropicBlock[], ProviderError>>(
		(previous, part, partIndex) =>
			Result.gen(function* () {
				const entries = yield* previous
				const field = path + ".content[" + partIndex + "]"
				return yield* Match.value(part).pipe(
					Match.when({ type: "input_text" }, (value) => {
						const text = value as Extract<typeof part, { readonly type: "input_text" }>
						return Result.succeed([
							...entries,
							{ type: "text" as const, text: text.text },
						])
					}),
					Match.when({ type: "output_text" }, (value) => {
						const text = value as Extract<typeof part, { readonly type: "output_text" }>
						return (text.annotations?.length ?? 0)
							? Result.fail(rejected(field + ".annotations"))
							: Result.succeed([
									...entries,
									{ type: "text" as const, text: text.text },
								])
					}),
					Match.when({ type: "input_image" }, (value) => {
						const imageValue = value as Extract<
							typeof part,
							{ readonly type: "input_image" }
						>
						if (role !== "user") return Result.fail(rejected(field))
						if (imageValue.detail && imageValue.detail !== "auto")
							return Result.fail(rejected(field + ".detail"))
						if (!imageValue.image_url)
							return Result.fail(malformed(field + ".image_url"))
						return Result.map(image(imageValue.image_url, field), (block) => [
							...entries,
							block,
						])
					}),
					Match.orElse(() => Result.fail(rejected(field))),
				)
			}),
		Result.succeed([]),
	)

const convertToolOutputParts = (
	parts: readonly Exclude<FunctionCallOutputInput["output"], string>[number][],
	path: string,
): Result.Result<readonly (AnthropicTextBlock | AnthropicImageBlock)[], ProviderError> =>
	parts.reduce<
		Result.Result<readonly (AnthropicTextBlock | AnthropicImageBlock)[], ProviderError>
	>(
		(previous, part, partIndex) =>
			Result.gen(function* () {
				const entries = yield* previous
				const field = path + ".output[" + partIndex + "]"
				return yield* Match.value(part).pipe(
					Match.when({ type: "input_text" }, (value) => {
						const text = value as Extract<typeof part, { readonly type: "input_text" }>
						return Result.succeed([
							...entries,
							{ type: "text" as const, text: text.text },
						])
					}),
					Match.when({ type: "input_image" }, (value) => {
						const imageValue = value as Extract<
							typeof part,
							{ readonly type: "input_image" }
						>
						if (imageValue.detail && imageValue.detail !== "auto")
							return Result.fail(rejected(field + ".detail"))
						if (!imageValue.image_url)
							return Result.fail(malformed(field + ".image_url"))
						return Result.map(image(imageValue.image_url, field), (block) => [
							...entries,
							block,
						])
					}),
					Match.orElse(() => Result.fail(rejected(field))),
				)
			}),
		Result.succeed([]),
	)

const toMessagesRequestMatch = (
	request: GenerationRequest,
	defaultMaxTokens: number,
): Result.Result<Record<string, unknown>, ProviderError> =>
	Result.gen(function* () {
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
			"parallel_tool_calls",
			"stream",
			"store",
		] as const
		const extra = Object.entries(request).find(
			([key, value]) =>
				value !== undefined && !allowed.includes(key as (typeof allowed)[number]),
		)
		if (extra) return yield* Result.fail(rejected(extra[0]))
		if (request.store === true) return yield* Result.fail(rejected("store: true"))
		const max = request.max_output_tokens ?? defaultMaxTokens
		if (!Number.isInteger(max) || max < 16)
			return yield* Result.fail(malformed("max_output_tokens"))
		const input: readonly GenerationInputItem[] =
			typeof request.input === "string"
				? [{ type: "message", role: "user", content: request.input }]
				: (request.input ?? [])
		const convertedResult = input.reduce<Result.Result<State, ProviderError>>(
			(previous, item, index) =>
				Result.gen(function* () {
					const state = yield* previous
					const path = "input[" + index + "]"
					return yield* Match.value(item).pipe(
						Match.when({ type: "message" }, (value) => {
							const message = value as InputMessage
							return Result.gen(function* () {
								if (message.status && message.status !== "completed")
									return yield* Result.fail(rejected(path + ".status"))
								if (message.phase !== undefined)
									return yield* Result.fail(rejected(path + ".phase"))
								return yield* Match.value(message.role).pipe(
									Match.when("system", () => {
										if (Option.isSome(state.system))
											return Result.fail(
												rejected("multiple system instructions"),
											)
										return typeof message.content === "string"
											? Result.succeed({
													...state,
													system: Option.some(message.content),
												})
											: Result.fail(rejected(path + ".content"))
									}),
									Match.whenOr("user", "assistant", (role) =>
										Result.gen(function* () {
											if (typeof message.content === "string")
												return {
													...state,
													messages: [
														...state.messages,
														{
															role,
															content: {
																kind: "string" as const,
																value: message.content,
															},
														},
													],
												}
											if (!Array.isArray(message.content))
												return yield* Result.fail(
													malformed(path + ".content"),
												)
											const blocks = yield* convertMessageParts(
												message.content as readonly InputMessagePart[],
												role,
												path,
											)
											return {
												...state,
												messages: [
													...state.messages,
													{
														role,
														content: {
															kind: "blocks" as const,
															value: blocks,
														},
													},
												],
											}
										}),
									),
									Match.orElse(() => Result.fail(rejected(path + ".role"))),
								)
							})
						}),
						Match.when({ type: "function_call" }, (value) => {
							const call = value as FunctionCallInput
							return Result.gen(function* () {
								if (call.status && call.status !== "completed")
									return yield* Result.fail(rejected(path + ".status"))
								const args = yield* Result.mapError(
									Schema.decodeUnknownResult(
										Schema.fromJsonString(
											Schema.Record(Schema.String, Schema.Json),
										),
									)(call.arguments),
									() => malformed(path + ".arguments"),
								)
								return {
									...state,
									messages: append(state.messages, "assistant", {
										type: "tool_use",
										id: call.call_id,
										name: call.name,
										input: args,
									}),
								}
							})
						}),
						Match.when({ type: "function_call_output" }, (value) => {
							const call = value as FunctionCallOutputInput
							return Result.gen(function* () {
								if (call.status && call.status !== "completed")
									return yield* Result.fail(rejected(path + ".status"))
								if (typeof call.output !== "string" && !Array.isArray(call.output))
									return yield* Result.fail(malformed(path + ".output"))
								const content =
									typeof call.output === "string"
										? call.output
										: yield* convertToolOutputParts(call.output, path)
								return {
									...state,
									messages: append(state.messages, "user", {
										type: "tool_result",
										tool_use_id: call.call_id,
										content,
									}),
								}
							})
						}),
						Match.orElse(() => Result.fail(rejected(path + ".type"))),
					)
				}),
			Result.succeed({ system: Option.fromNullishOr(request.instructions), messages: [] }),
		)
		const converted = yield* convertedResult
		const toolsResult = (request.tools ?? []).reduce<
			Result.Result<readonly AnthropicTool[], ProviderError>
		>(
			(previous, tool, index) =>
				Result.gen(function* () {
					const entries = yield* previous
					const path = "tools[" + index + "]"
					return yield* Match.value(tool).pipe(
						Match.when({ type: "function" }, (value) => {
							const functionTool = value as Extract<
								Tool,
								{ readonly type: "function" }
							>
							return functionTool.strict != null
								? Result.fail(rejected(path + ".strict"))
								: Result.succeed([
										...entries,
										{
											name: functionTool.name,
											description: functionTool.description ?? "",
											input_schema: functionTool.parameters ?? {
												type: "object",
											},
										},
									])
						}),
						Match.orElse(() => Result.fail(rejected(path))),
					)
				}),
			Result.succeed([]),
		)
		const tools = yield* toolsResult
		const choice = request.tool_choice ?? "auto"
		if (typeof choice !== "string" && choice.type !== "function")
			return yield* Result.fail(rejected("tool_choice"))
		const format = request.text?.format
		if (request.text?.verbosity) return yield* Result.fail(rejected("text.verbosity"))
		if (format && format.type !== "text" && format.type !== "json_schema")
			return yield* Result.fail(rejected("text.format"))
		if (format?.type === "json_schema" && (format.description || format.strict === false))
			return yield* Result.fail(rejected("text.format.description/strict"))
		return {
			model: request.model,
			max_tokens: max,
			messages: converted.messages.map(wireMessage),
			stream: true,
			...Option.match(converted.system, {
				onNone: () => ({}),
				onSome: (system) => ({ system }),
			}),
			...(request.tools ? { tools } : {}),
			...(request.tool_choice || request.parallel_tool_calls === false
				? {
						tool_choice: {
							...(typeof choice === "string"
								? { type: choice === "required" ? "any" : choice }
								: { type: "tool", name: choice.name }),
							...(request.parallel_tool_calls === false
								? { disable_parallel_tool_use: true }
								: {}),
						},
					}
				: {}),
			...(format?.type === "json_schema"
				? { output_config: { format: { type: "json_schema", schema: format.schema } } }
				: {}),
			...(request.temperature == null ? {} : { temperature: request.temperature }),
			...(request.top_p == null ? {} : { top_p: request.top_p }),
		}
	})

/** Convert portable OpenResponses input into a stateless Anthropic Messages request. */
export function toMessagesRequest(
	request: GenerationRequest,
	defaultMaxTokens: number,
): Result.Result<Record<string, unknown>, ProviderError> {
	return toMessagesRequestMatch(request, defaultMaxTokens)
}

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const
interface Fields extends Struct.Lambda {
	<S extends Schema.StructWithRest.Objects>(schema: S): Schema.StructWithRest<S, typeof rest>
	readonly "~lambda.out": this["~lambda.in"] extends Schema.StructWithRest.Objects
		? Schema.StructWithRest<this["~lambda.in"], typeof rest>
		: never
}
const fields = Struct.lambda<Fields>((schema) => Schema.StructWithRest(schema, rest))
const tokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const usage = fields(
	Schema.Struct({
		input_tokens: Schema.optional(tokenCount),
		output_tokens: Schema.optional(tokenCount),
		cache_creation_input_tokens: Schema.optional(tokenCount),
		cache_read_input_tokens: Schema.optional(tokenCount),
	}),
)
const block = fields(
	Schema.Struct({
		type: Schema.String,
		text: Schema.optional(Schema.String),
		id: Schema.optional(Schema.String),
		name: Schema.optional(Schema.String),
		input: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
	}),
)
const delta = fields(
	Schema.Struct({
		type: Schema.String,
		text: Schema.optional(Schema.String),
		partial_json: Schema.optional(Schema.String),
	}),
)

export const AnthropicEvent = Schema.Union([
	Schema.Struct({ type: Schema.Literal("ping") }),
	Schema.Struct({
		type: Schema.Literal("error"),
		error: fields(Schema.Struct({ type: Schema.String, message: Schema.String })),
	}),
	Schema.Struct({
		type: Schema.Literal("message_start"),
		message: fields(
			Schema.Struct({
				id: Schema.String,
				model: Schema.String,
				type: Schema.Literal("message"),
				role: Schema.Literal("assistant"),
				content: Schema.Array(block),
				usage,
				stop_reason: Schema.optional(Schema.Null),
				stop_sequence: Schema.optional(Schema.Null),
			}),
		),
	}),
	Schema.Struct({
		type: Schema.Literal("content_block_start"),
		index: tokenCount,
		content_block: block,
	}),
	Schema.Struct({ type: Schema.Literal("content_block_delta"), index: tokenCount, delta }),
	Schema.Struct({ type: Schema.Literal("content_block_stop"), index: tokenCount }),
	Schema.Struct({
		type: Schema.Literal("message_delta"),
		delta: fields(
			Schema.Struct({
				stop_reason: Schema.String,
				stop_sequence: Schema.optional(Schema.Null),
			}),
		),
		usage: Schema.optional(usage),
	}),
	Schema.Struct({ type: Schema.Literal("message_stop") }),
]).mapMembers(Tuple.map(fields))

interface EventState {
	readonly started: boolean
	readonly finished: boolean
	readonly reason: Option.Option<"stop" | "tool_calls" | "length" | "content_filter">
	readonly inputTokens: number
	readonly cachedTokens: number
	readonly outputTokens: number
	readonly blocks: HashMap.HashMap<
		number,
		{ readonly type: "text" } | { readonly type: "tool_use"; readonly id: string }
	>
}
const initial = (): EventState => ({
	started: false,
	finished: false,
	reason: Option.none(),
	inputTokens: 0,
	cachedTokens: 0,
	outputTokens: 0,
	blocks: HashMap.empty(),
})
const eventError = (
	path: string,
	reason: "invalid" | "unsupported",
	message: string,
): ProviderError => fail(reason === "invalid" ? "unknown" : "unsupported", `${path}: ${message}`)
const only = (
	value: object,
	path: string,
	allowed: readonly string[],
): Result.Result<void, ProviderError> => {
	const extra = Object.keys(value).find((key) => !allowed.includes(key))
	return extra
		? Result.fail(eventError(`${path}.${extra}`, "unsupported", "no portable mapping"))
		: Result.void
}
const required = <A>(value: A | undefined, path: string): Result.Result<A, ProviderError> =>
	value === undefined
		? Result.fail(eventError(path, "invalid", "required"))
		: Result.succeed(value)

function transition(
	state: EventState,
	entry:
		| { readonly kind: "end" }
		| { readonly kind: "frame"; readonly event: string | undefined; readonly data: string },
	now: number,
): Result.Result<readonly [EventState, readonly NativeChunk[]], ProviderError> {
	return Match.value(entry).pipe(
		Match.discriminatorsExhaustive("kind")({
			end: () =>
				state.finished
					? Result.succeed([state, []] as const)
					: Result.fail(fail("unknown", "Anthropic stream ended without message_stop")),
			frame: (frame) =>
				Result.gen(function* () {
					const event = yield* Result.mapError(
						Schema.decodeUnknownResult(Schema.fromJsonString(AnthropicEvent))(
							frame.data,
						),
						(error) =>
							fail("unknown", fromSchema(error, "event").message, false, error),
					)
					if (event.type !== frame.event)
						return yield* Result.fail(fail("unknown", "Anthropic SSE event mismatch"))
					if (state.finished)
						return yield* Result.fail(fail("unknown", "Events followed message_stop"))
					const allowed = Match.value(event).pipe(
						Match.discriminatorsExhaustive("type")({
							ping: () => ["type"],
							error: () => ["type", "error"],
							message_start: () => ["type", "message"],
							content_block_start: () => ["type", "index", "content_block"],
							content_block_delta: () => ["type", "index", "delta"],
							content_block_stop: () => ["type", "index"],
							message_delta: () => ["type", "delta", "usage"],
							message_stop: () => ["type"],
						}),
					)
					yield* only(event, "event", allowed)
					if (!state.started && !["ping", "error", "message_start"].includes(event.type))
						return yield* Result.fail(
							fail("unknown", "Anthropic output before message_start"),
						)
					return yield* Match.value(event).pipe(
						Match.discriminatorsExhaustive("type")({
							ping: () => Result.succeed([state, []] as const),
							error: ({ error }) => Result.fail(fail("unavailable", error.message)),
							message_start: ({ message }) =>
								Result.gen(function* () {
									if (state.started)
										return yield* Result.fail(
											fail("unknown", "Duplicate message_start"),
										)
									yield* only(message, "event.message", [
										"id",
										"model",
										"type",
										"role",
										"content",
										"usage",
										"stop_reason",
										"stop_sequence",
									])
									yield* only(message.usage, "event.message.usage", [
										"input_tokens",
										"output_tokens",
										"cache_creation_input_tokens",
										"cache_read_input_tokens",
									])
									if (message.content.length)
										return yield* Result.fail(
											eventError(
												"event.message.content",
												"unsupported",
												"nonempty initial content",
											),
										)
									const initialInput = message.usage.input_tokens ?? 0
									const cachedTokens = message.usage.cache_read_input_tokens ?? 0
									return [
										{
											...state,
											started: true,
											inputTokens:
												initialInput +
												(message.usage.cache_creation_input_tokens ?? 0) +
												cachedTokens,
											cachedTokens,
											outputTokens: message.usage.output_tokens ?? 0,
										},
										[
											{
												type: "start",
												id: message.id,
												model: message.model,
												createdAt: now,
											},
										],
									] as const
								}),
							content_block_start: ({ index, content_block: value }) =>
								Result.gen(function* () {
									if (HashMap.has(state.blocks, index))
										return yield* Result.fail(
											eventError("event.index", "invalid", "duplicate block"),
										)
									return yield* Match.value(value.type).pipe(
										Match.when("text", () =>
											Result.gen(function* () {
												yield* only(value, "event.content_block", [
													"type",
													"text",
												])
												const text = yield* required(
													value.text,
													"event.content_block.text",
												)
												return [
													{
														...state,
														blocks: HashMap.set(state.blocks, index, {
															type: "text",
														}),
													},
													[{ type: "text", value: text }],
												] as const
											}),
										),
										Match.when("tool_use", () =>
											Result.gen(function* () {
												yield* only(value, "event.content_block", [
													"type",
													"id",
													"name",
													"input",
												])
												const id = yield* required(
													value.id,
													"event.content_block.id",
												)
												const name = yield* required(
													value.name,
													"event.content_block.name",
												)
												const input = yield* required(
													value.input,
													"event.content_block.input",
												)
												return [
													{
														...state,
														blocks: HashMap.set(state.blocks, index, {
															type: "tool_use",
															id,
														}),
													},
													[
														{ type: "tool_start", id, name },
														...(Object.keys(input).length
															? [
																	{
																		type: "tool_delta" as const,
																		id,
																		value: JSON.stringify(
																			input,
																		),
																	},
																]
															: []),
													],
												] as const
											}),
										),
										Match.orElse(() =>
											Result.fail(
												eventError(
													"event.content_block.type",
													"unsupported",
													"content block",
												),
											),
										),
									)
								}),
							content_block_delta: ({ index, delta }) =>
								Result.gen(function* () {
									const active = yield* Result.fromOption(
										HashMap.get(state.blocks, index),
										() =>
											eventError("event.index", "invalid", "block not open"),
									)
									return yield* Match.value(active).pipe(
										Match.discriminatorsExhaustive("type")({
											text: () =>
												Match.value(delta.type).pipe(
													Match.when("text_delta", () =>
														Result.gen(function* () {
															yield* only(delta, "event.delta", [
																"type",
																"text",
															])
															const value = yield* required(
																delta.text,
																"event.delta.text",
															)
															return [
																state,
																[{ type: "text", value }],
															] as const
														}),
													),
													Match.orElse(() =>
														Result.fail(
															eventError(
																"event.delta.type",
																"unsupported",
																"delta for active block",
															),
														),
													),
												),
											tool_use: ({ id }) =>
												Match.value(delta.type).pipe(
													Match.when("input_json_delta", () =>
														Result.gen(function* () {
															yield* only(delta, "event.delta", [
																"type",
																"partial_json",
															])
															const value = yield* required(
																delta.partial_json,
																"event.delta.partial_json",
															)
															return [
																state,
																[{ type: "tool_delta", id, value }],
															] as const
														}),
													),
													Match.orElse(() =>
														Result.fail(
															eventError(
																"event.delta.type",
																"unsupported",
																"delta for active block",
															),
														),
													),
												),
										}),
									)
								}),
							content_block_stop: ({ index }) =>
								HashMap.has(state.blocks, index)
									? Result.succeed([
											{
												...state,
												blocks: HashMap.remove(state.blocks, index),
											},
											[],
										] as const)
									: Result.fail(
											eventError("event.index", "invalid", "block not open"),
										),
							message_delta: ({ delta, usage }) =>
								Result.gen(function* () {
									if (Option.isSome(state.reason))
										return yield* Result.fail(
											fail("unknown", "Duplicate Anthropic stop reason"),
										)
									yield* only(delta, "event.delta", [
										"stop_reason",
										"stop_sequence",
									])
									if (usage) yield* only(usage, "event.usage", ["output_tokens"])
									const reason = Match.value(delta.stop_reason).pipe(
										Match.when("end_turn", () => "stop" as const),
										Match.when("tool_use", () => "tool_calls" as const),
										Match.when("max_tokens", () => "length" as const),
										Match.when("refusal", () => "content_filter" as const),
										Match.orElse(() => undefined),
									)
									if (!reason)
										return yield* Result.fail(
											eventError(
												"event.delta.stop_reason",
												"unsupported",
												"stop reason",
											),
										)
									return [
										{
											...state,
											reason: Option.some(reason),
											outputTokens:
												usage?.output_tokens ?? state.outputTokens,
										},
										[],
									] as const
								}),
							message_stop: () =>
								Result.gen(function* () {
									const reason = yield* Result.fromOption(state.reason, () =>
										fail(
											"unknown",
											"Anthropic stream ended before content completed",
										),
									)
									if (HashMap.size(state.blocks))
										return yield* Result.fail(
											fail(
												"unknown",
												"Anthropic stream ended with open content blocks",
											),
										)
									const inputTokens = state.inputTokens
									const outputTokens = state.outputTokens
									return [
										{ ...state, finished: true },
										[
											{
												type: "finish",
												reason,
												usage: {
													input_tokens: inputTokens,
													output_tokens: outputTokens,
													total_tokens: inputTokens + outputTokens,
													input_tokens_details: {
														cached_tokens: state.cachedTokens,
													},
													output_tokens_details: { reasoning_tokens: 0 },
												},
											},
										],
									] as const
								}),
						}),
					)
				}),
		}),
	)
}
function events(
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
			Effect.gen(function* () {
				const now =
					entry.kind === "frame" ? Math.floor((yield* Clock.currentTimeMillis) / 1000) : 0
				return yield* Effect.fromResult(transition(state, entry, now))
			}),
		),
		Stream.mapError((cause): ProviderError =>
			isError(cause)
				? (cause as ProviderError)
				: fail("unknown", "Anthropic stream failed", false, cause),
		),
	)
}

interface NativeFrameState {
	readonly started: boolean
	readonly finished: boolean
	readonly pending: readonly Uint8Array[]
}

const initialNativeFrameState = (): NativeFrameState => ({
	started: false,
	finished: false,
	pending: [],
})

const nativeFrames = (
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
		Stream.mapAccumEffect(initialNativeFrameState, (state, entry) =>
			Match.value(entry).pipe(
				Match.discriminatorsExhaustive("kind")({
					end: () =>
						!state.finished
							? Effect.fail(
									fail("unknown", "Anthropic stream ended without message_stop"),
								)
							: Effect.succeed([state, state.pending] as const),
					frame: (value) => {
						const frameEntry = value as Extract<
							typeof entry,
							{ readonly kind: "frame" }
						>
						return Effect.gen(function* () {
							if (state.finished)
								return yield* Effect.fail(
									fail("unknown", "Events followed message_stop"),
								)
							const event = yield* Effect.fromResult(
								Result.mapError(
									Schema.decodeUnknownResult(
										Schema.fromJsonString(AnthropicEvent),
									)(frameEntry.frame.data),
									(error) =>
										fail(
											"unknown",
											fromSchema(error, "event").message,
											false,
											error,
										),
								),
							)
							if (frameEntry.frame.event !== event.type)
								return yield* Effect.fail(
									fail("unknown", "Anthropic SSE event mismatch"),
								)
							const encoded = new TextEncoder().encode(
								Sse.encoder.write({
									_tag: "Event",
									event: frameEntry.frame.event,
									id: frameEntry.frame.id,
									data: frameEntry.frame.data,
								}),
							)
							return yield* Match.value(event).pipe(
								Match.discriminatorsExhaustive("type")({
									ping: () =>
										!state.started
											? Effect.fail(
													fail(
														"unknown",
														"Anthropic output before message_start",
													),
												)
											: Effect.succeed([state, [encoded]] as const),
									error: ({ error }) =>
										Effect.fail(fail("unavailable", error.message)),
									message_start: () =>
										state.started
											? Effect.fail(
													fail("unknown", "Duplicate message_start"),
												)
											: Effect.succeed([
													{ ...state, started: true },
													[encoded],
												] as const),
									message_stop: () =>
										!state.started
											? Effect.fail(
													fail(
														"unknown",
														"Anthropic output before message_start",
													),
												)
											: Effect.succeed([
													{
														...state,
														finished: true,
														pending: [...state.pending, encoded],
													},
													[],
												] as const),
									message_delta: () =>
										!state.started
											? Effect.fail(
													fail(
														"unknown",
														"Anthropic output before message_start",
													),
												)
											: Effect.succeed([state, [encoded]] as const),
									content_block_start: () =>
										!state.started
											? Effect.fail(
													fail(
														"unknown",
														"Anthropic output before message_start",
													),
												)
											: Effect.succeed([state, [encoded]] as const),
									content_block_delta: () =>
										!state.started
											? Effect.fail(
													fail(
														"unknown",
														"Anthropic output before message_start",
													),
												)
											: Effect.succeed([state, [encoded]] as const),
									content_block_stop: () =>
										!state.started
											? Effect.fail(
													fail(
														"unknown",
														"Anthropic output before message_start",
													),
												)
											: Effect.succeed([state, [encoded]] as const),
								}),
							)
						})
					},
				}),
			),
		),
		Stream.mapError((cause): ProviderError =>
			isError(cause)
				? cause
				: fail("unknown", "Anthropic native stream failed", false, cause),
		),
	)
}

const statusError = (status: number): ProviderError =>
	Match.value(status).pipe(
		Match.whenOr(429, 529, () =>
			fail("rate_limited", "Anthropic rate limited the request", true),
		),
		Match.whenOr(401, 403, () => fail("unauthorized", "Anthropic authentication failed")),
		Match.whenOr(408, 504, () => fail("timeout", "Anthropic request timed out")),
		Match.orElse((value) =>
			value >= 500
				? fail("unavailable", "Anthropic is unavailable", true)
				: fail("invalid_request", `Anthropic rejected the request (${value})`),
		),
	)

/** Bind a private Anthropic Messages model to the router's event interface. */
export function make<const Id extends string>(
	config: AnthropicMessagesDeploymentConfig<Id>,
): Result.Result<AnthropicMessagesDeployment<HttpClient.HttpClient, Id>, DeploymentError> {
	const parsed = Schema.decodeUnknownResult(DeploymentConfig)(config)
	if (Result.isFailure(parsed))
		return Result.fail(DeploymentError.make({ message: parsed.failure.message }))
	const url = parsed.success.url ?? new URL("https://api.anthropic.com/v1/messages")
	if (url.protocol !== "http:" && url.protocol !== "https:")
		return Result.fail(
			DeploymentError.make({ message: "Anthropic Messages URL must use HTTP(S)" }),
		)
	return Result.succeed({
		id: config.id,
		provider: "anthropic",
		protocol: "anthropic.messages",
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
					const outgoing = HttpClientRequest.post(url.toString()).pipe(
						HttpClientRequest.setHeader(
							"x-api-key",
							Redacted.value(parsed.success.apiKey),
						),
						HttpClientRequest.setHeader(
							"anthropic-version",
							parsed.success.version ?? "2023-06-01",
						),
						HttpClientRequest.setHeader("content-type", "application/json"),
						HttpClientRequest.bodyJsonUnsafe({ ...body, model: request.targetModel }),
					)
					const response = yield* client
						.execute(outgoing)
						.pipe(
							Effect.mapError((cause) =>
								fail("unavailable", "Anthropic connection failed", false, cause),
							),
						)
					if (response.status < 200 || response.status >= 300)
						return yield* Effect.fail(statusError(response.status))
					return {
						status: response.status,
						headers: Object.fromEntries(Object.entries(response.headers)),
						body: nativeFrames(response.stream),
					}
				}),
			http: (request) =>
				Effect.gen(function* () {
					const parsedRequest = yield* Schema.decodeUnknownEffect(Request)(request).pipe(
						Effect.mapError((cause) =>
							fail("invalid_request", cause.message, false, cause),
						),
					)
					const body = yield* Effect.fromResult(
						toMessagesRequest(parsedRequest, parsed.success.defaultMaxTokens),
					)
					const client = yield* HttpClient.HttpClient
					const outgoing = HttpClientRequest.post(url.toString()).pipe(
						HttpClientRequest.setHeader(
							"x-api-key",
							Redacted.value(parsed.success.apiKey),
						),
						HttpClientRequest.setHeader(
							"anthropic-version",
							parsed.success.version ?? "2023-06-01",
						),
						HttpClientRequest.setHeader("content-type", "application/json"),
						HttpClientRequest.bodyJsonUnsafe(body),
					)
					const response = yield* client
						.execute(outgoing)
						.pipe(
							Effect.mapError((cause) =>
								fail("unavailable", "Anthropic connection failed", false, cause),
							),
						)
					if (response.status < 200 || response.status >= 300)
						return yield* Effect.fail(statusError(response.status))
					if (
						!response.headers["content-type"]
							?.toLowerCase()
							.startsWith("text/event-stream")
					) {
						return yield* Effect.fail(
							fail("unknown", "Expected an Anthropic event stream"),
						)
					}
					return fromNative(request, events(response.stream))
				}),
		},
	})
}
