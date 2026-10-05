import { Effect, Result } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it } from "tstyche"
import type { GenerationRequest } from "@better-router/core/Generation"
import type { Process } from "@better-router/core/GenerationProcess"
import * as Registry from "@better-router/core/Registry"
import * as Route from "@better-router/core/Route"
import * as RoutingRuntime from "@better-router/core/RoutingRuntime"

const snapshot = Result.getOrThrow(Registry.fromPlugins([]))

describe("Route runtime types", () => {
	it("constructs a service from a preflighted snapshot and routing runtime", () => {
		const layer = Route.layer(snapshot)
		const service = Route.make(snapshot)

		expect<typeof layer>().type.toBe<
			Layer.Layer<Route.Route, unknown, RoutingRuntime.RoutingRuntime>
		>()
		expect<Effect.Success<typeof service>>().type.toBe<Route.Service>()
		expect<Effect.Services<typeof service>>().type.toBe<
			RoutingRuntime.RoutingRuntime | Scope.Scope
		>()
	})

	it("exposes one dependency-free process through the acquired route service", () => {
		const service = {} as Route.Service
		const generation = service.generate({ model: "chat", input: [] })
		const hosted = Route.generate({ model: "chat", input: [] })

		expect<Effect.Success<typeof generation>>().type.toBe<Process<unknown, never>>()
		expect<Effect.Services<typeof generation>>().type.toBe<never>()
		expect<Effect.Success<typeof hosted>>().type.toBe<Process<unknown, never>>()
		expect<Effect.Services<typeof hosted>>().type.toBe<Route.Route>()
	})

	it("retains the public model alias and the readonly generation input", () => {
		const request = { model: "chat", input: [] } as const satisfies Route.Request<"chat">

		expect<typeof request.model>().type.toBe<"chat">()
		expect<Route.Request<"chat">>().type.toBeAssignableTo<GenerationRequest>()
		expect<Route.Request<"chat">>().type.not.toBeAssignableTo<{ model: "other" }>()
	})

	it("does not accept the removed handler-map route alias API", () => {
		// @ts-expect-error! Route runtime construction requires a Registry snapshot.
		Route.layer({ chat: () => Result.succeed("legacy handler") })
	})
})
