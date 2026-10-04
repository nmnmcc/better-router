import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Context, Effect, Layer, Stream } from "effect"
import * as Generation from "@better-router/core/Generation"
import * as Route from "@better-router/core/Route"
import * as Router from "@better-router/core/Router"

class ProviderFixture extends Context.Service<ProviderFixture, { readonly id: string }>()(
	"BetterRouterProviderFixture",
) {}

const route = Route.layer({
	chat: (_request: Route.Request<"chat">) =>
		Effect.gen(function* () {
			const provider = yield* ProviderFixture
			return yield* Generation.Process.make(
				Stream.succeed({
					type: "response.completed" as const,
					sequence_number: 0,
					response: { id: provider.id, status: "completed" } as never,
				}),
			)
		}),
})

it.effect("composes provider Layers into Route and exposes Generation.Process", () =>
	Effect.gen(function* () {
		const providers = [Layer.succeed(ProviderFixture, { id: "provider" })] as const
		const router = yield* Router.make({
			route,
			providers,
		})
		const process = yield* router.generate({ model: "chat", input: [] })
		const response = yield* process.response
		assert.equal(response.id, "provider")
	}),
)
