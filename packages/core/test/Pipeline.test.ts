import assert from "node:assert/strict"
import { it as test } from "@effect/vitest"
import { Effect, Layer, Result, Stream } from "effect"
import { Capability, Execution, Pipeline, Projection, Registry, Services } from "@better-router/core"

test.effect("capability declarations decode before catalog construction", () =>
  Effect.gen(function* () {
    const parsed = Capability.parse({ id: "generation", version: 1, projections: [] })
    assert.equal(Result.isSuccess(parsed), true)
    const invalid = Capability.parse({ id: "generation", version: 0, projections: [] })
    assert.equal(Result.isFailure(invalid), true)
  }),
)

test.effect("projection runtime exposes a session without exposing a pipeline", () =>
  Effect.gen(function* () {
    const definition: Projection.Definition<unknown, unknown, unknown, unknown, unknown> = {
      id: "test.projection",
      capability: "generation",
      decode: (value) => Result.succeed(value),
      open: (request) =>
        Effect.succeed({
          send: (_command: unknown) => Effect.void,
          events: Stream.succeed({ request }),
          view: Effect.succeed({ request }),
          complete: Effect.succeed({ request }),
          cancel: Effect.void,
        }),
    }
    const runtime = yield* Effect.fromResult(Projection.makeRuntime([definition]))
    const session = yield* runtime.open("test.projection", { model: "public" })
    assert.deepEqual(yield* Stream.runCollect(session.events), [{ request: { model: "public" } }])
    assert.deepEqual(yield* session.complete, { request: { model: "public" } })
  }),
)

test.effect("registry updates are pure and reject duplicate direct pipelines", () =>
  Effect.gen(function* () {
    const pipeline: Pipeline.DirectPipeline = {
      id: "provider:direct",
      deployment: "provider",
      source: "provider.responses",
      target: "provider.responses",
      execute: () => Effect.succeed({ status: 200, headers: {}, body: Stream.empty }),
    }
    const first = Registry.addPipeline(Registry.empty(), pipeline)
    assert.equal(Result.isSuccess(first), true)
    if (Result.isFailure(first)) return yield* Effect.die("Expected registry success")
    const second = Registry.addPipeline(first.success, pipeline)
    assert.equal(Result.isFailure(second), true)
    const projection: Projection.ProtocolDefinition = {
      id: "test.protocol",
      protocol: "test.protocol",
      capability: "generation",
      decode: (value) => Result.succeed({ model: "public", input: String(value) }),
      encodeEvent: Result.succeed,
      encodeResponse: Result.succeed,
    }
    const projected = Registry.addProjection(first.success, projection)
    assert.equal(Result.isSuccess(projected), true)
    if (Result.isSuccess(projected)) {
      const command: Projection.Command = { type: "protocol", request: { protocol: "test.protocol", model: "public", body: "hello", headers: {} } }
      assert.equal(Result.isSuccess(Projection.toGeneration(command, projected.success.projections)), true)
    }
    const completed = yield* Execution.complete(Stream.succeed({ type: "response.completed", response: { status: "completed" } } as never))
    assert.equal(completed.status, "completed")
  }),
)

test.effect("memory cache is an Effect Layer with atomic immutable updates", () =>
  Effect.gen(function* () {
    const cache = yield* Services.Cache
    assert.equal((yield* cache.get("missing"))._tag, "None")
    yield* cache.set("answer", 42)
    const answer = yield* cache.get("answer")
    assert.equal(answer._tag, "Some")
    if (answer._tag === "Some") assert.equal(answer.value, 42)
    yield* cache.remove("answer")
    assert.equal((yield* cache.get("answer"))._tag, "None")
  }).pipe(Effect.provide(Services.cacheMemory)),
)

test.effect("memory ledgers and stores are replaceable service layers", () =>
  Effect.gen(function* () {
    const budget = yield* Services.BudgetLedger
    yield* budget.reserve("tenant", 7)
    const exceeded = yield* Effect.flip(budget.reserve("tenant", 4))
    assert.equal(exceeded._tag, "BudgetError")
    const responses = yield* Services.ResponseStore
    yield* responses.put("response", { status: "completed" })
    const stored = yield* responses.get("response")
    assert.equal(stored._tag, "Some")
  }).pipe(Effect.provide(Services.budgetMemory({ tenant: 10 }).pipe(Layer.merge(Services.responseMemory)))),
)
