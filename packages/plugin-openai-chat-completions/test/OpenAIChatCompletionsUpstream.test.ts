import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { it as test } from "@effect/vitest"
import { Effect, Redacted, Ref, Result, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { make as makeRouter } from "@better-router/core/Router"
import { complete as completeGeneration } from "@better-router/core/Execution"
import { OpenAIChatCompletions, OpenAIChatCompletionsPlugin } from "@better-router/plugin-openai-chat-completions"

test.effect("Chat Completions deployment streams text and usage through the router", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Ref.make<readonly unknown[]>([])
      const upstream = createServer(async (request, response) => {
        const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString())
        Effect.runSync(Ref.update(requests, (entries) => [...entries, body]))
        response.writeHead(200, { "content-type": "text/event-stream" })
        const frames = [
          { id: "chatcmpl_1", object: "chat.completion.chunk", created: 1234, model: "private", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl_1", object: "chat.completion.chunk", created: 1234, model: "private", choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }] },
          { id: "chatcmpl_1", object: "chat.completion.chunk", created: 1234, model: "private", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { id: "chatcmpl_1", object: "chat.completion.chunk", created: 1234, model: "private", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
        ]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
          .join("")
        response.end(frames + "data: [DONE]\n\n")
      })
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          upstream.listen(0, "127.0.0.1")
          await once(upstream, "listening")
        }),
        () =>
          Effect.promise(async () => {
            upstream.closeAllConnections()
            await new Promise<void>((resolve) => upstream.close(() => resolve()))
          }),
      )
      const address = upstream.address()
      if (!address || typeof address === "string") assert.fail("Expected a TCP listener")
      const deployment = yield* Effect.fromResult(
        OpenAIChatCompletions.make({
          id: "chat-upstream",
          model: "private",
          apiKey: Redacted.make("provider"),
          url: new URL(`http://127.0.0.1:${address.port}/v1/chat/completions`),
        }),
      )
      const response = yield* makeRouter({
        plugins: [OpenAIChatCompletionsPlugin.make({ deployments: [deployment] })],
        routes: [{ model: "public", deployments: ["chat-upstream"] }],
      }).pipe(
        Effect.flatMap((router) => router.invoke({ type: "generation", request: { model: "public", input: "Hi" } })),
        Effect.flatMap((execution) => (execution.type === "generation" ? completeGeneration(execution.events) : Effect.die("Expected generation execution"))),
        Effect.provide(NodeHttpClient.layerUndici),
      )
      assert.equal(response.status, "completed")
      assert.equal(response.output[0].type, "message")
      if (response.output[0].type !== "message") assert.fail("Expected an assistant message")
      assert.equal(response.output[0].content[0].type, "output_text")
      assert.equal("text" in response.output[0].content[0] && response.output[0].content[0].text, "Hello")
      assert.equal(response.usage?.total_tokens, 5)
      assert.deepEqual(yield* Ref.get(requests), [{ model: "private", messages: [{ role: "user", content: "Hi" }], stream: true, stream_options: { include_usage: true } }])
    }),
  ),
)

test.effect("Chat SSE rejects unmappable delta fields rather than dropping them", () =>
  Effect.gen(function* () {
    const deployment = OpenAIChatCompletions.make({ id: "chat", model: "private", apiKey: Redacted.make("provider") })
    assert.ok(Result.isSuccess(deployment))
    const frame = { id: "chatcmpl_1", object: "chat.completion.chunk", created: 1234, model: "private", choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "hidden" }, finish_reason: null }] }
    const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(`data: ${JSON.stringify(frame)}\n\n`, { headers: { "content-type": "text/event-stream" } }))))
    const error = yield* Effect.gen(function* () {
      const source = yield* deployment.success.execute.http({ model: "private" })
      return yield* Stream.runCollect(source).pipe(Effect.flip)
    }).pipe(Effect.provideService(HttpClient.HttpClient, client))
    assert.equal(error.kind, "unsupported")
    assert.match(error.message, /chunk.choices\[0\].delta.reasoning_content/)
  }),
)
