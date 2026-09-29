import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Result, Stream } from "effect"
import { ProjectionError } from "@better-router/core/Projection"
import { layer, make, ProjectionRuntime } from "@better-router/core/Runtime"
import type { Definition } from "@better-router/core/Projection"

const definition = (
	id: string,
	open: Definition<unknown, unknown, unknown, unknown, unknown>["open"],
): Definition<unknown, unknown, unknown, unknown, unknown> => ({
	id,
	capability: "generation",
	decode: (value) => Result.succeed(value),
	open,
})

const session = (request: unknown) => ({
	send: (_command: unknown) => Effect.void,
	events: Stream.succeed(request),
	view: Effect.succeed(request),
	complete: Effect.succeed(request),
	cancel: Effect.void,
})

it("lists projections and opens a decoded session through the runtime interface", async () => {
	const runtime = Result.getOrThrow(
		make([definition("test", (request) => Effect.succeed(session(request)))]),
	)
	assert.deepEqual(await Effect.runPromise(runtime.list), ["test"])
	const opened = await Effect.runPromise(runtime.open("test", { model: "public" }))
	assert.deepEqual(await Effect.runPromise(opened.complete), { model: "public" })
})

it("maps duplicate, missing, decode, and open failures to ProjectionError", async () => {
	const duplicate = make([
		definition("test", () => Effect.succeed(session(null))),
		definition("test", () => Effect.succeed(session(null))),
	])
	assert.equal(Result.isFailure(duplicate), true)

	const runtime = Result.getOrThrow(
		make([
			{
				...definition("decode", () => Effect.succeed(session(null))),
				decode: () => Result.fail(ProjectionError.make({ message: "bad request" })),
			},
			definition("open", () => Effect.fail(new Error("open failed"))),
		]),
	)
	const missing = await Effect.runPromise(Effect.flip(runtime.open("missing", {})))
	assert.equal(missing.message, "Projection is not registered: missing")
	const decoded = await Effect.runPromise(Effect.flip(runtime.open("decode", {})))
	assert.equal(decoded.message, "bad request")
	const opened = await Effect.runPromise(Effect.flip(runtime.open("open", {})))
	assert.equal(opened.message, "open failed")
})

it.effect("provides the runtime as a Layer", () =>
	Effect.gen(function* () {
		const runtime = yield* ProjectionRuntime
		assert.deepEqual(yield* runtime.list, ["test"])
	}).pipe(
		Effect.provide(layer([definition("test", (request) => Effect.succeed(session(request)))])),
	),
)
