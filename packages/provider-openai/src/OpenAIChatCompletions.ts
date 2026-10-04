import { Context, Effect, Layer, Match, Redacted, Result, Schema, Stream } from "effect"
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

export class OpenAIChatCompletions extends Context.Service<OpenAIChatCompletions, Service>()(
	"BetterRouterOpenAIChatCompletions",
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
const valueRecord = Schema.Record(Schema.String, Schema.Unknown)
const deltaSchema = Schema.Struct({
	content: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
	tool_calls: Schema.optional(Schema.Array(valueRecord)),
})
const choiceSchema = Schema.Struct({
	delta: deltaSchema,
	finish_reason: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
})
const chunkSchema = Schema.Struct({
	id: Schema.String,
	created: Schema.Number,
	model: Schema.String,
	choices: Schema.Array(choiceSchema),
	usage: Schema.optional(valueRecord),
})

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const toolFields = (value: Readonly<Record<string, unknown>>) => {
	const fn = value.function
	const functionValue =
		typeof fn === "object" && fn !== null
			? (fn as Readonly<Record<string, unknown>>)
			: undefined
	return {
		id: text(value.id),
		name: functionValue ? text(functionValue.name) : undefined,
		arguments: functionValue ? text(functionValue.arguments) : undefined,
	}
}

type ParserState = {
	readonly started: boolean
	readonly id: string
	readonly tools: readonly string[]
	readonly usage: GenerationResponse["usage"]
	readonly finish: FinishReason | undefined
	readonly done: boolean
}

const finishReason = (reason: string): FinishReason =>
	reason === "length" || reason === "content_filter"
		? reason === "length"
			? "length"
			: "content_filter"
		: reason === "tool_calls"
			? "tool_calls"
			: "stop"

const usage = (
	value: Readonly<Record<string, unknown>> | undefined,
): GenerationResponse["usage"] => {
	const input = typeof value?.prompt_tokens === "number" ? value.prompt_tokens : 0
	const output = typeof value?.completion_tokens === "number" ? value.completion_tokens : 0
	return value
		? {
				input_tokens: input,
				output_tokens: output,
				total_tokens:
					typeof value.total_tokens === "number" ? value.total_tokens : input + output,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			}
		: null
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
				tools: [],
				usage: null,
				finish: undefined,
				done: false,
			}),
			(
				state,
				entry,
			): Effect.Effect<readonly [ParserState, readonly NativeChunk[]], ProviderError> =>
				entry.type === "end"
					? state.done
						? Effect.succeed([state, [] as readonly NativeChunk[]] as const)
						: state.finish
							? Effect.succeed([
									state,
									[
										{
											type: "finish" as const,
											reason: state.finish,
											...(state.usage === null ? {} : { usage: state.usage }),
										},
									],
								] as const)
							: Effect.fail(
									failure("unknown", "Chat stream ended without a finish reason"),
								)
					: entry.frame.data === "[DONE]"
						? state.finish
							? Effect.succeed([
									{ ...state, done: true },
									[
										{
											type: "finish" as const,
											reason: state.finish,
											...(state.usage === null ? {} : { usage: state.usage }),
										},
									],
								] as const)
							: Effect.fail(
									failure("unknown", "Chat stream ended without a finish reason"),
								)
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
								const choice = chunk.choices[0]
								const initial = state.started
									? []
									: ([
											{
												type: "start" as const,
												id: chunk.id,
												createdAt: chunk.created,
												model: chunk.model,
											},
										] satisfies readonly NativeChunk[])
								const content = choice?.delta.content
								const textChunk =
									typeof content === "string"
										? [{ type: "text" as const, value: content }]
										: []
								const calls = choice?.delta.tool_calls ?? []
								const toolResult = calls.reduce<
									readonly [readonly string[], readonly NativeChunk[]]
								>(
									(result, call) => {
										const [known, output] = result
										const fields = toolFields(call)
										const id = fields.id ?? `tool-${known.length}`
										const started = known.includes(id)
										const next = started
											? []
											: [
													{
														type: "tool_start" as const,
														id,
														name: fields.name ?? "function",
													},
												]
										const delta = fields.arguments
											? [
													{
														type: "tool_delta" as const,
														id,
														value: fields.arguments,
													},
												]
											: []
										return [
											started ? known : [...known, id],
											[...output, ...next, ...delta],
										]
									},
									[state.tools, []],
								)
								const finish = choice?.finish_reason
									? finishReason(choice.finish_reason)
									: state.finish
								const currentUsage = chunk.usage ? usage(chunk.usage) : state.usage
								return [
									{
										started: true,
										id: chunk.id,
										tools: toolResult[0],
										usage: currentUsage,
										finish,
										done: false,
									},
									[...initial, ...textChunk, ...toolResult[1]],
								]
							}),
		),
		Stream.mapError((cause) =>
			Schema.is(ProviderError)(cause)
				? cause
				: failure("unknown", "Chat Completions stream failed", false, cause),
		),
	) as unknown as Stream.Stream<NativeChunk, ProviderError>
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
		const input = typeof parsed.input === "string" ? [] : (parsed.input ?? [])
		if (
			input.some(
				(item) =>
					item.type !== "message" &&
					item.type !== "function_call" &&
					item.type !== "function_call_output",
			)
		)
			return yield* Effect.fail(
				failure("unsupported", "Chat Completions cannot represent this input item"),
			)
		if ((parsed.tools ?? []).some((tool) => tool.type !== "function"))
			return yield* Effect.fail(
				failure("unsupported", "Chat Completions cannot represent this tool"),
			)
		if (
			parsed.tool_choice &&
			typeof parsed.tool_choice !== "string" &&
			(parsed.tool_choice.type !== "function" || !parsed.tool_choice.name)
		)
			return yield* Effect.fail(
				failure("unsupported", "Chat Completions cannot represent this tool choice"),
			)
		if (parsed.text?.verbosity)
			return yield* Effect.fail(
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
			return yield* Effect.fail(
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
			return yield* Effect.fail(
				failure("unsupported", "Chat Completions cannot represent one or more options"),
			)
		const organization = config.organization
			? HttpClientRequest.setHeader("openai-organization", config.organization)
			: (value: HttpClientRequest.HttpClientRequest) => value
		const outgoing = HttpClientRequest.post(
			(config.url ?? new URL("https://api.openai.com/v1/chat/completions")).toString(),
		).pipe(
			HttpClientRequest.bearerToken(config.apiKey),
			HttpClientRequest.setHeader("content-type", "application/json"),
			HttpClientRequest.bodyJsonUnsafe(requestBody({ ...parsed, model: config.model })),
			organization,
		)
		const response = yield* client
			.execute(outgoing)
			.pipe(
				Effect.mapError((cause) =>
					failure("unavailable", "OpenAI connection failed", true, cause),
				),
			)
		if (response.status < 200 || response.status >= 300)
			return yield* Effect.fail(statusError(response.status))
		const contentType = response.headers["content-type"]?.toLowerCase() ?? ""
		const source = contentType.startsWith("text/event-stream")
			? nativeEvents(response.stream)
			: Stream.fail(
					failure("unsupported", "Chat Completions provider requires an event stream"),
				)
		return yield* Generation.Process.make(fromNative(parsed, source))
	})

export const layer = (
	config: unknown,
): Layer.Layer<OpenAIChatCompletions, ConfigError, HttpClient.HttpClient> =>
	Layer.effect(
		OpenAIChatCompletions,
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
