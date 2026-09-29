import assert from "node:assert/strict"
import { it as test } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Stream } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import type { GenerationEvent } from "@better-router/core/Generation"
import { snapshot } from "@better-router/core/GenerationEvents"
import { make as makeRouter } from "@better-router/core/Router"
import { AnthropicMessagesPlugin } from "@better-router/plugin-anthropic-messages"

test.effect("Messages ingress authenticates, converts input, and emits native JSON and SSE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* Ref.make<readonly unknown[]>([])
      const output = [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] }] as const
      const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
      const local = {
        id: "local",
        provider: "local",
        protocol: "local",
        model: "private",
        execute: {
          http: (request: unknown) =>
            Ref.update(received, (entries) => [...entries, request]).pipe(
              Effect.map(() =>
                Stream.fromIterable([
                  { type: "response.created", sequence_number: 0, response: snapshot({ model: "private" }, "resp_1", 1234, "private", [], "in_progress", null, null) },
                  { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...output[0], status: "in_progress" } },
                  { type: "response.output_text.delta", sequence_number: 2, item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
                  { type: "response.output_item.done", sequence_number: 3, output_index: 0, item: output[0] },
                  { type: "response.completed", sequence_number: 4, response: snapshot({ model: "private" }, "resp_1", 1234, "private", output, "completed", usage, 1235) },
                ] as GenerationEvent[]),
              ),
            ),
        },
      }
      const routes = Layer.unwrap(
        makeRouter({
          plugins: [AnthropicMessagesPlugin.make({ gatewayKey: Redacted.make("client") }), { id: "local", deployments: [local] }],
          routes: [{ model: "public", deployments: ["local"] }],
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
      const send = (key: string, version: string | undefined, stream = false) =>
        handler(
          new Request("http://localhost/v1/messages", {
            method: "POST",
            headers: { "x-api-key": key, ...(version ? { "anthropic-version": version } : {}), "content-type": "application/json" },
            body: JSON.stringify({ model: "public", max_tokens: 64, messages: [{ role: "user", content: "Hi" }], stream }),
          }),
        )
      yield* Effect.promise(async () => {
        assert.equal((await send("wrong", "2023-06-01")).status, 401)
        assert.equal((await send("client", undefined)).status, 400)
        assert.deepEqual(Effect.runSync(Ref.get(received)), [])
        const json = await send("client", "2023-06-01")
        assert.equal(json.status, 200, await json.clone().text())
        const result = (await json.json()) as { type: string; model: string; content: { type: string; text: string }[]; usage: { output_tokens: number } }
        assert.equal(result.type, "message")
        assert.equal(result.model, "public")
        assert.deepEqual(result.content[0], { type: "text", text: "Hello" })
        assert.equal(result.usage.output_tokens, 2)
        const streamed = await send("client", "2023-06-01", true)
        assert.equal(streamed.status, 200)
        const text = await streamed.text()
        assert.match(text, /event: message_start/)
        assert.match(text, /event: content_block_delta/)
        assert.match(text, /event: message_stop/)
        assert.equal(Effect.runSync(Ref.get(received)).length, 2)
      })
    }),
  ),
)
