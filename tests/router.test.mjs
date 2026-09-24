import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { make, RouterError } from "@better-router/core/Router"
import { SetupError } from "@better-router/core/Plugin"
import { ProviderError } from "@better-router/core/Deployment"
import { RoutingError } from "@better-router/core/Routing"
import {
  OpenAIResponsesInvalidDeploymentUrl,
  make as openAIResponses,
} from "@better-router/plugin-openai-responses/OpenAIResponses"

const snapshot = (model = "private") => ({ id: "resp_1", status: "completed", model, output: [] })
const created = { type: "response.created", response: { id: "resp_1", created_at: 1234 } }
const finished = (model = "private") => ({ type: "response.completed", response: snapshot(model) })
const providerError = { kind: "rate_limited", message: "Limited", retryable: true }
const deployment = (id, execute = () => Effect.succeed(Stream.make(created, finished()))) => ({
  id,
  provider: "test",
  protocol: "test",
  model: id + "-private",
  execute: { http: execute },
})
const configured = (deployments, extras = {}) => ({ id: "test", deployments, ...extras })
const options = (plugins, ids, extra = {}) => ({ plugins, routes: [{ model: "chat", deployments: ids, ...extra }] })
const failure = (effect) => Effect.runPromise(Effect.flip(Effect.scoped(effect)))

test("invalid Responses deployment URLs produce schema-backed errors", () => {
  assert.throws(
    () => openAIResponses({ id: "bad", model: "private", apiKey: Redacted.make("secret"), url: new URL("ftp://example.com") }),
    (error) => {
      assert.equal(error instanceof OpenAIResponsesInvalidDeploymentUrl, true)
      assert.deepEqual(Schema.encodeSync(OpenAIResponsesInvalidDeploymentUrl)(error), {
        _tag: "OpenAIResponsesInvalidDeploymentUrl",
        message: "Responses URL must use HTTP(S)",
      })
      return true
    },
  )
})

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
  const provider = { kind: "rate_limited", message: "Limited", retryable: true }
  assert.deepEqual(Schema.decodeUnknownSync(ProviderError)(Schema.encodeSync(ProviderError)(provider)), provider)
  assert.throws(() => Schema.decodeUnknownSync(ProviderError)({ ...provider, retryable: "yes" }))
  const routing = { message: "No candidate" }
  assert.deepEqual(Schema.decodeUnknownSync(RoutingError)(Schema.encodeSync(RoutingError)(routing)), routing)
  assert.throws(() => Schema.decodeUnknownSync(RoutingError)({ message: 42 }))

  const cause = new Error("startup failed", { cause: new Error("internal details") })
  const setupFailure = SetupError.cases.PluginStartFailed.make({ plugin: "test", cause })
  const encodedFailure = Schema.encodeSync(SetupError)(setupFailure)
  assert.equal(encodedFailure.cause.message, "startup failed")
  assert.equal("cause" in encodedFailure.cause, false)
  assert.equal("stack" in encodedFailure.cause, false)
  assert.equal(Schema.decodeUnknownSync(SetupError)(encodedFailure).cause instanceof Error, true)
  const circular = { message: "bad input" }
  circular.self = circular
  assert.doesNotThrow(() => JSON.stringify(Schema.encodeSync(RouterError)(
    RouterError.cases.TransformFailed.make({ id: "test", cause: circular }),
  )))
})

test("validates plugin, deployment, HTTP, and route declarations before startup", async () => {
  assert.deepEqual(await failure(make({ plugins: [{ id: "same" }, { id: "same" }], routes: [] })), {
    _tag: "DuplicateId",
    kind: "plugin",
    id: "same",
  })
  assert.deepEqual(await failure(make({ plugins: [configured([deployment("one"), deployment("one")])], routes: [] })), {
    _tag: "DuplicateId",
    kind: "deployment",
    id: "one",
  })
  assert.equal((await failure(make(options([configured([deployment("one")])], ["absent"]))))._tag, "InvalidRoute")
  assert.equal((await failure(make(options([configured([deployment("one")])], ["one", "one"]))))._tag, "InvalidRoute")
  assert.equal(
    (await failure(make(options([configured([deployment("one")])], ["one"], { policy: "absent" }))))._tag,
    "InvalidRoute",
  )

  const fragment = (id, path) => HttpApi.make(id).add(HttpApiGroup.make(id).add(HttpApiEndpoint.post("send", path)))
  const a = { id: "a", http: { api: fragment("a", "/same"), routes: () => Layer.empty } }
  const b = { id: "b", http: { api: fragment("b", "/same"), routes: () => Layer.empty } }
  assert.deepEqual(await failure(make({ plugins: [a, b], routes: [] })), {
    _tag: "DuplicateHttpRoute",
    method: "POST",
    path: "/same",
  })
  const duplicateGroup = { id: "other", http: { api: fragment("a", "/other"), routes: () => Layer.empty } }
  assert.deepEqual(await failure(make({ plugins: [a, duplicateGroup], routes: [] })), {
    _tag: "DuplicateId",
    kind: "http_group",
    id: "a",
  })
})

test("ranks candidates, changes the private model, and composes transforms in declared order", async () => {
  const trace = []
  const executor = (name) => (request) =>
    Effect.sync(() => {
      trace.push(name + ":" + request.model)
      return Stream.succeed(finished(request.model))
    })
  const wrap = (name) => ({
    id: name,
    wrap: (next) => (request, invocation) => {
      trace.push(name + ":before")
      return next(request, invocation).pipe(Effect.tap(() => Effect.sync(() => trace.push(name + ":after"))))
    },
  })
  const plugin = configured([deployment("first", executor("first")), deployment("second", executor("second"))], {
    policies: [{ id: "reverse", rank: (_request, candidates) => Effect.succeed([...candidates].reverse()) }],
    transforms: [wrap("outer"), wrap("inner")],
  })
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([plugin], ["first", "second"], { policy: "reverse" }))
        return yield* router.complete({ model: "chat", input: [] })
      }),
    ),
  )
  assert.equal(result.model, "second-private")
  assert.deepEqual(trace, ["outer:before", "inner:before", "second:second-private", "inner:after", "outer:after"])
})

test("rejects invalid policy output and unsupported required transport", async () => {
  const plugin = configured([deployment("one")], {
    policies: [{ id: "invalid", rank: () => Effect.succeed([{ id: "foreign" }]) }],
  })
  const ranked = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([plugin], ["one"], { policy: "invalid" }))
        return yield* Effect.flip(router.open({ model: "chat" }))
      }),
    ),
  )
  assert.equal(ranked._tag, "RoutingFailed")
  const unsupported = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([plugin], ["one"]))
        return yield* Effect.flip(
          router.open({ model: "chat" }, { upstream: { transport: "websocket", mode: "require" } }),
        )
      }),
    ),
  )
  assert.deepEqual(unsupported, { _tag: "UnsupportedCapability", model: "chat", capability: "websocket" })
  const preferred = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([plugin], ["one"]))
        return yield* router.complete({ model: "chat" }, { upstream: { transport: "websocket", mode: "prefer" } })
      }),
    ),
  )
  assert.equal(preferred.model, "private")
})

test("falls back only before the first event and only for retryable failures", async () => {
  for (const first of [() => Effect.fail(providerError), () => Effect.succeed(Stream.fail(providerError))]) {
    let calls = 0
    const secondary = deployment("next", () =>
      Effect.sync(() => {
        calls++
        return Stream.succeed(finished())
      }),
    )
    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* make(
            options([configured([deployment("primary", first), secondary])], ["primary", "next"]),
          )
          return yield* router.complete({ model: "chat" })
        }),
      ),
    )
    assert.equal(response.id, "resp_1")
    assert.equal(calls, 1)
  }
  let calls = 0
  const first = deployment("primary", () =>
    Effect.succeed(Stream.succeed(created).pipe(Stream.concat(Stream.fail(providerError)))),
  )
  const second = deployment("next", () =>
    Effect.sync(() => {
      calls++
      return Stream.succeed(finished())
    }),
  )
  const caught = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(options([configured([first, second])], ["primary", "next"]))
        return yield* Effect.flip(Stream.runCollect(router.stream({ model: "chat" })))
      }),
    ),
  )
  assert.equal(caught._tag, "ProviderFailed")
  assert.equal(calls, 0)
  const notRetryable = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const router = yield* make(
          options(
            [configured([deployment("primary", () => Effect.fail({ ...providerError, retryable: false })), second])],
            ["primary", "next"],
          ),
        )
        return yield* Effect.flip(router.open({ model: "chat" }))
      }),
    ),
  )
  assert.equal(notRetryable._tag, "ProviderFailed")
  assert.equal(calls, 0)
})

test("requires one terminal snapshot and releases plugin resources on completion or failed startup", async () => {
  for (const events of [Stream.empty, Stream.make(finished(), created)]) {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* make(options([configured([deployment("one", () => Effect.succeed(events))])], ["one"]))
          return yield* Effect.flip(router.complete({ model: "chat" }))
        }),
      ),
    )
    assert.equal(error._tag, "InvalidResponse")
  }
  let released = 0
  const audit = {
    id: "audit",
    start: () =>
      Effect.addFinalizer(() =>
        Effect.sync(() => {
          released++
        }),
      ),
  }
  await Effect.runPromise(Effect.scoped(make({ plugins: [audit], routes: [] })))
  assert.equal(released, 1)
  const failing = { id: "fail", start: () => Effect.fail({ _tag: "InvalidRoute", model: "x", message: "fail" }) }
  assert.equal((await failure(make({ plugins: [audit, failing], routes: [] })))._tag, "PluginStartFailed")
  assert.equal(released, 2)
})

test("OpenAI deployment rejects nonportable extensions before making a request", async () => {
  const executor = openAIResponses({ id: "openai", model: "gpt-test", apiKey: Redacted.make("secret") }).execute.http
  const extension = await Effect.runPromise(
    Effect.flip(
      executor({ model: "gpt-test", input: [{ type: "acme:receipt", id: "receipt_1", status: "completed" }] }),
    ),
  )
  assert.equal(extension.kind, "unsupported")
  const background = await Effect.runPromise(Effect.flip(executor({ model: "gpt-test", background: true })))
  assert.equal(background.kind, "unsupported")
})
