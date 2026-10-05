import { Effect, Option, Result, Schema, Stream } from "effect"
import { at, fromSchema } from "@better-router/core/Convert"
import type {
	GenerationEvent,
	GenerationRequest,
	GenerationResponse,
} from "@better-router/core/Generation"
import {
	Event as GenerationEventSchema,
	Request as GenerationRequestSchema,
	Response as GenerationResponseSchema,
} from "@better-router/core/GenerationSchema"
import { ConversionError } from "@better-router/core/Convert"
import { Event, Request, Response } from "./Api.js"

const requestKeys = [
	"model",
	"input",
	"previous_response_id",
	"include",
	"tools",
	"tool_choice",
	"metadata",
	"text",
	"temperature",
	"top_p",
	"presence_penalty",
	"frequency_penalty",
	"parallel_tool_calls",
	"stream",
	"stream_options",
	"background",
	"max_output_tokens",
	"max_tool_calls",
	"reasoning",
	"safety_identifier",
	"prompt_cache_key",
	"truncation",
	"instructions",
	"store",
	"service_tier",
	"top_logprobs",
] as const

const rejectUnknownRequestKeys = (value: unknown): Result.Result<void, ConversionError> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return Result.void
	const key = Object.keys(value).find(
		(candidate) => !(requestKeys as readonly string[]).includes(candidate),
	)
	return key === undefined
		? Result.void
		: Result.fail(at(`request.${key}`, "unsupported", "request parameter"))
}

export const decodeRequest = (value: unknown): Result.Result<GenerationRequest, ConversionError> =>
	Result.gen(function* () {
		yield* rejectUnknownRequestKeys(value)
		const decoded = yield* Schema.decodeUnknownResult(Request)(value).pipe(
			Result.mapError((error) => fromSchema(error, "request")),
		)
		return yield* Schema.decodeUnknownResult(GenerationRequestSchema)(decoded).pipe(
			Result.mapError((error) => fromSchema(error, "request")),
		)
	})

export const encodeResponse = (
	value: GenerationResponse,
): Result.Result<GenerationResponse, ConversionError> =>
	Schema.decodeUnknownResult(GenerationResponseSchema)(value).pipe(
		Result.mapError((error) => fromSchema(error, "response")),
		Result.flatMap((decoded) =>
			decoded.status !== "completed" && decoded.status !== "incomplete"
				? Result.fail(
						at("response.status", "invalid", "Expected a successful terminal response"),
					)
				: Schema.encodeUnknownResult(Response)(decoded).pipe(
						Result.map(() => decoded),
						Result.mapError((error) => fromSchema(error, "response")),
					),
		),
	)

export const encodeEvent = (
	value: GenerationEvent,
): Result.Result<GenerationEvent, ConversionError> =>
	Schema.decodeUnknownResult(GenerationEventSchema)(value).pipe(
		Result.mapError((error) => fromSchema(error, "event")),
		Result.flatMap((decoded) =>
			Schema.encodeUnknownResult(Event)(decoded).pipe(
				Result.map(() => decoded),
				Result.mapError((error) => fromSchema(error, "event")),
			),
		),
	)

type StreamState = {
	readonly terminal: boolean
	readonly sequence: Option.Option<number>
}

type StreamEntry =
	{ readonly type: "event"; readonly event: GenerationEvent } | { readonly type: "end" }

const snapshotStatusMatches = (event: GenerationEvent): boolean => {
	if (event.type === "response.created" || event.type === "response.in_progress")
		return event.response.status === "in_progress"
	if (event.type === "response.queued") return event.response.status === "queued"
	if (event.type === "response.completed") return event.response.status === "completed"
	if (event.type === "response.incomplete") return event.response.status === "incomplete"
	if (event.type === "response.failed") return event.response.status === "failed"
	return true
}

/** Validate the success terminal independently for every SSE subscription. */
export const encodeStream = <E, R>(
	events: Stream.Stream<GenerationEvent, E, R>,
): Stream.Stream<GenerationEvent, E | ConversionError, R> => {
	const source: Stream.Stream<StreamEntry, E, R> = Stream.concat(
		events.pipe(Stream.map((event): StreamEntry => ({ type: "event", event }))),
		Stream.succeed<StreamEntry>({ type: "end" }),
	)
	return source.pipe(
		Stream.mapAccumEffect(
			(): StreamState => ({ terminal: false, sequence: Option.none() }),
			(state, entry) =>
				entry.type === "end"
					? state.terminal
						? Effect.succeed([state, [] as readonly GenerationEvent[]] as const)
						: Effect.fail(
								at(
									"event.type",
									"invalid",
									"Generation ended without a successful terminal event",
								),
							)
					: state.terminal
						? Effect.fail(
								at("event.type", "invalid", "Event followed the terminal event"),
							)
						: Effect.fromResult(encodeEvent(entry.event)).pipe(
								Effect.flatMap((event) =>
									Option.isSome(state.sequence) &&
									event.sequence_number <= state.sequence.value
										? Effect.fail(
												at(
													"event.sequence_number",
													"invalid",
													"Event sequence must increase",
												),
											)
										: !snapshotStatusMatches(event)
											? Effect.fail(
													at(
														"event.response.status",
														"invalid",
														"Terminal event and response status differ",
													),
												)
											: event.type === "error" ||
												  event.type === "response.failed"
												? Effect.fail(
														at(
															event.type === "error"
																? "event.error"
																: "event.response.error",
															"invalid",
															"Generation failed",
														),
													)
												: Effect.succeed([
														{
															sequence: Option.some(
																event.sequence_number,
															),
															terminal:
																event.type ===
																	"response.completed" ||
																event.type ===
																	"response.incomplete",
														},
														[event],
													] as const),
								),
							),
		),
	)
}
