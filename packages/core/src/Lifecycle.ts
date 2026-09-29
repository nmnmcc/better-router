import { Context, Effect, PubSub, Stream } from "effect"

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

export class ExecutionLifecycle extends Context.Service<ExecutionLifecycle, Lifecycle>()(
	"ExecutionLifecycle",
) {}

/** Bounded fan-out observation; durable audit belongs to a persistence adapter. */
export const make = (capacity = 256): Effect.Effect<Lifecycle> =>
	Effect.map(PubSub.bounded<LifecycleEvent>(capacity), (pubsub) => ({
		publish: (event) => PubSub.publish(pubsub, event),
		events: Stream.fromPubSub(pubsub),
	}))
