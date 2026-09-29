import { Effect, Match, Result, Schema, Stream } from "effect"
import type { Redacted } from "effect"
import { Sse } from "effect/unstable/encoding"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ProviderError } from "@better-router/core/Deployment"
import type { Deployment, GenerationExecutor } from "@better-router/core/Deployment"
import type { ProtocolResponse, SelectedRequest } from "@better-router/core/Pipeline"
import type { GenerationEvent, GenerationResponse } from "@better-router/core/Generation"
import { Event } from "./OpenAIResponsesSchema.js"
import { toResponseRequest } from "./OpenAIResponsesHttp.js"

export interface OpenAIResponsesDeploymentConfig<Id extends string = string> {
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

export class OpenAIResponsesInvalidDeploymentUrl extends Schema.TaggedError<OpenAIResponsesInvalidDeploymentUrl>()(
	"OpenAIResponsesInvalidDeploymentUrl",
	{
		message: Schema.String,
	},
) {}

/** The WebSocket path is optional per deployment, not per provider or ingress. */
export interface OpenAIResponsesDeployment<
	Requirements = never,
	Id extends string = string,
> extends Deployment<Requirements, Id, "openai", "openai.responses"> {
	readonly provider: "openai"
	readonly protocol: "openai.responses"
	readonly execute: {
		readonly http: GenerationExecutor<Requirements>
		readonly websocket?: GenerationExecutor<Requirements>
		readonly direct?: (
			request: SelectedRequest,
		) => Effect.Effect<ProtocolResponse, ProviderError, Requirements>
	}
}

const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodeEvent = Schema.decodeUnknownEffect(Event)
const isProviderError = Schema.is(ProviderError)

const isResponseStatus = (event: GenerationEvent, status: GenerationResponse["status"]): boolean =>
	(event as { readonly response: GenerationResponse }).response.status === status

const failure = (
	kind: ProviderError["kind"],
	message: string,
	retryable = false,
	cause?: unknown,
): ProviderError =>
	ProviderError.make({ kind, message, retryable, ...(cause === undefined ? {} : { cause }) })

const statusError = (status: number): ProviderError =>
	Match.value(status).pipe(
		Match.when(429, () => failure("rate_limited", "Upstream rate limited the request", true)),
		Match.whenOr(401, 403, () => failure("unauthorized", "Upstream authentication failed")),
		Match.whenOr(408, 504, () => failure("timeout", "Upstream request timed out")),
		Match.orElse((value) =>
			value >= 500
				? failure("unavailable", "Upstream is unavailable")
				: failure("invalid_request", `Upstream rejected the request (${value})`),
		),
	)

function events(
	bytes: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<GenerationEvent, ProviderError> {
	const frames = bytes.pipe(
		Stream.decodeText(),
		Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1024 * 1024 })),
	)
	return Stream.concat(
		Stream.map(frames, (frame) => ({ kind: "frame" as const, frame })),
		Stream.succeed({ kind: "end" as const }),
	).pipe(
		Stream.mapAccumEffect(
			() => ({ terminal: false, done: false }),
			(state, entry) =>
				Match.value(entry).pipe(
					Match.discriminatorsExhaustive("kind")({
						end: () =>
							state.terminal
								? Effect.succeed([state, []] as const)
								: Effect.fail(
										failure(
											"unknown",
											"Upstream stream ended without a terminal response",
										),
									),
						frame: ({ frame }) =>
							Effect.gen(function* () {
								if (frame.data === "[DONE]") {
									if (!state.terminal || state.done)
										return yield* Effect.fail(
											failure(
												"unknown",
												"Upstream ended before a terminal response",
											),
										)
									return [{ ...state, done: true }, []] as const
								}
								if (state.terminal)
									return yield* Effect.fail(
										failure("unknown", "Events followed the terminal response"),
									)
								const value = yield* json(frame.data).pipe(
									Effect.mapError((cause) =>
										failure(
											"unknown",
											"Invalid upstream SSE JSON",
											false,
											cause,
										),
									),
								)
								const parsed = yield* decodeEvent(value).pipe(
									Effect.mapError((cause) =>
										failure(
											"unknown",
											`Invalid upstream event: ${cause.message}`,
											false,
											cause,
										),
									),
								)
								if (frame.event !== "message" && frame.event !== parsed.type)
									return yield* Effect.fail(
										failure("unknown", "Upstream SSE event type mismatch"),
									)
								const terminal = Match.value(parsed).pipe(
									Match.when({ type: "response.completed" }, (item) => {
										return {
											terminal: true,
											valid: isResponseStatus(item, "completed"),
										}
									}),
									Match.when({ type: "response.incomplete" }, (item) => {
										return {
											terminal: true,
											valid: isResponseStatus(item, "incomplete"),
										}
									}),
									Match.when({ type: "response.failed" }, (item) => {
										return {
											terminal: true,
											valid: isResponseStatus(item, "failed"),
										}
									}),
									Match.orElse(() => ({ terminal: false, valid: true })),
								)
								if (!terminal.valid)
									return yield* Effect.fail(
										failure("unknown", "Invalid terminal response snapshot"),
									)
								return [
									{ ...state, terminal: terminal.terminal },
									[parsed],
								] as const
							}),
					}),
				),
		),
		Stream.mapError((cause): ProviderError =>
			isProviderError(cause)
				? cause
				: failure("unknown", "Upstream event stream failed", false, cause),
		),
	)
}

interface NativeEventState {
	readonly terminal: boolean
	readonly done: boolean
	readonly pending: readonly Uint8Array[]
}

type NativeEventEntry =
	{ readonly kind: "frame"; readonly frame: Sse.Event } | { readonly kind: "end" }

const nativeEvents = (
	bytes: Stream.Stream<Uint8Array, unknown>,
): Stream.Stream<Uint8Array, ProviderError> => {
	const frames = bytes.pipe(
		Stream.decodeText(),
		Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1024 * 1024 })),
	)
	const entries: Stream.Stream<NativeEventEntry, unknown> = Stream.concat(
		Stream.map(frames, (frame) => ({ kind: "frame" as const, frame })),
		Stream.succeed({ kind: "end" as const }),
	)
	return entries.pipe(
		Stream.mapAccumEffect(
			(): NativeEventState => ({ terminal: false, done: false, pending: [] }),
			(state, entry) =>
				Match.value(entry).pipe(
					Match.discriminatorsExhaustive("kind")({
						end: () =>
							state.done
								? Effect.succeed([state, state.pending] as const)
								: Effect.fail(
										failure("unknown", "Upstream stream ended without [DONE]"),
									),
						frame: ({ frame }) =>
							Effect.gen(function* () {
								if (frame.data === "[DONE]") {
									if (!state.terminal || state.done)
										return yield* Effect.fail(
											failure(
												"unknown",
												"Upstream ended before a terminal response",
											),
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
										{
											...state,
											done: true,
											pending: [...state.pending, encoded],
										},
										[],
									] as const
								}
								if (state.terminal || state.done)
									return yield* Effect.fail(
										failure("unknown", "Events followed the terminal response"),
									)
								const value = yield* json(frame.data).pipe(
									Effect.mapError((cause) =>
										failure(
											"unknown",
											"Invalid upstream SSE JSON",
											false,
											cause,
										),
									),
								)
								const parsed = yield* decodeEvent(value).pipe(
									Effect.mapError((cause) =>
										failure(
											"unknown",
											`Invalid upstream event: ${cause.message}`,
											false,
											cause,
										),
									),
								)
								if (
									frame.event !== undefined &&
									frame.event !== "message" &&
									frame.event !== parsed.type
								)
									return yield* Effect.fail(
										failure("unknown", "Upstream SSE event type mismatch"),
									)
								const terminal = Match.value(parsed).pipe(
									Match.when({ type: "response.completed" }, (item) => {
										return {
											terminal: true,
											valid: isResponseStatus(item, "completed"),
										}
									}),
									Match.when({ type: "response.incomplete" }, (item) => {
										return {
											terminal: true,
											valid: isResponseStatus(item, "incomplete"),
										}
									}),
									Match.when({ type: "response.failed" }, (item) => {
										return {
											terminal: true,
											valid: isResponseStatus(item, "failed"),
										}
									}),
									Match.orElse(() => ({ terminal: false, valid: true })),
								)
								if (!terminal.valid)
									return yield* Effect.fail(
										failure("unknown", "Invalid terminal response snapshot"),
									)
								const encoded = new TextEncoder().encode(
									Sse.encoder.write({
										_tag: "Event",
										event: frame.event,
										id: frame.id,
										data: frame.data,
									}),
								)
								return terminal.terminal
									? ([
											{
												...state,
												terminal: true,
												pending: [...state.pending, encoded],
											},
											[],
										] as const)
									: ([state, [encoded]] as const)
							}),
					}),
				),
		),
		Stream.mapError((cause): ProviderError =>
			isProviderError(cause)
				? cause
				: failure("unknown", "Upstream native stream failed", false, cause),
		),
	)
}

/** Bind a private OpenAI Responses model and credentials to an Effect HTTP executor. */
export function make<const Id extends string>(
	config: OpenAIResponsesDeploymentConfig<Id>,
): Result.Result<
	OpenAIResponsesDeployment<HttpClient.HttpClient, Id>,
	OpenAIResponsesInvalidDeploymentUrl
> {
	const parsed = Schema.decodeUnknownResult(DeploymentConfig)(config)
	if (Result.isFailure(parsed)) {
		return Result.fail(
			OpenAIResponsesInvalidDeploymentUrl.make({
				message: parsed.failure.message,
			}),
		)
	}
	const url = parsed.success.url ?? new URL("https://api.openai.com/v1/responses")
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return Result.fail(
			OpenAIResponsesInvalidDeploymentUrl.make({
				message: "Responses URL must use HTTP(S)",
			}),
		)
	}
	return Result.succeed({
		id: config.id,
		provider: "openai",
		protocol: "openai.responses",
		model: parsed.success.model,
		execute: {
			direct: (request) =>
				Effect.gen(function* () {
					const body = yield* Schema.decodeUnknownEffect(
						Schema.Record(Schema.String, Schema.Unknown),
					)(request.body).pipe(
						Effect.mapError((cause) =>
							failure("invalid_request", cause.message, false, cause),
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
								failure("unavailable", "Upstream connection failed", false, cause),
							),
						)
					if (response.status < 200 || response.status >= 300)
						return yield* Effect.fail(statusError(response.status))
					return {
						status: response.status,
						headers: Object.fromEntries(Object.entries(response.headers)),
						body: nativeEvents(response.stream),
					}
				}),
			http: (request) =>
				Effect.gen(function* () {
					yield* Effect.fromResult(toResponseRequest(request)).pipe(
						Effect.mapError((error) =>
							failure(
								error.reason === "unsupported" ? "unsupported" : "invalid_request",
								error.message,
							),
						),
					)
					const extension = [
						...(Array.isArray(request.input) ? request.input : []),
						...(request.tools ?? []),
					].some((item) => item.type.includes(":"))
					if (extension || request.background) {
						return yield* Effect.fail(
							failure(
								"unsupported",
								extension
									? "OpenResponses extension items require a provider adapter"
									: "Background responses are not supported by this deployment",
							),
						)
					}
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
						HttpClientRequest.bodyJsonUnsafe({ ...request, stream: true }),
						organization,
					)
					const response = yield* client
						.execute(outgoing)
						.pipe(
							Effect.mapError((cause) =>
								failure("unavailable", "Upstream connection failed", false, cause),
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
							failure("unknown", "Expected an upstream event stream"),
						)
					}
					return events(response.stream)
				}),
		},
	})
}
