import assert from "node:assert/strict"
import { createServer } from "node:http"
import { once } from "node:events"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import { it as test } from "@effect/vitest"
import { Effect, Redacted, Ref, Result } from "effect"
import { make as makeRouter } from "@better-router/core/Router"
import { AnthropicMessages, AnthropicMessagesPlugin } from "@better-router/plugin-anthropic-messages"

test.effect("Anthropic deployment streams native Messages events into a complete response", () => Effect.scoped(Effect.gen(function* () {
  const calls = yield* Ref.make<readonly { readonly headers: Record<string, unknown>; readonly body: Record<string, unknown> }[]>([])
  const upstream = createServer(async (request, response) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString())
    Effect.runSync(Ref.update(calls, (entries) => [...entries, { headers: request.headers, body }]))
    response.writeHead(200, { "content-type": "text/event-stream" })
    const events = [
      { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-private", content: [], usage: { input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 1 }, stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""))
  })
  yield* Effect.acquireRelease(
    Effect.promise(async () => {
      upstream.listen(0, "127.0.0.1")
      await once(upstream, "listening")
    }),
    () => Effect.promise(async () => {
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }),
  )
  const address = upstream.address()
  if (!address || typeof address === "string") assert.fail("Expected TCP listener")
  const deployment = AnthropicMessages.make({
    id: "anthropic-upstream", model: "claude-private", apiKey: Redacted.make("provider"),
    defaultMaxTokens: 1024, url: new URL(`http://127.0.0.1:${address.port}/v1/messages`),
  })
  assert.ok(Result.isSuccess(deployment))
  const result = yield* makeRouter({
    plugins: [AnthropicMessagesPlugin.make({ deployments: [deployment.success] })],
    routes: [{ model: "public", deployments: ["anthropic-upstream"] }],
  }).pipe(
    Effect.flatMap((router) => router.complete({ model: "public", input: "Hi" })),
    Effect.provide(NodeHttpClient.layerUndici),
  )
  assert.equal(result.status, "completed")
  assert.equal(result.output[0].type, "message")
  if (result.output[0].type !== "message") assert.fail("Expected message")
  assert.equal("text" in result.output[0].content[0] && result.output[0].content[0].text, "Hello")
    assert.equal(result.usage?.total_tokens, 5)
    assert.equal(result.usage?.input_tokens_details.cached_tokens, 2)
  const received = yield* Ref.get(calls)
  assert.equal(received[0].headers["anthropic-version"], "2023-06-01")
  assert.equal(received[0].headers["x-api-key"], "provider")
  assert.deepEqual(received[0].body, { model: "claude-private", max_tokens: 1024, messages: [{ role: "user", content: "Hi" }], stream: true })
})))
