import assert from "node:assert/strict"
import { it as test } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Stream } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { make as makeRouter } from "@better-router/core/Router"
import type { ModelEvent } from "@better-router/core/Model"
import { snapshot } from "@better-router/core/ModelEvents"
import { OpenAIResponsesPlugin } from "@better-router/plugin-openai-responses"

test.effect("Responses ingress serves JSON and SSE through a configured deployment", () => Effect.scoped(Effect.gen(function* () {
  const invoked = yield* Ref.make<readonly string[]>([])
  const deployment = {
    id: "local",
    provider: "local",
    protocol: "local.responses",
    model: "private",
    execute: {
      http: (request: { model: string }) => Ref.update(invoked, (models) => [...models, request.model]).pipe(Effect.map(() => {
        const item = { type: "message", id: "msg_1", status: "completed", role: "assistant",
          content: [{ type: "output_text", text: "Hello", annotations: [] }] } as const
        return Stream.fromIterable([
          { type: "response.created", sequence_number: 0, response: snapshot(request, "resp_1", 1234, request.model, [], "in_progress", null, null) },
          { type: "response.output_item.added", sequence_number: 1, output_index: 0, item },
          { type: "response.output_text.delta", sequence_number: 2, item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
          {
            type: "response.completed",
            sequence_number: 3,
            response: snapshot(request, "resp_1", 1234, request.model, [item], "completed", null, 1235),
          },
        ] as ModelEvent[])
      })),
    },
  }
  const routes = Layer.unwrap(
    makeRouter({
      plugins: [OpenAIResponsesPlugin.make({ gatewayKey: Redacted.make("client"), deployments: [] }), { id: "local", deployments: [deployment] }],
      routes: [{ model: "public", deployments: ["local"] }],
    }).pipe(Effect.map((router) => router.http.routes)),
  ).pipe(
    Layer.provide(HttpServer.layerServices),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("Unexpected upstream HTTP")))),
  )
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    ({ dispose }) => Effect.promise(() => dispose()),
  )
  const send = (key: string, stream = false) => handler(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "public", input: "Hi", stream }),
  }))
  yield* Effect.promise(async () => {
    assert.equal((await send("wrong")).status, 401)
    assert.deepEqual(Effect.runSync(Ref.get(invoked)), [])
    const json = await send("client")
    assert.equal(json.status, 200)
    const result = await json.json() as { model: string; output: { content: { text: string }[] }[] }
    assert.equal(result.model, "public")
    assert.equal(result.output[0].content[0].text, "Hello")
    const streamed = await send("client", true)
    assert.equal(streamed.status, 200)
    const frames = await streamed.text()
    assert.match(frames, /event: response.output_text.delta/)
    assert.match(frames, /"model":"public"/)
    assert.match(frames, /data: \[DONE\]/)
    assert.deepEqual(Effect.runSync(Ref.get(invoked)), ["private", "private"])
  })
})))

test.effect("invalid upstream resources return 502 rather than a client parse error", () => Effect.scoped(Effect.gen(function* () {
  const local = { id: "broken", provider: "local", protocol: "local.responses", model: "private",
    execute: { http: () => Effect.succeed(Stream.succeed({ type: "response.completed", sequence_number: 0,
      response: { id: "incomplete" },
    } as ModelEvent)) } }
  const routes = Layer.unwrap(makeRouter({
    plugins: [OpenAIResponsesPlugin.make({ gatewayKey: Redacted.make("client") }), { id: "local", deployments: [local] }],
    routes: [{ model: "public", deployments: ["broken"] }],
  }).pipe(Effect.map((router) => router.http.routes))).pipe(
    Layer.provide(HttpServer.layerServices),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(() => Effect.die("Unexpected upstream HTTP")))),
  )
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    ({ dispose }) => Effect.promise(() => dispose()),
  )
  const response = yield* Effect.promise(() => handler(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { authorization: "Bearer client", "content-type": "application/json" },
    body: JSON.stringify({ model: "public", input: "Hi" }),
  })))
  assert.equal(response.status, 502)
})))
