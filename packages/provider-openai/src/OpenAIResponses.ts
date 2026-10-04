import { Context, Effect, Layer, Match, Redacted, Result, Schema, Stream } from "effect"
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
import * as RouterPlugin from "@better-router/core/Plugin"

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

export class OpenAIResponses extends Context.Service<OpenAIResponses, Service>()(
	"BetterRouterOpenAIResponses",
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

const requestBody = (request: Request): Readonly<Record<string, unknown>> => ({
	...request,
	model: request.model,
	stream: true,
})

type StreamState = { readonly terminal: boolean; readonly done: boolean }

const streamEvents = (
	bytes: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<CoreGeneration.Event, ProviderError> => {
	const frames = bytes.pipe(
		Stream.decodeText(),
		Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1024 * 1024 })),
	)
	return Stream.concat(
		Stream.map(frames, (frame) => ({ type: "frame" as const, frame })),
		Stream.succeed({ type: "end" as const }),
	).pipe(
		Stream.mapAccumEffect(
			(): StreamState => ({ terminal: false, done: false }),
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
								if (state.terminal)
									return yield* Effect.fail(
										failure(
											"unknown",
											"OpenAI emitted an event after the terminal event",
										),
									)
								return [
									{ ...state, terminal: terminal || state.terminal },
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
			HttpClientRequest.bodyJsonUnsafe(requestBody({ ...parsed, model: config.model })),
			withOrganization,
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
		const events = contentType.startsWith("text/event-stream")
			? streamEvents(response.stream)
			: Stream.map(
					Stream.fromEffect(response.json).pipe(
						Stream.mapError((cause) =>
							failure("unknown", "Unable to read OpenAI response", false, cause),
						),
					),
					responseEvents,
				).pipe(Stream.flatten)
		return yield* CoreGeneration.Process.make(events)
	})

export const layer = (
	config: unknown,
): Layer.Layer<OpenAIResponses, ConfigError, HttpClient.HttpClient> =>
	Layer.effect(
		OpenAIResponses,
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

/** Stable provider capability; credentials and model selection belong to state. */
export const capability = Capability.make({
	id: "provider.openai.responses",
	version: 1,
	kind: "provider",
	projections: ["generation"],
} as const)

type PluginState = { readonly providers: readonly [ReturnType<typeof layer>] }

export type Plugin = RouterPlugin.RouterPlugin<
	"openai-responses-provider",
	readonly [typeof capability],
	PluginState
>

/** Better Auth-style provider plugin. Configuration is captured only in state. */
export const plugin = (config: unknown): Plugin =>
	RouterPlugin.make({
		id: "openai-responses-provider",
		capabilities: [capability] as const,
		state: { providers: [layer(config)] as const },
	})

export const makePlugin = plugin
