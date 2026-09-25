import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { IncomingHttpHeaders, ServerResponse } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { it as test } from "vitest"
import type { TestContext } from "vitest"
import { Effect, Ref, Schema } from "effect"
import { snapshot } from "@better-router/core/ModelEvents"
import type { OutputItem } from "@better-router/core/Model"
import { OpenAIChatCompletionsHttpError } from "@better-router/plugin-openai-chat-completions/OpenAIChatCompletionsHttp"

const textItem = { type: "message", id: "msg_1", status: "completed", role: "assistant",
  content: [{ type: "output_text", text: "Hello", annotations: [] }] } as const
const toolItem = { type: "function_call", id: "fc_1", status: "completed", call_id: "call_1", name: "lookup", arguments: "{}" } as const
const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5,
  input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 0 } }
const response = (output: readonly OutputItem[] = [textItem], extras: Record<string, unknown> = {}) => ({
  ...snapshot({ model: "gpt-test" }, "resp_1", 1234, "gpt-test", output, "completed", usage, 1235), ...extras,
})

const standardEvents = (final = response()) => [
  { type: "response.created", sequence_number: 0,
    response: snapshot({ model: "gpt-test" }, "resp_1", 1234, "gpt-test", [], "in_progress", null, null) },
  { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: textItem },
  { type: "response.output_text.delta", sequence_number: 2, item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
  { type: "response.completed", sequence_number: 3, response: final },
]

function sendEvents(res: ServerResponse, events: readonly { type: string; [key: string]: unknown }[], done = true) {
  res.writeHead(200, { "content-type": "text/event-stream" })
  const text =
    events.map((event) => "event: " + event.type + "\r\ndata: " + JSON.stringify(event) + "\r\n\r\n").join("") +
    (done ? "data: [DONE]\r\n\r\n" : "")
  const bytes = Buffer.from(text)
  Effect.runSync(Effect.forEach(Array.from({ length: Math.ceil(bytes.length / 7) }, (_, index) => index * 7),
    (index) => Effect.sync(() => res.write(bytes.subarray(index, index + 7)))))
  res.end()
}

async function fixture(t: TestContext) {
  const mode = Ref.makeUnsafe("normal")
  const calls = Ref.makeUnsafe<readonly { readonly headers: IncomingHttpHeaders; readonly body: unknown }[]>([])
  const closed = Promise.withResolvers<void>()
  const upstream = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()) as unknown
    Effect.runSync(Ref.update(calls, (entries) => [...entries, { headers: req.headers, body }]))
    const currentMode = Effect.runSync(Ref.get(mode))
    if (currentMode === "rate-limit") {
      res.writeHead(429, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "rate limited" } }))
    } else if (currentMode === "interrupted") {
      sendEvents(res, standardEvents().slice(0, 3), false)
    } else if (currentMode === "trailing") {
      sendEvents(
        res,
        [...standardEvents(), { type: "response.output_text.delta", sequence_number: 4, item_id: "msg_1", output_index: 0, content_index: 0, delta: "late" }],
        false,
      )
    } else if (currentMode === "bad-snapshot") {
      sendEvents(res, standardEvents(response([], { status: "failed" })))
    } else if (currentMode === "hold") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      const first = standardEvents()[0]!
      res.write("event: " + first.type + "\ndata: " + JSON.stringify(first) + "\n\n")
      res.on("close", () => closed.resolve())
    } else if (currentMode === "tools") {
      sendEvents(res, [
        standardEvents()[0]!,
        { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: textItem },
        { type: "response.output_text.delta", sequence_number: 2, item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hi" },
        {
          type: "response.output_item.added",
          sequence_number: 3,
          output_index: 1,
          item: toolItem,
        },
        { type: "response.function_call_arguments.delta", sequence_number: 4, item_id: "fc_1", output_index: 1, delta: "{}" },
        {
          type: "response.completed",
          sequence_number: 5,
          response: response([{ ...textItem, content: [{ type: "output_text", text: "Hi", annotations: [] }] }, toolItem]),
        },
      ])
    } else {
      sendEvents(res, standardEvents())
    }
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const address = upstream.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP listener")
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: process.cwd() + "/examples/chat-completions-gateway",
    env: {
      ...process.env,
      OPENAI_API_KEY: "provider",
      GATEWAY_API_KEY: "client",
      OPENAI_MODEL: "gpt-test",
      GATEWAY_MODEL: "chat",
      GATEWAY_PORT: "0",
      OPENAI_RESPONSES_URL: "http://127.0.0.1:" + address.port + "/v1/responses",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  t.onTestFinished(async () => {
    const exited = child.exitCode === null ? once(child, "exit") : Promise.resolve()
    child.kill()
    await exited
    const serverClosed = once(upstream, "close")
    upstream.close()
    await serverClosed
  })
  const logs = Ref.makeUnsafe("")
  const port = await Promise.race<number>([
    new Promise<number>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        Effect.runSync(Ref.update(logs, (text) => text + chunk.toString()))
        const address = Effect.runSync(Ref.get(logs)).match(/Listening on (?:https?:\/\/)?127\.0\.0\.1:(\d+)/)
        if (address) resolve(Number(address[1]))
      }
      child.stdout.on("data", onData)
      child.stderr.on("data", onData)
      child.once("exit", (code) => reject(new Error("Gateway exited (" + code + "): " + Effect.runSync(Ref.get(logs)))))
    }),
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("Gateway startup timed out: " + Effect.runSync(Ref.get(logs)))), 10000).unref(),
    ),
  ])
  return {
    port,
    calls: () => Effect.runSync(Ref.get(calls)),
    closed: closed.promise,
    setMode: (next: string) => Effect.runSync(Ref.set(mode, next)),
    request: (body: unknown, key = "client") =>
      fetch("http://127.0.0.1:" + port + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  }
}

test("Effect Node host routes Chat Completions through OpenResponses", async (t) => {
  const gateway = await fixture(t)
  const minimal = { model: "chat", messages: [{ role: "user", content: "Hi" }] }

  const unauthorized = await gateway.request(minimal, "wrong")
  assert.equal(unauthorized.status, 401)
  assert.equal(Schema.decodeUnknownSync(OpenAIChatCompletionsHttpError)(await unauthorized.json()).error.type, "authentication_error")
  assert.throws(() => Schema.decodeUnknownSync(OpenAIChatCompletionsHttpError)({ error: { message: "bad", type: "unknown" } }))
  assert.equal(gateway.calls().length, 0)
  assert.equal((await gateway.request({ ...minimal, model: "unknown" })).status, 404)
  assert.equal((await gateway.request({ ...minimal, n: 2 })).status, 422)
  assert.equal((await gateway.request({ ...minimal, temperature: "high" })).status, 400)
  assert.equal(gateway.calls().length, 0)

  const json = await gateway.request(minimal)
  assert.equal(json.status, 200)
  assert.equal((await json.json()).choices[0].message.content, "Hello")
  assert.equal(gateway.calls()[0].headers.authorization, "Bearer provider")
  assert.deepEqual(gateway.calls()[0].body, {
    model: "gpt-test",
    input: [{ type: "message", role: "user", content: "Hi" }],
    store: false,
    stream: true,
  })

  gateway.setMode("tools")
  const streamed = await gateway.request({
    ...minimal,
    stream: true,
    stream_options: { include_usage: true, include_obfuscation: false },
  })
  assert.equal(streamed.status, 200)
  assert.match(streamed.headers.get("content-type") ?? "", /text\/event-stream/)
  const frames = (await streamed.text())
    .trim()
    .split("\n\n")
    .map((entry) => entry.slice(6))
  assert.equal(frames.at(-1), "[DONE]")
  const chunks = frames.slice(0, -1).map((entry) => JSON.parse(entry))
  assert.deepEqual(chunks[0].choices[0].delta, { role: "assistant", content: "" })
  assert.deepEqual(chunks[1].choices[0].delta, { content: "Hi" })
  assert.deepEqual(chunks[2].choices[0].delta.tool_calls[0], {
    index: 0,
    id: "call_1",
    type: "function",
    function: { name: "lookup", arguments: "" },
  })
  assert.equal(chunks[3].choices[0].delta.tool_calls[0].function.arguments, "{}")
  assert.equal(chunks[4].choices[0].finish_reason, "tool_calls")
  assert.equal(chunks[5].choices.length, 0)
  assert.equal(chunks[5].usage.total_tokens, 5)
  assert.deepEqual((gateway.calls()[1]!.body as Record<string, unknown>).stream_options, { include_obfuscation: false })

  gateway.setMode("rate-limit")
  const limited = await gateway.request({ ...minimal, stream: true })
  assert.equal(limited.status, 429)
  assert.equal(Schema.decodeUnknownSync(OpenAIChatCompletionsHttpError)(await limited.json()).error.type, "upstream_error")

  gateway.setMode("interrupted")
  const interrupted = await gateway.request({ ...minimal, stream: true })
  const text = await interrupted.text()
  assert.match(text, /Upstream stream ended without a terminal response/)
  assert.doesNotMatch(text, /data: \[DONE\]/)

  gateway.setMode("trailing")
  const trailing = await gateway.request({ ...minimal, stream: true })
  const trailingText = await trailing.text()
  assert.match(trailingText, /upstream_error/)
  assert.doesNotMatch(trailingText, /data: \[DONE\]/)
  gateway.setMode("bad-snapshot")
  const malformed = await gateway.request(minimal)
  assert.equal(malformed.status, 502)
  const malformedStream = await gateway.request({ ...minimal, stream: true })
  assert.doesNotMatch(await malformedStream.text(), /data: \[DONE\]/)
  gateway.setMode("normal")
  const tooLarge = await gateway.request({ ...minimal, messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] })
  assert.equal(tooLarge.status, 413)
  const chunkedRequest = (body: unknown) => {
    const init = {
      method: "POST",
      headers: { authorization: "Bearer client", "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)))
          controller.close()
        },
      }),
      duplex: "half" as const,
    }
    return fetch("http://127.0.0.1:" + gateway.port + "/v1/chat/completions", init)
  }
  const chunked = await chunkedRequest({ ...minimal, messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] })
  assert.equal(chunked.status, 413)
  assert.equal((await chunkedRequest(minimal)).status, 200)

  gateway.setMode("hold")
  const holding = await gateway.request({ ...minimal, stream: true })
  const reader = holding.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /chat\.completion\.chunk/)
  await reader.cancel()
  await Promise.race([
    gateway.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Upstream was not canceled")), 3000).unref()),
  ])
})
