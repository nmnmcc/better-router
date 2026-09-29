import { Context, Effect, HashMap, Layer, Option, Result, Schema, Stream } from "effect"
import { ConversionError } from "./Conversion.js"
import type { GenerationEvent, GenerationRequest, GenerationResponse } from "./Generation.js"
import type { ProtocolRequest } from "./Pipeline.js"

/** The plugin-facing command is distinct from the internally selected protocol. */
export type Command = { readonly type: "generation"; readonly request: GenerationRequest } | { readonly type: "protocol"; readonly request: ProtocolRequest }

/** Only generation commands are writable; opaque wire payloads remain untouched. */
export type View = { readonly type: "generation"; readonly request: GenerationRequest } | { readonly type: "opaque"; readonly protocol: string; readonly model: string }

export class ProjectionError extends Schema.TaggedError<ProjectionError>()("ProjectionError", {
  message: Schema.String,
}) {}

export interface StreamProjectionContext {
  readonly model: string
  readonly includeUsage?: boolean
}

/** A protocol projection is the only boundary allowed to know a wire contract. */
export interface ProtocolDefinition<WireEvent = unknown, WireResponse = unknown> {
  readonly id: string
  readonly protocol: string
  readonly capability: string
  readonly decode: (value: unknown) => Result.Result<GenerationRequest, ConversionError>
  readonly encodeEvent: (event: GenerationEvent) => Result.Result<WireEvent, ConversionError>
  readonly encodeResponse: (response: GenerationResponse) => Result.Result<WireResponse, ConversionError>
  /** Stateful event projection for protocols whose wire stream needs ordering or indexes. */
  readonly encodeEvents?: (events: Stream.Stream<GenerationEvent, unknown>, context: StreamProjectionContext) => Stream.Stream<WireEvent, unknown>
}

export interface Session<Command, Event, View, Error, Requirements = never> {
  readonly send: (command: Command) => Effect.Effect<void, Error, Requirements>
  readonly events: Stream.Stream<Event, Error, Requirements>
  readonly view: Effect.Effect<View, Error, Requirements>
  readonly complete: Effect.Effect<View, Error, Requirements>
  readonly cancel: Effect.Effect<void, never, Requirements>
}

export interface Definition<Request, Command, Event, View, Error, Requirements = never> {
  readonly id: string
  readonly capability: string
  readonly decode: (value: unknown) => Result.Result<Request, ProjectionError>
  readonly open: (request: Request) => Effect.Effect<Session<Command, Event, View, Error, Requirements>, ProjectionError | Error, Requirements>
}

export interface RuntimeService {
  readonly open: (id: string, request: unknown) => Effect.Effect<Session<unknown, unknown, unknown, unknown>, ProjectionError>
  readonly list: Effect.Effect<readonly string[]>
}

/** Dynamic lookup is only at the plugin composition seam; sessions stay typed inside each plugin. */
export class ProjectionRuntime extends Context.Service<ProjectionRuntime, RuntimeService>()("ProjectionRuntime") {}

export const view = (command: Command, definitions?: HashMap.HashMap<string, ProtocolDefinition>): View => {
  if (command.type === "generation") return { type: "generation", request: command.request }
  const projected = definitions ? toGeneration(command, definitions) : Result.fail(ConversionError.make({ path: "request.protocol", reason: "unsupported", message: "No projection catalog was supplied" }))
  return Result.isSuccess(projected) ? { type: "generation", request: projected.success } : { type: "opaque", protocol: command.request.protocol, model: command.request.model }
}

export const toGeneration = (command: Command, definitions: HashMap.HashMap<string, ProtocolDefinition>): Result.Result<GenerationRequest, ConversionError> => {
  if (command.type === "generation") return Result.succeed(command.request)
  const definition = HashMap.get(definitions, command.request.protocol)
  return Option.isSome(definition) ? definition.value.decode(command.request.body) : Result.fail(ConversionError.make({ path: "request.protocol", reason: "unsupported", message: `No projection is registered for ${command.request.protocol}` }))
}

export const makeRuntime = (definitions: readonly Definition<unknown, unknown, unknown, unknown, unknown>[]): Result.Result<RuntimeService, ProjectionError> =>
  Result.map(
    definitions.reduce<Result.Result<HashMap.HashMap<string, Definition<unknown, unknown, unknown, unknown, unknown>>, ProjectionError>>(
      (current, definition) =>
        Result.gen(function* () {
          const entries = yield* current
          if (HashMap.has(entries, definition.id)) return yield* Result.fail(ProjectionError.make({ message: `Duplicate projection: ${definition.id}` }))
          return HashMap.set(entries, definition.id, definition)
        }),
      Result.succeed(HashMap.empty()),
    ),
    (entries): RuntimeService => ({
      open: (id, input) =>
        Effect.gen(function* () {
          const definition = yield* Option.match(HashMap.get(entries, id), {
            onNone: () => Effect.fail(ProjectionError.make({ message: `Projection is not registered: ${id}` })),
            onSome: Effect.succeed,
          })
          const request = yield* Effect.fromResult(definition.decode(input))
          return yield* definition.open(request).pipe(Effect.mapError((cause) => ProjectionError.make({ message: cause instanceof Error ? cause.message : "Projection failed" })))
        }),
      list: Effect.succeed(Array.from(HashMap.keys(entries))),
    }),
  )

export const layer = (definitions: readonly Definition<unknown, unknown, unknown, unknown, unknown>[]): Layer.Layer<ProjectionRuntime, ProjectionError> => Layer.effect(ProjectionRuntime, Effect.fromResult(makeRuntime(definitions)))
