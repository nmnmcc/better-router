import assert from "node:assert/strict"
import { it as test } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { make, RouterError } from "@better-router/core/Router"
import { SetupError } from "@better-router/core/Plugin"
import type { RouterPlugin } from "@better-router/core/Plugin"
import { ProviderError } from "@better-router/core/Deployment"
import type { ModelDeployment, ModelExecutor } from "@better-router/core/Deployment"
import { RoutingError } from "@better-router/core/Routing"
import type { ModelRoute } from "@better-router/core/Routing"
import type { ModelEvent, ModelResponse } from "@better-router/core/Model"
import type { ModelTransform } from "@better-router/core/Transform"

const snapshot = (model = "private") => ({ id: "resp_1", status: "completed", model, output: [] }) as unknown as ModelResponse
const created = { type: "response.created", response: { id: "resp_1", created_at: 1234 } } as ModelEvent
const finished = (model = "private") => ({ type: "response.completed", response: snapshot(model) }) as ModelEvent
const providerError: ProviderError = { kind: "rate_limited", message: "Limited", retryable: true }
const deployment = (id: string, execute: ModelExecutor = () => Effect.succeed(Stream.make(created, finished()))): ModelDeployment => ({
  id,
  provider: "test",
  protocol: "test",
  model: id + "-private",
  execute: { http: execute },
})
const configured = (deployments: readonly ModelDeployment[], extras: Partial<RouterPlugin> = {}): RouterPlugin => ({ id: "test", deployments, ...extras })
const options = (plugins: readonly RouterPlugin[], ids: readonly string[], extra: Partial<ModelRoute> = {}) => ({ plugins, routes: [{ model: "chat", deployments: ids, ...extra }] })
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.flip(Effect.scoped(effect as Effect.Effect<A, E, Scope.Scope>))

test("public error schemas retain tagged shapes, reject invalid fields and support matching", () => {
  const setup = SetupError.cases.DuplicateId.make({ kind: "plugin", id: "same" })
  assert.deepEqual(setup, { _tag: "DuplicateId", kind: "plugin", id: "same" })
  assert.equal(SetupError.guards.DuplicateId(setup), true)
  assert.equal(SetupError.guards.InvalidRoute(setup), false)
  assert.deepEqual(Schema.decodeUnknownSync(SetupError)(Schema.encodeSync(SetupError)(setup)), setup)
  assert.throws(() => Schema.decodeUnknownSync(SetupError)({ _tag: "DuplicateId", kind: "other", id: "same" }))

  const error = RouterError.cases.NoRoute.make({ model: "chat" })
  assert.equal(RouterError.guards.NoRoute(error), true)
  assert.equal(RouterError.guards.ProviderFailed(error), false)
  assert.deepEqual(Schema.decodeUnknownSync(RouterError)(Schema.encodeSync(RouterError)(error)), error)
  assert.throws(() => Schema.decodeUnknownSync(RouterError)({ _tag: "NoRoute", model: 42 }))
  assert.equal(Schema.is(RouterError)({ _tag: "ProviderFailed", deployment: "a", cause: { kind: "bad" } }), false)
  assert.equal(
    RouterError.match(error, {
      InvalidRequest: () => "invalid",
      NoRoute: ({ model }) => `Unknown model: ${model}`,
      NoAvailableDeployment: () => "unavailable",
      UnsupportedCapability: () => "unsupported",
      RoutingFailed: () => "routing",
      ProviderFailed: () => "provider",
      TransformFailed: () => "transform",
      InvalidResponse: () => "response",
    }),
    "Unknown model: chat",
  )
  const provider: ProviderError = { kind: "rate_limited", message: "Limited", retryable: true }
  assert.deepEqual(Schema.decodeUnknownSync(ProviderError)(Schema.encodeSync(ProviderError)(provider)), provider)
  assert.throws(() => Schema.decodeUnknownSync(ProviderError)({ ...provider, retryable: "yes" }))
  const routing = { message: "No candidate" }
  assert.deepEqual(Schema.decodeUnknownSync(RoutingError)(Schema.encodeSync(RoutingError)(routing)), routing)
  assert.throws(() => Schema.decodeUnknownSync(RoutingError)({ message: 42 }))

  const cause = new Error("startup failed", { cause: new Error("internal details") })
  const setupFailure = SetupError.cases.PluginStartFailed.make({ plugin: "test", cause })
  const encodedFailure = Schema.encodeSync(SetupError)(setupFailure)
  if (encodedFailure._tag !== "PluginStartFailed") assert.fail("Expected PluginStartFailed")
  assert.equal((encodedFailure.cause as unknown as { message: string }).message, "startup failed")
  assert.equal("cause" in (encodedFailure.cause as object), false)
  assert.equal("stack" in (encodedFailure.cause as object), false)
  const decodedFailure = Schema.decodeUnknownSync(SetupError)(encodedFailure)
  if (decodedFailure._tag !== "PluginStartFailed") assert.fail("Expected PluginStartFailed")
  assert.equal(decodedFailure.cause instanceof Error, true)
  const circular = {
    message: "bad input",
    get self(): unknown {
      return this
    },
  }
  assert.doesNotThrow(() => JSON.stringify(Schema.encodeSync(RouterError)(RouterError.cases.TransformFailed.make({ id: "test", cause: circular }))))
})

test.effect("validates plugin, deployment, HTTP, and route declarations before startup", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* failure(make({ plugins: [{ id: "same" }, { id: "same" }], routes: [] })), {
      _tag: "DuplicateId",
      kind: "plugin",
      id: "same",
    })
    assert.deepEqual(yield* failure(make({ plugins: [configured([deployment("one"), deployment("one")])], routes: [] })), {
      _tag: "DuplicateId",
      kind: "deployment",
      id: "one",
    })
    assert.equal((yield* failure(make(options([configured([deployment("one")])], ["absent"]))))._tag, "InvalidRoute")
    assert.equal((yield* failure(make(options([configured([deployment("one")])], ["one", "one"]))))._tag, "InvalidRoute")
    assert.equal((yield* failure(make(options([configured([deployment("one")])], ["one"], { policy: "absent" }))))._tag, "InvalidRoute")

    const fragment = (id: string, path: `/${string}`) => HttpApi.make(id).add(HttpApiGroup.make(id).add(HttpApiEndpoint.post("send", path)))
    const a = { id: "a", http: { api: fragment("a", "/same"), routes: () => Layer.empty } }
    const b = { id: "b", http: { api: fragment("b", "/same"), routes: () => Layer.empty } }
    assert.deepEqual(yield* failure(make({ plugins: [a, b], routes: [] })), {
      _tag: "DuplicateHttpRoute",
      method: "POST",
      path: "/same",
    })
    const duplicateGroup = { id: "other", http: { api: fragment("a", "/other"), routes: () => Layer.empty } }
    assert.deepEqual(yield* failure(make({ plugins: [a, duplicateGroup], routes: [] })), {
      _tag: "DuplicateId",
      kind: "http_group",
      id: "a",
    })
  }),
)

test.effect("ranks candidates, changes the private model, and composes transforms in declared order", () =>
  Effect.gen(function* () {
    const trace = yield* Ref.make<readonly string[]>([])
    const executor =
      (name: string): ModelExecutor =>
      (request) =>
        Ref.update(trace, (entries) => [...entries, name + ":" + request.model]).pipe(Effect.as(Stream.succeed(finished(request.model))))
    const wrap = (name: string): ModelTransform => ({
      id: name,
      wrap: (next) => (request, invocation) =>
        Ref.update(trace, (entries) => [...entries, name + ":before"]).pipe(
          Effect.flatMap(() => next(request, invocation)),
          Effect.tap(() => Ref.update(trace, (entries) => [...entries, name + ":after"])),
        ),
    })
    const plugin = configured([deployment("first", executor("first")), deployment("second", executor("second"))], {
      policies: [{ id: "reverse", rank: (_request, candidates) => Effect.succeed([...candidates].reverse()) }],
      transforms: [wrap("outer"), wrap("inner")],
    })
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([plugin], ["first", "second"], { policy: "reverse" }))
        return yield* router.complete({ model: "chat", input: [] })
      }),
    )
    assert.equal(result.model, "second-private")
    assert.deepEqual(yield* Ref.get(trace), ["outer:before", "inner:before", "second:second-private", "inner:after", "outer:after"])
  }),
)

test.effect("rejects invalid policy output and unsupported required transport", () =>
  Effect.gen(function* () {
    const plugin = configured([deployment("one")], {
      policies: [{ id: "invalid", rank: () => Effect.succeed([{ id: "foreign", provider: "other", model: "other" }]) }],
    })
    const ranked = yield* Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([plugin], ["one"], { policy: "invalid" }))
        return yield* Effect.flip(router.open({ model: "chat" }))
      }),
    )
    assert.equal(ranked._tag, "RoutingFailed")
    const unsupported = yield* Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([plugin], ["one"]))
        return yield* Effect.flip(router.open({ model: "chat" }, { upstream: { transport: "websocket", mode: "require" } }))
      }),
    )
    assert.deepEqual(unsupported, { _tag: "UnsupportedCapability", model: "chat", capability: "websocket" })
    const preferred = yield* Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([plugin], ["one"]))
        return yield* router.complete({ model: "chat" }, { upstream: { transport: "websocket", mode: "prefer" } })
      }),
    )
    assert.equal(preferred.model, "private")
  }),
)

test.effect("falls back only before the first event and only for retryable failures", () =>
  Effect.gen(function* () {
    yield* Effect.forEach([() => Effect.fail(providerError), () => Effect.succeed(Stream.fail(providerError))], (first) =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const secondary = deployment("next", () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(Stream.succeed(finished()))))
        const response = yield* Effect.scoped(
          Effect.gen(function* () {
            const router = yield* make(options([configured([deployment("primary", first), secondary])], ["primary", "next"]))
            return yield* router.complete({ model: "chat" })
          }),
        )
        assert.equal(response.id, "resp_1")
        assert.equal(yield* Ref.get(calls), 1)
      }),
    )
    const calls = yield* Ref.make(0)
    const first = deployment("primary", () => Effect.succeed(Stream.succeed(created).pipe(Stream.concat(Stream.fail(providerError)))))
    const second = deployment("next", () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(Stream.succeed(finished()))))
    const caught = yield* Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([configured([first, second])], ["primary", "next"]))
        return yield* Effect.flip(Stream.runCollect(router.stream({ model: "chat" })))
      }),
    )
    assert.equal(caught._tag, "ProviderFailed")
    assert.equal(yield* Ref.get(calls), 0)
    const notRetryable = yield* Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([configured([deployment("primary", () => Effect.fail({ ...providerError, retryable: false })), second])], ["primary", "next"]))
        return yield* Effect.flip(router.open({ model: "chat" }))
      }),
    )
    assert.equal(notRetryable._tag, "ProviderFailed")
    assert.equal(yield* Ref.get(calls), 0)
  }),
)

test.effect("requires one terminal snapshot and releases plugin resources on completion or failed startup", () =>
  Effect.gen(function* () {
    yield* Effect.forEach([Stream.empty, Stream.make(finished(), created)], (events) =>
      Effect.gen(function* () {
        const error = yield* Effect.scoped(
          Effect.gen(function* () {
            const router = yield* make(options([configured([deployment("one", () => Effect.succeed(events))])], ["one"]))
            return yield* Effect.flip(router.complete({ model: "chat" }))
          }),
        )
        assert.equal(error._tag, "InvalidResponse")
      }),
    )
    const released = yield* Ref.make(0)
    const audit = {
      id: "audit",
      start: () => Effect.addFinalizer(() => Ref.update(released, (count) => count + 1)),
    }
    yield* Effect.scoped(make({ plugins: [audit], routes: [] }))
    assert.equal(yield* Ref.get(released), 1)
    const failing: RouterPlugin = {
      id: "fail",
      start: () => Effect.fail(SetupError.cases.InvalidRoute.make({ model: "x", message: "fail" })),
    }
    assert.equal((yield* failure(make({ plugins: [audit, failing], routes: [] })))._tag, "PluginStartFailed")
    assert.equal(yield* Ref.get(released), 2)
  }),
)

test.effect("interrupting a suspended stream closes its finalizer and the router scope", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const streamReleased = yield* Ref.make(0)
    const pluginReleased = yield* Ref.make(0)
    const hanging = deployment("hold", () =>
      Effect.succeed(
        Stream.fromEffect(Deferred.succeed(started, void 0)).pipe(
          Stream.flatMap(() => Stream.never),
          Stream.ensuring(Ref.update(streamReleased, (count) => count + 1)),
        ),
      ),
    )
    const audit: RouterPlugin = {
      id: "audit",
      start: () => Effect.addFinalizer(() => Ref.update(pluginReleased, (count) => count + 1)),
    }
    yield* Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([audit, configured([hanging])], ["hold"]))
        const fiber = yield* Effect.forkChild(Stream.runDrain(router.stream({ model: "chat" })))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        assert.equal(yield* Ref.get(streamReleased), 1)
      }),
    )
    assert.equal(yield* Ref.get(pluginReleased), 1)
  }),
)
