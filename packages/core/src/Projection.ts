import { Effect, HashMap, Match, Option, Result, Schema, Stream } from "effect"
import { ConversionError } from "./Conversion.js"
import type { GenerationEvent, GenerationRequest, GenerationResponse } from "./Generation.js"
import type { ProtocolRequest } from "./Pipeline.js"
import type { Identifier } from "./Identifier.js"

/** The plugin-facing command is distinct from the internally selected protocol. */
export type Command =
	| { readonly type: "generation"; readonly request: GenerationRequest }
	| { readonly type: "protocol"; readonly request: ProtocolRequest }

/** Only generation commands are writable; opaque wire payloads remain untouched. */
export type View =
	| { readonly type: "generation"; readonly request: GenerationRequest }
	| { readonly type: "opaque"; readonly protocol: string; readonly model: string }

export class ProjectionError extends Schema.TaggedError<ProjectionError>()("ProjectionError", {
	message: Schema.String,
}) {}

export interface StreamProjectionContext {
	readonly model: string
	readonly includeUsage?: boolean
}

/** A protocol projection is the only boundary allowed to know a wire contract. */
export interface ProtocolDefinition<
	WireEvent = unknown,
	WireResponse = unknown,
	Id extends string = string,
	Protocol extends string = string,
	Capability extends string = string,
> {
	readonly id: Identifier<Id>
	readonly protocol: Identifier<Protocol>
	readonly capability: Identifier<Capability>
	readonly decode: (value: unknown) => Result.Result<GenerationRequest, ConversionError>
	readonly encodeEvent: (event: GenerationEvent) => Result.Result<WireEvent, ConversionError>
	readonly encodeResponse: (
		response: GenerationResponse,
	) => Result.Result<WireResponse, ConversionError>
	/** Stateful event projection for protocols whose wire stream needs ordering or indexes. */
	readonly encodeEvents?: (
		events: Stream.Stream<GenerationEvent, unknown>,
		context: StreamProjectionContext,
	) => Stream.Stream<WireEvent, unknown>
}

export interface Session<Command, Event, View, Error, Requirements = never> {
	readonly send: (command: Command) => Effect.Effect<void, Error, Requirements>
	readonly events: Stream.Stream<Event, Error, Requirements>
	readonly view: Effect.Effect<View, Error, Requirements>
	readonly complete: Effect.Effect<View, Error, Requirements>
	readonly cancel: Effect.Effect<void, never, Requirements>
}

export interface Definition<
	Request,
	Command,
	Event,
	View,
	Error,
	Requirements = never,
	Id extends string = string,
	Capability extends string = string,
> {
	readonly id: Identifier<Id>
	readonly capability: Identifier<Capability>
	readonly decode: (value: unknown) => Result.Result<Request, ProjectionError>
	readonly open: (
		request: Request,
	) => Effect.Effect<
		Session<Command, Event, View, Error, Requirements>,
		ProjectionError | Error,
		Requirements
	>
}

export const view = (
	command: Command,
	definitions?: HashMap.HashMap<string, ProtocolDefinition>,
): View =>
	Match.value(command).pipe(
		Match.discriminatorsExhaustive("type")({
			generation: (value) => ({
				type: "generation" as const,
				request: value.request,
			}),
			protocol: (value) => {
				const projected = definitions
					? toGeneration(value, definitions)
					: Result.fail(
							ConversionError.make({
								path: "request.protocol",
								reason: "unsupported",
								message: "No projection catalog was supplied",
							}),
						)
				return Result.isSuccess(projected)
					? { type: "generation" as const, request: projected.success }
					: {
							type: "opaque" as const,
							protocol: value.request.protocol,
							model: value.request.model,
						}
			},
		}),
	)

export const toGeneration = (
	command: Command,
	definitions: HashMap.HashMap<string, ProtocolDefinition>,
): Result.Result<GenerationRequest, ConversionError> =>
	Match.value(command).pipe(
		Match.discriminatorsExhaustive("type")({
			generation: (value) => Result.succeed(value.request),
			protocol: (value) => {
				const definition = HashMap.get(definitions, value.request.protocol)
				return Option.isSome(definition)
					? definition.value.decode(value.request.body)
					: Result.fail(
							ConversionError.make({
								path: "request.protocol",
								reason: "unsupported",
								message: `No projection is registered for ${value.request.protocol}`,
							}),
						)
			},
		}),
	)
