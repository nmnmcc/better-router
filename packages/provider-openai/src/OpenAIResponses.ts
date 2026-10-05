import { Effect, Exit, Match, Redacted, Result, Schema, Scope, Stream } from "effect"
import { Sse } from "effect/encoding"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as CoreGeneration from "@better-router/core/Generation"
import {
	Event as EventSchema,
	Request as RequestSchema,
	Response as ResponseSchema,
} from "@better-router/core/GenerationSchema"
import { Error as ProviderError } from "@better-router/core/Provider"
import * as Capability from "@better-router/core/Capability"

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

export class ConfigError extends Schema.TaggedError<ConfigError>()("OpenAIResponsesConfigError", {
	message: Schema.String,
}) {}

export type Request = CoreGeneration.Request
export type Process = CoreGeneration.GenerationProcess<ProviderError>

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
	"provider.openai.responses",
	"provider",
	"generation"
> = Capability.make({
	id: "provider.openai.responses",
	version: 1,
	kind: "provider",
	projections: ["generation"],
	endpoints: [
		{
			id: "responses",
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

const requestBody = (request: Request): Readonly<Record<string, unknown>> => ({
	...request,
	model: request.model,
	stream: true,
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

type StreamState = {
	readonly terminal: boolean
	readonly done: boolean
	readonly sequence: number
}

const streamEvents = (
	bytes: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<CoreGeneration.Event, ProviderError> => {
	const frames = decodeUtf8(bytes).pipe(
		Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1024 * 1024 })),
	)
	return Stream.concat(
		Stream.map(frames, (frame) => ({ type: "frame" as const, frame })),
		Stream.succeed({ type: "end" as const }),
	).pipe(
		Stream.mapAccumEffect(
			(): StreamState => ({ terminal: false, done: false, sequence: -1 }),
			(state, entry) =>
				entry.type === "end"
					? state.terminal
						? Effect.succeed([state, []] as const)
						: Effect.fail(
								failure("unknown", "OpenAI stream ended without a terminal event"),
							)
					: entry.frame.data === "[DONE]"
						? state.terminal && !state.done
							? Effect.succeed([{ ...state, done: true }, []] as const)
							: Effect.fail(failure("unknown", "Invalid OpenAI stream terminator"))
						: Effect.gen(function* () {
								const value = yield* json(entry.frame.data).pipe(
									Effect.mapError((cause) =>
										failure(
											"unknown",
											"Invalid OpenAI Responses SSE JSON",
											false,
											cause,
										),
									),
								)
								const event = yield* Schema.decodeUnknownEffect(EventSchema)(
									value,
								).pipe(
									Effect.mapError((cause) =>
										failure(
											"unknown",
											"Invalid OpenAI Responses event",
											false,
											cause,
										),
									),
								)
								const terminal =
									event.type === "response.completed" ||
									event.type === "response.incomplete" ||
									event.type === "response.failed"
								const statusMatches =
									event.type === "response.queued"
										? event.response.status === "queued"
										: event.type === "response.in_progress"
											? event.response.status === "in_progress"
											: event.type === "response.completed"
												? event.response.status === "completed"
												: event.type === "response.incomplete"
													? event.response.status === "incomplete"
													: event.type === "response.failed"
														? event.response.status === "failed"
														: true
								if (!statusMatches)
									return yield* Effect.fail(
										failure(
											"unknown",
											"OpenAI response event status does not match its type",
										),
									)
								if (event.sequence_number <= state.sequence)
									return yield* Effect.fail(
										failure(
											"unknown",
											"OpenAI response event sequence is not increasing",
										),
									)
								if (state.terminal)
									return yield* Effect.fail(
										failure(
											"unknown",
											"OpenAI emitted an event after the terminal event",
										),
									)
								return [
									{
										...state,
										terminal: terminal || state.terminal,
										sequence: event.sequence_number,
									},
									[event],
								] as const
							}),
		),
		Stream.mapError((cause) =>
			Schema.is(ProviderError)(cause)
				? cause
				: failure("unknown", "OpenAI event stream failed", false, cause),
		),
	) as unknown as Stream.Stream<CoreGeneration.Event, ProviderError>
}

const responseEvents = (value: unknown): Stream.Stream<CoreGeneration.Event, ProviderError> =>
	Stream.fromEffect(
		Schema.decodeUnknownEffect(ResponseSchema)(value).pipe(
			Effect.mapError((cause) =>
				failure("unknown", "Invalid OpenAI Responses JSON", false, cause),
			),
			Effect.flatMap((response) =>
				response.status === "completed" ||
				response.status === "incomplete" ||
				response.status === "failed"
					? Effect.succeed(response)
					: Effect.fail(
							failure("unknown", "OpenAI JSON response has no terminal status"),
						),
			),
			Effect.map((response) => {
				const type =
					response.status === "failed"
						? "response.failed"
						: response.status === "incomplete"
							? "response.incomplete"
							: "response.completed"
				return {
					type,
					sequence_number: 0,
					response,
				} as CoreGeneration.Event
			}),
		),
	)

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
					const parsed = yield* Schema.decodeUnknownEffect(RequestSchema)(request).pipe(
						Effect.mapError((cause) =>
							failure("invalid_request", "Invalid generation request", false, cause),
						),
					)
					const withOrganization = config.organization
						? HttpClientRequest.setHeader("openai-organization", config.organization)
						: (value: HttpClientRequest.HttpClientRequest) => value
					const outgoing = HttpClientRequest.post(
						(config.url ?? new URL("https://api.openai.com/v1/responses")).toString(),
					).pipe(
						HttpClientRequest.bearerToken(config.apiKey),
						HttpClientRequest.setHeader("content-type", "application/json"),
						HttpClientRequest.bodyJsonUnsafe(
							requestBody({ ...parsed, model: config.model }),
						),
						withOrganization,
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
					const events = contentType.startsWith("text/event-stream")
						? streamEvents(response.stream)
						: Stream.map(
								Stream.fromEffect(response.json).pipe(
									Stream.mapError((cause) =>
										failure(
											"unknown",
											"Unable to read OpenAI response",
											false,
											cause,
										),
									),
								),
								responseEvents,
							).pipe(Stream.flatten)
					const process = yield* CoreGeneration.Process.make(
						events.pipe(Stream.onExit((exit) => Scope.close(requestScope, exit))),
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

/**
 * Build a request executor for one deployment.
 *
 * The executor deliberately has no Context tag of its own.  A router can
 * therefore keep one executor per deployment without one deployment
 * overwriting another in a process-wide service registry.
 */
export const makeService = (config: Config, client: HttpClient.HttpClient): Service => ({
	generate: (request) => generate(client, config, request),
})

/** Pure request encoding used by transports and contract inspection tools. */
export const encodeRequest = (
	config: Config,
	request: Request,
): Result.Result<EncodedRequest, ProviderError> =>
	Schema.decodeUnknownResult(RequestSchema)(request).pipe(
		Result.mapError((cause) =>
			failure("invalid_request", "Invalid OpenAI Responses request", false, cause),
		),
		Result.map((parsed) => {
			const url = (config.url ?? new URL("https://api.openai.com/v1/responses")).toString()
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
