import { Context, Effect, Layer, Stream } from "effect"
import { describe, it } from "tstyche"
import * as Generation from "@better-router/core/Generation"
import * as Route from "@better-router/core/Route"
import * as Router from "@better-router/core/Router"

class Provider extends Context.Service<Provider, { readonly name: string }>()(
	"BetterRouterPluginTypeProvider",
) {}

describe("object plugins", () => {
	it("infer route state and provider state together", () => {
		const routes = Route.plugin({
			chat: (_request: Route.Request<"chat">) =>
				Effect.gen(function* () {
					const provider = yield* Provider
					return yield* Generation.Process.make(
						Stream.succeed({
							type: "response.completed" as const,
							sequence_number: 0,
							response: { id: provider.name, status: "completed" } as never,
						}),
					)
				}),
		})
		const providers = {
			id: "provider",
			state: { providers: [Layer.succeed(Provider, { name: "fixture" })] as const },
		}
		const composed = Router.make({ plugins: [routes, providers] as const })
		void composed
	})
})
