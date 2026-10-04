import { Context, Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "tstyche"
import * as Generation from "@better-router/core/Generation"
import * as Route from "@better-router/core/Route"

class Provider extends Context.Service<Provider, { readonly name: string }>()(
	"BetterRouterRouteTypeProvider",
) {}

const terminal = {
	type: "response.completed" as const,
	sequence_number: 0,
	response: { id: "response", status: "completed" } as never,
}

describe("Route.layer", () => {
	it("infers the handler map and its provider requirements", () => {
		const layer = Route.layer({
			chat: (request: Route.Request<"chat">) =>
				Effect.gen(function* () {
					void request
					const provider = yield* Provider
					return yield* Generation.Process.make(
						Stream.succeed({
							...terminal,
							response: { id: provider.name, status: "completed" } as never,
						}),
					)
				}),
		})
		expect<typeof layer>().type.toBe<Layer.Layer<Route.Route, never, Provider>>()
	})
})
