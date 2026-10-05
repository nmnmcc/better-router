import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Ref } from "effect"
import * as Hooks from "../src/Hooks.js"

const request = { model: "chat", input: [] } as const
const context: Hooks.RequestHookContext = {
	request,
	model: "chat",
	metadata: {},
	signals: {},
}

it.effect("runs composed hooks in declaration order", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const mark =
			(name: string): Hooks.HookEffect<Hooks.RequestHookContext> =>
			() =>
				Ref.update(seen, (values) => [...values, name])
		const hooks = Hooks.compose([
			{ beforeRequest: [mark("first")] },
			{ beforeRequest: [mark("second")] },
		])

		yield* Hooks.runBeforeRequest(hooks, context)
		assert.deepEqual(yield* Ref.get(seen), ["first", "second"])
	}),
)
