import { Effect, HashMap, Layer, Match, Option, Redacted, Result, Schema, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpApiSchema,
} from "effect/http-api"
import { ConversionError, at, fromSchema } from "@better-router/core/Conversion"
import type { HttpContribution } from "@better-router/core/Http"
import { HttpJsonError, read as readJson } from "@better-router/core/HttpJson"
import type {
	GenerationInputItem,
	GenerationEvent,
	GenerationRequest,
} from "@better-router/core/Generation"
import { Event, Request, Response } from "@better-router/core/GenerationSchema"
import type { ProtocolDefinition } from "@better-router/core/Projection"
import { RouterError } from "@better-router/core/Router"
import type { Router } from "@better-router/core/Router"
import { complete as completeGeneration } from "@better-router/core/Execution"
import type { Execution } from "@better-router/core/Execution"

export interface AnthropicMessagesHttpOptions {
	readonly gatewayKey: Redacted.Redacted<string>
}

export const AnthropicMessagesHttpError = Schema.Struct({
	type: Schema.Literal("error"),
	error: Schema.Struct({ type: Schema.String, message: Schema.String }),
})

export const api = HttpApi.make("anthropic-messages").add(
	HttpApiGroup.make("anthropicMessages").add(
		HttpApiEndpoint.post("create", "/v1/messages", {
			success: [
				Schema.Unknown,
				HttpApiSchema.StreamUint8Array({ contentType: "text/event-stream; charset=utf-8" }),
			],
			error: [400, 401, 404, 413, 415, 422, 429, 500, 502, 503, 504].map((status) =>
				AnthropicMessagesHttpError.pipe(HttpApiSchema.status(status)),
			),
		}),
	),
)

export const AnthropicMessagesConversionError = ConversionError
export type AnthropicMessagesConversionError = ConversionError

export const projection: ProtocolDefinition<
	string,
	typeof AnthropicMessage.Type,
	"anthropic.messages",
	"anthropic.messages",
	"generation"
> = {
	id: "anthropic.messages",
	protocol: "anthropic.messages",
	capability: "generation",
	decode: toResponseRequest,
	encodeEvent: () =>
		Result.fail(
			at("event", "unsupported", "Anthropic Messages event encoding requires stream state"),
		),
	encodeResponse: (response) => toMessage(response, response.model),
	encodeEvents: (events, context) => frames(events, context.model),
}

const rest = [Schema.Record(Schema.String, Schema.Unknown)] as const
const fields = <S extends Schema.StructWithRest.Objects>(schema: S) =>
	Schema.StructWithRest(schema, rest)
const imageSource = fields(
	Schema.Struct({
		type: Schema.String,
		url: Schema.optional(Schema.String),
		media_type: Schema.optional(Schema.String),
		data: Schema.optional(Schema.String),
	}),
)
const toolResultPart = fields(
	Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
)
const content = fields(
	Schema.Struct({
		type: Schema.String,
		text: Schema.optional(Schema.String),
		source: Schema.optional(imageSource),
		id: Schema.optional(Schema.String),
		name: Schema.optional(Schema.String),
		input: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
		tool_use_id: Schema.optional(Schema.String),
		content: Schema.optional(Schema.Union([Schema.String, Schema.Array(toolResultPart)])),
		is_error: Schema.optional(Schema.Boolean),
	}),
)
const message = fields(
	Schema.Struct({
		role: Schema.String,
		content: Schema.Union([Schema.String, Schema.Array(content)]),
	}),
)
const tool = fields(
	Schema.Struct({
		name: Schema.String,
		description: Schema.optional(Schema.String),
		input_schema: Schema.Record(Schema.String, Schema.Json),
	}),
)
const choice = fields(
	Schema.Struct({
		type: Schema.String,
		name: Schema.optional(Schema.String),
		disable_parallel_tool_use: Schema.optional(Schema.Boolean),
	}),
)
const format = fields(
	Schema.Struct({
		type: Schema.String,
		schema: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
	}),
)

export const AnthropicRequest = fields(
	Schema.Struct({
		model: Schema.String,
		messages: Schema.Array(message),
		max_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
		system: Schema.optional(Schema.Union([Schema.String, Schema.Array(content)])),
		tools: Schema.optional(Schema.Array(tool)),
		tool_choice: Schema.optional(choice),
		output_config: Schema.optional(fields(Schema.Struct({ format }))),
		temperature: Schema.optional(
			Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
		),
		top_p: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
		stream: Schema.optional(Schema.Boolean),
	}),
)
const NativeRequest = Schema.StructWithRest(
	Schema.Struct({ model: Schema.String, stream: Schema.optional(Schema.Boolean) }),
	rest,
)
export const toNativeRequest = (
	value: unknown,
): Result.Result<{ readonly model: string; readonly stream?: boolean }, ConversionError> =>
	Result.map(Schema.decodeUnknownResult(NativeRequest)(value), ({ model, stream }) => ({
		model,
		...(stream === undefined ? {} : { stream }),
	})).pipe(Result.mapError((error) => fromSchema(error, "request")))
type Block = typeof content.Type
type Message = typeof message.Type
type Parts = Extract<GenerationInputItem, { type: "message" }>["content"]
type InputPart = NonNullable<Exclude<Parts, string>>[number]

const only = (
	value: object,
	path: string,
	allowed: readonly string[],
): Result.Result<void, ConversionError> => {
	const extra = Object.keys(value).find((key) => !allowed.includes(key))
	return extra
		? Result.fail(at(`${path}.${extra}`, "unsupported", "no OpenResponses mapping"))
		: Result.void
}
const required = <A>(value: A | undefined, path: string): Result.Result<A, ConversionError> =>
	value === undefined ? Result.fail(at(path, "invalid", "required")) : Result.succeed(value)

function image(block: Block, path: string): Result.Result<InputPart, ConversionError> {
	return Result.gen(function* () {
		yield* only(block, path, ["type", "source"])
		const value = yield* required(block.source, `${path}.source`)
		return yield* Match.value(value.type).pipe(
			Match.when("url", () =>
				Result.gen(function* () {
					yield* only(value, `${path}.source`, ["type", "url"])
					const url = yield* required(value.url, `${path}.source.url`)
					if (!/^https?:\/\/\S+$/.test(url))
						return yield* Result.fail(
							at(
								`${path}.source.url`,
								"unsupported",
								"only HTTP(S) images are portable",
							),
						)
					return { type: "input_image", image_url: url, detail: "auto" } as const
				}),
			),
			Match.when("base64", () =>
				Result.gen(function* () {
					yield* only(value, `${path}.source`, ["type", "media_type", "data"])
					const mime = yield* required(value.media_type, `${path}.source.media_type`)
					if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime))
						return yield* Result.fail(
							at(`${path}.source.media_type`, "unsupported", "image format"),
						)
					const data = yield* required(value.data, `${path}.source.data`)
					if (!/^[a-zA-Z0-9+/=]+$/.test(data))
						return yield* Result.fail(
							at(`${path}.source.data`, "invalid", "base64 data"),
						)
					return {
						type: "input_image",
						image_url: `data:${mime};base64,${data}`,
						detail: "auto",
					} as const
				}),
			),
			Match.orElse(() =>
				Result.fail(at(`${path}.source.type`, "unsupported", "image source")),
			),
		)
	})
}

interface MessageState {
	readonly items: readonly GenerationInputItem[]
	readonly parts: readonly InputPart[]
}
const flush = (state: MessageState, role: "user" | "assistant"): MessageState =>
	state.parts.length
		? {
				items: [
					...state.items,
					{ type: "message", role, content: state.parts } as GenerationInputItem,
				],
				parts: [],
			}
		: state

const toolResultParts = (
	parts: readonly (typeof toolResultPart.Type)[],
	path: string,
): Result.Result<
	readonly { readonly type: "input_text"; readonly text: string }[],
	ConversionError
> =>
	parts.reduce<
		Result.Result<
			readonly { readonly type: "input_text"; readonly text: string }[],
			ConversionError
		>
	>(
		(previous, part, contentIndex) =>
			Result.gen(function* () {
				const values = yield* previous
				const itemPath = `${path}.content[${contentIndex}]`
				return yield* Match.value(part.type).pipe(
					Match.when("text", () =>
						Result.gen(function* () {
							yield* only(part, itemPath, ["type", "text"])
							const text = yield* required(part.text, `${itemPath}.text`)
							return [...values, { type: "input_text" as const, text }]
						}),
					),
					Match.orElse(() =>
						Result.fail(at(`${itemPath}.type`, "unsupported", "tool result part")),
					),
				) as Result.Result<
					readonly { readonly type: "input_text"; readonly text: string }[],
					ConversionError
				>
			}),
		Result.succeed([]),
	)

function messageItems(
	value: Message,
	index: number,
): Result.Result<readonly GenerationInputItem[], ConversionError> {
	return Result.gen(function* () {
		const path = `request.messages[${index}]`
		yield* only(value, path, ["role", "content"])
		if (value.role !== "user" && value.role !== "assistant")
			return yield* Result.fail(at(`${path}.role`, "unsupported", "message role"))
		if (typeof value.content === "string")
			return [{ type: "message", role: value.role, content: value.content }]
		const stateResult = value.content.reduce<Result.Result<MessageState, ConversionError>>(
			(previous, block, partIndex) =>
				Result.gen(function* () {
					const current = yield* previous
					const field = `${path}.content[${partIndex}]`
					return yield* Match.value(block.type).pipe(
						Match.when("text", () =>
							Result.gen(function* () {
								yield* only(block, field, ["type", "text"])
								const text = yield* required(block.text, `${field}.text`)
								return {
									...current,
									parts: [
										...current.parts,
										{
											type:
												value.role === "user"
													? ("input_text" as const)
													: ("output_text" as const),
											text,
										},
									],
								}
							}),
						),
						Match.when("image", () =>
							value.role === "user"
								? Result.map(image(block, field), (part) => ({
										...current,
										parts: [...current.parts, part],
									}))
								: Result.fail(at(`${field}.type`, "unsupported", "content block")),
						),
						Match.when("tool_use", () =>
							value.role !== "assistant"
								? Result.fail(at(`${field}.type`, "unsupported", "content block"))
								: Result.gen(function* () {
										yield* only(block, field, ["type", "id", "name", "input"])
										const id = yield* required(block.id, `${field}.id`)
										const name = yield* required(block.name, `${field}.name`)
										const input = yield* required(block.input, `${field}.input`)
										const flushed = flush(current, "assistant")
										return {
											items: [
												...flushed.items,
												{
													type: "function_call" as const,
													call_id: id,
													name,
													arguments: JSON.stringify(input),
												},
											],
											parts: [],
										}
									}),
						),
						Match.when("tool_result", () =>
							value.role !== "user"
								? Result.fail(at(`${field}.type`, "unsupported", "content block"))
								: Result.gen(function* () {
										yield* only(block, field, [
											"type",
											"tool_use_id",
											"content",
											"is_error",
										])
										if (block.is_error === true)
											return yield* Result.fail(
												at(
													`${field}.is_error`,
													"unsupported",
													"tool errors are not portable",
												),
											)
										const callId = yield* required(
											block.tool_use_id,
											`${field}.tool_use_id`,
										)
										const raw = yield* required(
											block.content,
											`${field}.content`,
										)
										const output = yield* typeof raw === "string"
											? Result.succeed(raw)
											: toolResultParts(raw, field)
										const flushed = flush(current, "user")
										return {
											items: [
												...flushed.items,
												{
													type: "function_call_output" as const,
													call_id: callId,
													output,
												},
											],
											parts: [],
										}
									}),
						),
						Match.orElse(() =>
							Result.fail(at(`${field}.type`, "unsupported", "content block")),
						),
					) as Result.Result<MessageState, ConversionError>
				}),
			Result.succeed({ items: [], parts: [] }),
		)
		const state = yield* stateResult
		return flush(state, value.role).items
	})
}

/** Parse Messages JSON once, then translate its supported semantics without modifying input. */
export function toResponseRequest(
	value: unknown,
): Result.Result<GenerationRequest, ConversionError> {
	return Result.gen(function* () {
		const native = yield* Result.mapError(
			Schema.decodeUnknownResult(AnthropicRequest)(value),
			(error) => fromSchema(error, "request"),
		)
		yield* only(native, "request", [
			"model",
			"messages",
			"max_tokens",
			"system",
			"tools",
			"tool_choice",
			"output_config",
			"temperature",
			"top_p",
			"stream",
		])
		if (!native.model)
			return yield* Result.fail(at("request.model", "invalid", "model is required"))
		if (native.max_tokens < 16) {
			return yield* Result.fail(
				at(
					"request.max_tokens",
					"unsupported",
					"OpenResponses requires at least 16 output tokens",
				),
			)
		}
		if (native.system !== undefined && typeof native.system !== "string") {
			return yield* Result.fail(
				at("request.system", "unsupported", "only text system prompts are portable"),
			)
		}
		const input = yield* native.messages.reduce<
			Result.Result<readonly GenerationInputItem[], ConversionError>
		>(
			(previous, entry, index) =>
				Result.gen(function* () {
					const items = yield* previous
					return [...items, ...(yield* messageItems(entry, index))]
				}),
			Result.succeed([]),
		)
		const tools = yield* (native.tools ?? []).reduce<
			Result.Result<
				readonly NonNullable<GenerationRequest["tools"]>[number][],
				ConversionError
			>
		>(
			(previous, entry, index) =>
				Result.gen(function* () {
					const items = yield* previous
					yield* only(entry, `request.tools[${index}]`, [
						"name",
						"description",
						"input_schema",
					])
					return [
						...items,
						{
							type: "function" as const,
							name: entry.name,
							description: entry.description ?? null,
							parameters: entry.input_schema,
						},
					]
				}),
			Result.succeed([]),
		)
		const selected = yield* native.tool_choice === undefined
			? Result.succeed(undefined)
			: Result.gen(function* () {
					const entry = native.tool_choice!
					yield* only(entry, "request.tool_choice", [
						"type",
						"name",
						"disable_parallel_tool_use",
					])
					return yield* Match.value(entry.type).pipe(
						Match.when("tool", () =>
							Result.map(
								required(entry.name, "request.tool_choice.name"),
								(name) => ({ type: "function" as const, name }),
							),
						),
						Match.when("auto", () =>
							entry.name === undefined
								? Result.succeed("auto" as const)
								: Result.fail(
										at(
											"request.tool_choice.name",
											"unsupported",
											"name requires tool choice",
										),
									),
						),
						Match.when("any", () =>
							entry.name === undefined
								? Result.succeed("required" as const)
								: Result.fail(
										at(
											"request.tool_choice.name",
											"unsupported",
											"name requires tool choice",
										),
									),
						),
						Match.when("none", () =>
							entry.name === undefined
								? Result.succeed("none" as const)
								: Result.fail(
										at(
											"request.tool_choice.name",
											"unsupported",
											"name requires tool choice",
										),
									),
						),
						Match.orElse(() =>
							Result.fail(
								at("request.tool_choice.type", "unsupported", "tool choice"),
							),
						),
					)
				})
		const outputFormat = yield* native.output_config === undefined
			? Result.succeed(undefined)
			: Result.gen(function* () {
					yield* only(native.output_config!, "request.output_config", ["format"])
					const entry = native.output_config!.format
					yield* only(entry, "request.output_config.format", ["type", "schema"])
					return yield* Match.value(entry.type).pipe(
						Match.when("json_schema", () =>
							Result.gen(function* () {
								const schema = yield* required(
									entry.schema,
									"request.output_config.format.schema",
								)
								return {
									format: {
										type: "json_schema" as const,
										name: "anthropic_output",
										schema,
										strict: true,
									},
								}
							}),
						),
						Match.orElse(() =>
							Result.fail(
								at(
									"request.output_config.format.type",
									"unsupported",
									"output format",
								),
							),
						),
					)
				})
		const converted: GenerationRequest = {
			model: native.model,
			input,
			max_output_tokens: native.max_tokens,
			...(native.stream === undefined ? {} : { stream: native.stream }),
			...(native.system === undefined ? {} : { instructions: native.system }),
			...(native.tools === undefined ? {} : { tools }),
			...(selected === undefined ? {} : { tool_choice: selected }),
			...(native.tool_choice?.disable_parallel_tool_use === undefined
				? {}
				: { parallel_tool_calls: !native.tool_choice.disable_parallel_tool_use }),
			...(outputFormat === undefined ? {} : { text: outputFormat }),
			...(native.temperature === undefined ? {} : { temperature: native.temperature }),
			...(native.top_p === undefined ? {} : { top_p: native.top_p }),
		}
		return yield* Result.mapError(Schema.decodeUnknownResult(Request)(converted), (error) =>
			fromSchema(error, "request"),
		)
	})
}

const textBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const toolBlock = Schema.Struct({
	type: Schema.Literal("tool_use"),
	id: Schema.String,
	name: Schema.String,
	input: Schema.Record(Schema.String, Schema.Json),
})
const usage = Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number })
export const AnthropicMessage = Schema.Struct({
	id: Schema.String,
	type: Schema.Literal("message"),
	role: Schema.Literal("assistant"),
	model: Schema.String,
	content: Schema.Array(Schema.Union([textBlock, toolBlock])),
	stop_reason: Schema.Union([
		Schema.Literals(["end_turn", "tool_use", "max_tokens", "refusal"]),
		Schema.Null,
	]),
	stop_sequence: Schema.Null,
	usage,
})

/** Parse the terminal OpenResponses resource before projecting an Anthropic message. */
export function toMessage(
	value: unknown,
	model: string,
): Result.Result<typeof AnthropicMessage.Type, ConversionError> {
	return Result.gen(function* () {
		const response = yield* Result.mapError(
			Schema.decodeUnknownResult(Response)(value),
			(error) => fromSchema(error, "response"),
		)
		if (!response.usage)
			return yield* Result.fail(
				at("response.usage", "unsupported", "Anthropic requires usage"),
			)
		const blocksResult = response.output.reduce<
			Result.Result<
				readonly (typeof textBlock.Type | typeof toolBlock.Type)[],
				ConversionError
			>
		>(
			(previous, item, index) =>
				Result.gen(function* () {
					const entries = yield* previous
					return yield* Match.value(item).pipe(
						Match.when({ type: "message" }, (value) => {
							const messageItem = value as Extract<
								typeof item,
								{ readonly type: "message" }
							>
							return Match.value(messageItem.role).pipe(
								Match.when("assistant", () => {
									const contentResult = messageItem.content.reduce<
										Result.Result<
											readonly (
												typeof textBlock.Type | typeof toolBlock.Type
											)[],
											ConversionError
										>
									>(
										(current, part, partIndex) =>
											Result.gen(function* () {
												const output = yield* current
												return yield* Match.value(part.type).pipe(
													Match.when("output_text", () => {
														const outputPart = part as Extract<
															typeof part,
															{ readonly type: "output_text" }
														>
														if (
															outputPart.annotations.length ||
															(outputPart.logprobs?.length ?? 0)
														)
															return Result.fail(
																at(
																	`response.output[${index}].content[${partIndex}]`,
																	"unsupported",
																	"annotations or logprobs",
																),
															)
														return Result.succeed([
															...output,
															{
																type: "text" as const,
																text: outputPart.text,
															},
														])
													}),
													Match.orElse(() =>
														Result.fail(
															at(
																`response.output[${index}].content[${partIndex}]`,
																"unsupported",
																"content part",
															),
														),
													),
												)
											}),
										Result.succeed(entries),
									)
									return contentResult
								}),
								Match.orElse(() =>
									Result.fail(
										at(
											`response.output[${index}].type`,
											"unsupported",
											"output item",
										),
									),
								),
							)
						}),
						Match.when({ type: "function_call" }, (value) => {
							const call = value as Extract<
								typeof item,
								{ readonly type: "function_call" }
							>
							return Result.map(
								Result.mapError(
									Schema.decodeUnknownResult(
										Schema.fromJsonString(
											Schema.Record(Schema.String, Schema.Json),
										),
									)(call.arguments),
									(error) =>
										fromSchema(error, `response.output[${index}].arguments`),
								),
								(input) => [
									...entries,
									{
										type: "tool_use" as const,
										id: call.call_id,
										name: call.name,
										input,
									},
								],
							)
						}),
						Match.orElse(() =>
							Result.fail(
								at(`response.output[${index}].type`, "unsupported", "output item"),
							),
						),
					)
				}),
			Result.succeed([]),
		)
		const blocks = yield* blocksResult
		const reason =
			response.status === "completed"
				? blocks.some((entry) => entry.type === "tool_use")
					? "tool_use"
					: "end_turn"
				: response.status === "incomplete" &&
					  response.incomplete_details?.reason === "max_output_tokens"
					? "max_tokens"
					: response.status === "incomplete" &&
						  response.incomplete_details?.reason === "content_filter"
						? "refusal"
						: undefined
		if (!reason)
			return yield* Result.fail(at("response.status", "unsupported", "response status"))
		return yield* Result.mapError(
			Schema.decodeUnknownResult(AnthropicMessage)({
				id: response.id.startsWith("msg_") ? response.id : `msg_${response.id}`,
				type: "message",
				role: "assistant",
				model,
				content: blocks,
				stop_reason: reason,
				stop_sequence: null,
				usage: {
					input_tokens: response.usage.input_tokens,
					output_tokens: response.usage.output_tokens,
				},
			}),
			(error) => fromSchema(error, "message"),
		)
	})
}

export const AnthropicOutboundEvent = Schema.Union([
	Schema.Struct({ type: Schema.Literal("message_start"), message: AnthropicMessage }),
	Schema.Struct({
		type: Schema.Literal("content_block_start"),
		index: Schema.Number,
		content_block: Schema.Union([textBlock, toolBlock]),
	}),
	Schema.Struct({
		type: Schema.Literal("content_block_delta"),
		index: Schema.Number,
		delta: Schema.Union([
			Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
			Schema.Struct({
				type: Schema.Literal("input_json_delta"),
				partial_json: Schema.String,
			}),
		]),
	}),
	Schema.Struct({ type: Schema.Literal("content_block_stop"), index: Schema.Number }),
	Schema.Struct({
		type: Schema.Literal("message_delta"),
		delta: Schema.Struct({
			stop_reason: Schema.Literals(["end_turn", "tool_use", "max_tokens", "refusal"]),
			stop_sequence: Schema.Null,
		}),
		usage: Schema.Struct({ output_tokens: Schema.Number }),
	}),
	Schema.Struct({ type: Schema.Literal("message_stop") }),
	AnthropicMessagesHttpError,
])

const frame = (value: unknown): Result.Result<string, ConversionError> =>
	Result.map(
		Result.mapError(Schema.encodeUnknownResult(AnthropicOutboundEvent)(value), (error) =>
			fromSchema(error, "event"),
		),
		(event) =>
			Sse.encoder.write({
				_tag: "Event",
				event: event.type,
				id: undefined,
				data: JSON.stringify(event),
			}),
	)

interface FrameState {
	readonly started: boolean
	readonly finished: boolean
	readonly opened: HashMap.HashMap<
		number,
		{ readonly index: number; readonly type: "text" | "tool_use" }
	>
	readonly nextIndex: number
}
const initial = (): FrameState => ({
	started: false,
	finished: false,
	opened: HashMap.empty(),
	nextIndex: 0,
})

function project(
	state: FrameState,
	value: GenerationEvent | { readonly type: "end" },
	model: string,
): Result.Result<readonly [FrameState, readonly string[]], ConversionError> {
	return Match.value(value).pipe(
		Match.when({ type: "end" }, () =>
			Result.gen(function* () {
				if (!state.finished)
					return yield* Result.fail(at("event", "invalid", "missing terminal response"))
				return [state, [yield* frame({ type: "message_stop" })]] as const
			}),
		),
		Match.orElse((raw) =>
			Result.gen(function* () {
				const source = raw as Exclude<typeof value, { readonly type: "end" }>
				const event = yield* Result.mapError(
					Schema.decodeUnknownResult(Event)(source),
					(error) => fromSchema(error, "event"),
				)
				if (state.finished)
					return yield* Result.fail(
						at("event", "invalid", "events followed terminal response"),
					)
				return yield* Match.value(event).pipe(
					Match.when({ type: "response.created" }, (rawEvent) => {
						const created = rawEvent as {
							readonly type: "response.created"
							readonly response: unknown
						}
						return Result.gen(function* () {
							if (state.started)
								return yield* Result.fail(
									at("event", "invalid", "duplicate response.created"),
								)
							const response = yield* Result.mapError(
								Schema.decodeUnknownResult(Response)(created.response),
								(error) => fromSchema(error, "event.response"),
							)
							return [
								{ ...state, started: true },
								[
									yield* frame({
										type: "message_start",
										message: {
											id: response.id.startsWith("msg_")
												? response.id
												: `msg_${response.id}`,
											type: "message",
											role: "assistant",
											model,
											content: [],
											stop_reason: null,
											stop_sequence: null,
											usage: { input_tokens: 0, output_tokens: 0 },
										},
									}),
								],
							] as const
						})
					}),
					Match.when({ type: "response.output_item.added" }, (rawEvent) => {
						const added = rawEvent as {
							readonly type: "response.output_item.added"
							readonly output_index: number
							readonly item: unknown
						}
						return Result.gen(function* () {
							if (!state.started)
								return yield* Result.fail(
									at("event", "invalid", "output before response.created"),
								)
							if (
								!Number.isInteger(added.output_index) ||
								added.output_index < 0 ||
								HashMap.has(state.opened, added.output_index)
							)
								return yield* Result.fail(
									at(
										"event.output_index",
										"invalid",
										"duplicate or invalid output item index",
									),
								)
							if (!added.item)
								return yield* Result.fail(at("event.item", "invalid", "required"))
							const item = added.item as
								| {
										readonly type: "function_call"
										readonly call_id: string
										readonly name: string
								  }
								| { readonly type: "message"; readonly role: string }
							const index = state.nextIndex
							const open = (
								type: "text" | "tool_use",
								content_block:
									| { readonly type: "text"; readonly text: string }
									| {
											readonly type: "tool_use"
											readonly id: string
											readonly name: string
											readonly input: Record<string, never>
									  },
							) =>
								Result.gen(function* () {
									return [
										{
											...state,
											opened: HashMap.set(state.opened, added.output_index, {
												index,
												type,
											}),
											nextIndex: index + 1,
										},
										[
											yield* frame({
												type: "content_block_start",
												index,
												content_block,
											}),
										],
									] as const
								})
							return yield* Match.value(item).pipe(
								Match.when({ type: "function_call" }, (rawCall) => {
									const call = rawCall as Extract<
										typeof item,
										{ readonly type: "function_call" }
									>
									return open("tool_use", {
										type: "tool_use",
										id: call.call_id,
										name: call.name,
										input: {},
									})
								}),
								Match.when({ type: "message" }, (rawMessage) => {
									const message = rawMessage as Extract<
										typeof item,
										{ readonly type: "message" }
									>
									return Match.value(message.role).pipe(
										Match.when("assistant", () =>
											open("text", { type: "text", text: "" }),
										),
										Match.orElse(() =>
											Result.fail(
												at("event.item.type", "unsupported", "output item"),
											),
										),
									)
								}),
								Match.orElse(() =>
									Result.fail(
										at("event.item.type", "unsupported", "output item"),
									),
								),
							)
						})
					}),
					Match.when({ type: "response.output_text.delta" }, (rawEvent) => {
						const delta = rawEvent as {
							readonly type: "response.output_text.delta"
							readonly output_index: number
							readonly delta: string
							readonly logprobs?: readonly unknown[]
						}
						return Result.gen(function* () {
							if (!state.started)
								return yield* Result.fail(
									at("event", "invalid", "output before response.created"),
								)
							const active = yield* Result.fromOption(
								HashMap.get(state.opened, delta.output_index),
								() =>
									at(
										"event.output_index",
										"invalid",
										"content delta before block start",
									),
							)
							if (active.type !== "text")
								return yield* Result.fail(
									at("event.type", "unsupported", "delta for active block"),
								)
							if (delta.logprobs?.length)
								return yield* Result.fail(
									at("event.logprobs", "unsupported", "output logprobs"),
								)
							return [
								state,
								[
									yield* frame({
										type: "content_block_delta",
										index: active.index,
										delta: { type: "text_delta", text: delta.delta },
									}),
								],
							] as const
						})
					}),
					Match.when({ type: "response.function_call_arguments.delta" }, (rawEvent) => {
						const delta = rawEvent as {
							readonly type: "response.function_call_arguments.delta"
							readonly output_index: number
							readonly delta: string
						}
						return Result.gen(function* () {
							if (!state.started)
								return yield* Result.fail(
									at("event", "invalid", "output before response.created"),
								)
							const active = yield* Result.fromOption(
								HashMap.get(state.opened, delta.output_index),
								() =>
									at(
										"event.output_index",
										"invalid",
										"content delta before block start",
									),
							)
							if (active.type !== "tool_use")
								return yield* Result.fail(
									at("event.type", "unsupported", "delta for active block"),
								)
							return [
								state,
								[
									yield* frame({
										type: "content_block_delta",
										index: active.index,
										delta: {
											type: "input_json_delta",
											partial_json: delta.delta,
										},
									}),
								],
							] as const
						})
					}),
					Match.when({ type: "response.output_item.done" }, (rawEvent) => {
						const done = rawEvent as {
							readonly type: "response.output_item.done"
							readonly output_index: number
						}
						return Result.gen(function* () {
							if (!state.started)
								return yield* Result.fail(
									at("event", "invalid", "output before response.created"),
								)
							const active = yield* Result.fromOption(
								HashMap.get(state.opened, done.output_index),
								() => at("event.output_index", "invalid", "block not open"),
							)
							return [
								{
									...state,
									opened: HashMap.remove(state.opened, done.output_index),
								},
								[yield* frame({ type: "content_block_stop", index: active.index })],
							] as const
						})
					}),
					Match.whenOr(
						{ type: "response.completed" },
						{ type: "response.incomplete" },
						(rawEvent) => {
							const completed = rawEvent as {
								readonly type: "response.completed" | "response.incomplete"
								readonly response: unknown
							}
							return Result.gen(function* () {
								if (!state.started)
									return yield* Result.fail(
										at("event", "invalid", "output before response.created"),
									)
								const message = yield* toMessage(completed.response, model)
								const stopsResult = Array.from(HashMap.values(state.opened)).reduce<
									Result.Result<readonly string[], ConversionError>
								>(
									(previous, active) =>
										Result.gen(function* () {
											const output = yield* previous
											return [
												...output,
												yield* frame({
													type: "content_block_stop",
													index: active.index,
												}),
											]
										}),
									Result.succeed([]),
								)
								const stops = yield* stopsResult
								return [
									{ ...state, finished: true, opened: HashMap.empty() },
									[
										...stops,
										yield* frame({
											type: "message_delta",
											delta: {
												stop_reason: message.stop_reason,
												stop_sequence: null,
											},
											usage: { output_tokens: message.usage.output_tokens },
										}),
									],
								] as const
							})
						},
					),
					Match.whenOr({ type: "response.failed" }, { type: "error" }, () =>
						Result.fail(at("event", "unsupported", "upstream response failed")),
					),
					Match.whenOr(
						{ type: "response.output_text.annotation.added" },
						{ type: "response.refusal.delta" },
						() => Result.fail(at("event.type", "unsupported", "annotation or refusal")),
					),
					Match.orElse(() => Result.succeed([state, []] as const)),
				) as Result.Result<readonly [FrameState, readonly string[]], ConversionError>
			}),
		),
	)
}

const errorFrame = (message: string): string =>
	Sse.encoder.write({
		_tag: "Event",
		event: "error",
		id: undefined,
		data: JSON.stringify(
			AnthropicMessagesHttpError.make({
				type: "error",
				error: { type: "api_error", message },
			}),
		),
	})

const frames = (
	source: Stream.Stream<GenerationEvent, unknown>,
	model: string,
): Stream.Stream<string> =>
	Stream.concat(source, Stream.succeed({ type: "end" as const })).pipe(
		Stream.mapAccumEffect(initial, (state, event) =>
			Effect.fromResult(project(state, event, model)),
		),
		Stream.catch((error) =>
			Stream.succeed(
				errorFrame(
					Schema.is(ConversionError)(error)
						? error.message
						: RouterError.guards.ProviderFailed(error)
							? error.cause.message
							: "Upstream stream failed",
				),
			),
		),
	)

const errorResponse = (status: number, message: string, type = "invalid_request_error") =>
	HttpServerResponse.jsonUnsafe(
		AnthropicMessagesHttpError.make({ type: "error", error: { type, message } }),
		{ status },
	)

function onError(error: unknown): HttpServerResponse.HttpServerResponse {
	if (Schema.is(HttpJsonError)(error)) return errorResponse(error.status, error.message)
	if (Schema.is(ConversionError)(error))
		return errorResponse(error.reason === "unsupported" ? 422 : 400, error.message)
	if (Schema.is(RouterError)(error))
		return RouterError.match(error, {
			NoRoute: ({ model }) =>
				errorResponse(404, `Unknown model: ${model}`, "not_found_error"),
			InvalidRequest: ({ message }) => errorResponse(400, message),
			UnsupportedCapability: ({ capability }) =>
				errorResponse(422, `Unsupported capability: ${capability}`),
			NoAvailableDeployment: () => errorResponse(503, "No deployment available", "api_error"),
			ProviderFailed: ({ cause }) =>
				errorResponse(
					Match.value(cause.kind).pipe(
						Match.when("rate_limited", () => 429),
						Match.when("timeout", () => 504),
						Match.when("unavailable", () => 503),
						Match.when("invalid_request", () => 400),
						Match.when("unsupported", () => 422),
						Match.orElse(() => 502),
					),
					cause.message,
					"api_error",
				),
			InvalidResponse: () => errorResponse(502, "Model execution failed", "api_error"),
			RoutingFailed: () => errorResponse(502, "Model execution failed", "api_error"),
			MiddlewareFailed: () => errorResponse(502, "Model execution failed", "api_error"),
		})
	return errorResponse(500, "Gateway failed", "api_error")
}

const handle = (
	router: Router,
	request: HttpServerRequest.HttpServerRequest,
	key: Redacted.Redacted<string>,
) =>
	Effect.gen(function* () {
		const authorized =
			request.headers["x-api-key"] === Redacted.value(key) ||
			request.headers.authorization === `Bearer ${Redacted.value(key)}`
		if (!authorized) return errorResponse(401, "Invalid gateway key", "authentication_error")
		if (request.headers["anthropic-version"] !== "2023-06-01")
			return errorResponse(400, "Unsupported anthropic-version")
		const body = yield* readJson(request, true)
		const nativeRequest = yield* Effect.fromResult(toNativeRequest(body))
		const direct =
			nativeRequest.stream === true
				? Option.some(
						yield* router.invoke({
							type: "protocol",
							request: {
								protocol: "anthropic.messages",
								model: nativeRequest.model,
								body,
								headers: Object.fromEntries(Object.entries(request.headers)),
							},
						}),
					)
				: Option.none<Execution>()
		if (Option.isSome(direct) && direct.value.type === "opaque") {
			const body = direct.value.response.body.pipe(
				Stream.catch((error) =>
					Stream.succeed(
						new TextEncoder().encode(
							errorFrame(
								error instanceof Error ? error.message : "Upstream stream failed",
							),
						),
					),
				),
			)
			return HttpServerResponse.stream(body, {
				status: direct.value.response.status,
				headers: direct.value.response.headers,
				contentType: direct.value.response.headers["content-type"],
			})
		}
		const converted = yield* Effect.fromResult(toResponseRequest(body))
		if (converted.stream) {
			const execution = Option.isSome(direct)
				? direct.value
				: yield* router.invoke({ type: "generation", request: converted })
			if (execution.type !== "generation")
				return yield* Effect.fail(
					RouterError.cases.InvalidResponse.make({
						message: "Expected generation events",
					}),
				)
			const events = execution.events
			return HttpServerResponse.stream(
				projection.encodeEvents!(events, { model: converted.model }).pipe(
					Stream.encodeText,
				),
				{
					headers: { "cache-control": "no-cache", "x-accel-buffering": "no" },
					contentType: "text/event-stream; charset=utf-8",
				},
			)
		}
		const execution = yield* router.invoke({ type: "generation", request: converted })
		if (execution.type !== "generation")
			return yield* Effect.fail(
				RouterError.cases.InvalidResponse.make({ message: "Expected generation events" }),
			)
		const result = yield* completeGeneration(execution.events)
		const message = yield* Effect.fromResult(toMessage(result, converted.model)).pipe(
			Effect.mapError((error) =>
				RouterError.cases.InvalidResponse.make({ message: error.message }),
			),
		)
		return HttpServerResponse.jsonUnsafe(message)
	}).pipe(Effect.catch((error) => Effect.succeed(onError(error))))

export function make(options: AnthropicMessagesHttpOptions): HttpContribution<typeof api> {
	return {
		api,
		routes: (router) =>
			HttpApiBuilder.layer(api).pipe(
				Layer.provide(
					HttpApiBuilder.group(api, "anthropicMessages", (handlers) =>
						handlers.handleRaw("create", ({ request }) =>
							handle(router, request, options.gatewayKey),
						),
					),
				),
			),
	}
}
