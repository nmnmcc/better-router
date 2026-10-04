import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Context, Effect, Layer, Stream } from "effect"
import * as Generation from "@better-router/core/Generation"
import * as Route from "@better-router/core/Route"

class RouteFixture extends Context.Service<RouteFixture, { readonly model: string }>()(
	"BetterRouterRouteFixture",
) {}

const routeLayer = Route.layer({
	chat: (_request: Route.Request) =>
		Effect.gen(function* () {
			const fixture = yield* RouteFixture
			return yield* Generation.Process.make(
				Stream.succeed({
					type: "response.completed" as const,
					sequence_number: 0,
					response: { id: fixture.model, status: "completed" } as never,
				}),
			)
		}),
})

const configured = Layer.provide(
	routeLayer,
	Layer.succeed(RouteFixture, { model: "fixture-model" }),
)

it.effect("captures handler services and returns a generation process", () =>
	Effect.gen(function* () {
		const route = yield* Route.Route
		const process = yield* route.generate({ model: "chat", input: [] })
		const response = yield* process.response
		assert.equal(response.id, "fixture-model")
	}).pipe(Effect.provide(configured)),
)

it.effect("rejects unknown models and malformed requests with Route errors", () =>
	Effect.gen(function* () {
		const route = yield* Route.Route
		const unknown = yield* Effect.flip(route.generate({ model: "missing", input: [] }))
		assert.equal(unknown._tag, "RouteUnknownModel")

		const invalid = yield* Effect.flip(route.generate({ model: "chat", input: 42 } as never))
		assert.equal(invalid._tag, "RouteInvalidRequest")
	}).pipe(Effect.provide(configured)),
)
