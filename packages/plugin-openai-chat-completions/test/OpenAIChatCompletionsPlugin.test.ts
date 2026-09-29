import assert from "node:assert/strict"
import { it as test } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Stream } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { make as makeRouter } from "@better-router/core/Router"
import type { Deployment } from "@better-router/core/Deployment"
import type { GenerationEvent } from "@better-router/core/Generation"
import { snapshot } from "@better-router/core/GenerationEvents"
import type { RouterPlugin } from "@better-router/core/Plugin"
import { OpenAIChatCompletionsPlugin } from "@better-router/plugin-openai-chat-completions"

test.effect("Chat Completions ingress runs against a non-OpenAI deployment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const invokedModels = yield* Ref.make<readonly string[]>([])
      const local: Deployment = {
        id: "local",
        provider: "local",
        protocol: "local.responses",
        model: "local-private",
        execute: {
          http: (request) =>
            Ref.update(invokedModels, (models) => [...models, request.model]).pipe(
              Effect.map(() => {
                const item = { type: "message", id: "msg_local", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Local", annotations: [] }] } as const
                return Stream.fromIterable([
                  { type: "response.created", sequence_number: 0, response: snapshot(request, "resp_local", 1234, request.model, [], "in_progress", null, null) },
                  { type: "response.output_item.added", sequence_number: 1, output_index: 0, item },
                  { type: "response.output_text.delta", sequence_number: 2, output_index: 0, item_id: "msg_local", content_index: 0, delta: "Local" },
                  {
                    type: "response.completed",
                    sequence_number: 3,
                    response: snapshot(request, "resp_local", 1234, request.model, [item], "completed", null, 1235),
                  },
                ] as GenerationEvent[])
              }),
            ),
        },
      }
      const localPlugin: RouterPlugin<"local"> = { id: "local", deployments: [local] }
      const routes = Layer.unwrap(
        makeRouter({
          plugins: [OpenAIChatCompletionsPlugin.make({ gatewayKey: Redacted.make("client") }), localPlugin] as const,
          routes: [{ model: "chat", deployments: ["local"] }],
        }).pipe(Effect.map((router) => router.http.routes)),
      ).pipe(
        Layer.provide(HttpServer.layerServices),
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("Unexpected upstream HTTP")),
          ),
        ),
      )
      const { handler } = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        ({ dispose }) => Effect.promise(() => dispose()),
      )

      const send = (key: string, stream = false) =>
        handler(
          new Request("http://localhost/v1/chat/completions", {
            method: "POST",
            headers: { authorization: "Bearer " + key, "content-type": "application/json" },
            body: JSON.stringify({ model: "chat", messages: [{ role: "user", content: "Hi" }], stream }),
          }),
        )

      yield* Effect.promise(async () => {
        assert.equal((await send("wrong")).status, 401)
        assert.deepEqual(Effect.runSync(Ref.get(invokedModels)), [])

        const json = await send("client")
        assert.equal(json.status, 200)
        assert.equal(((await json.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message.content, "Local")

        const streamed = await send("client", true)
        assert.equal(streamed.status, 200)
        const chunks = await streamed.text()
        assert.match(chunks, /"content":"Local"/)
        assert.match(chunks, /data: \[DONE\]/)
        assert.deepEqual(Effect.runSync(Ref.get(invokedModels)), ["local-private", "local-private"])
      })
    }),
  ),
)
