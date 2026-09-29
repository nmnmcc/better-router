import { Context, Deferred, Effect, Option, PubSub, Stream } from "effect"
import type { GenerationEvent, GenerationResponse } from "./Generation.js"
import type { ProtocolResponse } from "./Pipeline.js"
import { RouterError } from "./Router.js"

export interface ContextValue {
  readonly requestId: string
  readonly identity?: { readonly tenant: string; readonly subject: string }
  readonly deadline?: number
}

/** A host supplies this per request; plugins do not read global mutable state. */
export class ExecutionContext extends Context.Service<ExecutionContext, ContextValue>()("ExecutionContext") {}

export interface LifecycleEvent {
  readonly type: string
  readonly requestId: string
  readonly model: string
  readonly deployment?: string
}

export interface Lifecycle {
  readonly publish: (event: LifecycleEvent) => Effect.Effect<void>
  readonly events: Stream.Stream<LifecycleEvent>
}

export class ExecutionLifecycle extends Context.Service<ExecutionLifecycle, Lifecycle>()("ExecutionLifecycle") {}

/** Bounded fan-out observation; durable audit belongs to a persistence adapter. */
export const makeLifecycle = (capacity = 256): Effect.Effect<Lifecycle> =>
  Effect.map(PubSub.bounded<LifecycleEvent>(capacity), (pubsub) => ({
    publish: (event) => PubSub.publish(pubsub, event),
    events: Stream.fromPubSub(pubsub),
  }))

export type Execution = { readonly type: "generation"; readonly events: Stream.Stream<GenerationEvent, RouterError>; readonly cancel: Effect.Effect<void> } | { readonly type: "opaque"; readonly response: ProtocolResponse; readonly cancel: Effect.Effect<void> }

/** Every returned execution owns one cancellation signal for every subscription. */
export const generation = (events: Stream.Stream<GenerationEvent, RouterError>): Effect.Effect<Execution> =>
  Effect.map(Deferred.make<void>(), (cancelled) => ({
    type: "generation" as const,
    events: Stream.interruptWhen(Deferred.await(cancelled))(events),
    cancel: Deferred.succeed(cancelled, void 0),
  }))

export const opaque = (response: ProtocolResponse): Effect.Effect<Execution> =>
  Effect.map(Deferred.make<void>(), (cancelled) => ({
    type: "opaque" as const,
    response: { ...response, body: Stream.interruptWhen(Deferred.await(cancelled))(response.body) },
    cancel: Deferred.succeed(cancelled, void 0),
  }))

/** Consumption runs the same lazy generation stream once, with no second provider call. */
export const complete = (events: Stream.Stream<GenerationEvent, RouterError>): Effect.Effect<GenerationResponse, RouterError> =>
  Stream.runFoldEffect(
    events,
    () => Option.none<GenerationResponse>(),
    (previous, event) => (Option.isSome(previous) ? Effect.fail(invalid()) : Effect.succeed(event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed" ? Option.some(event.response) : previous)),
  ).pipe(Effect.flatMap((result) => Option.match(result, { onNone: () => Effect.fail(invalid()), onSome: Effect.succeed })))

const invalid = (): RouterError => RouterError.cases.InvalidResponse.make({ message: "Missing or duplicate terminal response" })
