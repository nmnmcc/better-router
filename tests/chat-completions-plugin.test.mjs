import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Layer, Redacted, Stream } from "effect"
import { HttpRouter, HttpServer } from "effect/unstable/http"
import { make as makeRouter } from "@better-router/core/Router"
import { OpenAIChatCompletionsPlugin } from "@better-router/plugin-openai-chat-completions"

test("Chat Completions ingress runs against a non-OpenAI deployment", async () => {
  const invokedModels = []
  const local = {
    id: "local",
    provider: "local",
    protocol: "local.responses",
    model: "local-private",
    execute: {
      http: (request) =>
        Effect.sync(() => {
          invokedModels.push(request.model)
          return Stream.fromIterable([
            { type: "response.created", response: { id: "resp_local", created_at: 1234 } },
            { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } },
            { type: "response.output_text.delta", output_index: 0, delta: "Local" },
            {
              type: "response.completed",
              response: {
                id: "resp_local",
                object: "response",
                model: request.model,
                created_at: 1234,
                status: "completed",
                output: [
                  { type: "message", role: "assistant", content: [{ type: "output_text", text: "Local" }] },
                ],
              },
            },
          ])
        }),
    },
  }
  const routes = Layer.unwrap(
    makeRouter({
      plugins: [OpenAIChatCompletionsPlugin.make({ gatewayKey: Redacted.make("client") }), { id: "local", deployments: [local] }],
      routes: [{ model: "chat", deployments: ["local"] }],
    }).pipe(Effect.map((router) => router.http.routes)),
  ).pipe(Layer.provide(HttpServer.layerServices))
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })

  const send = (key, stream = false) =>
    handler(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "Hi" }], stream }),
      }),
    )

  try {
    assert.equal((await send("wrong")).status, 401)
    assert.deepEqual(invokedModels, [])

    const json = await send("client")
    assert.equal(json.status, 200)
    assert.equal((await json.json()).choices[0].message.content, "Local")

    const streamed = await send("client", true)
    assert.equal(streamed.status, 200)
    const chunks = await streamed.text()
    assert.match(chunks, /"content":"Local"/)
    assert.match(chunks, /data: \[DONE\]/)
    assert.deepEqual(invokedModels, ["local-private", "local-private"])
  } finally {
    await dispose()
  }
})
