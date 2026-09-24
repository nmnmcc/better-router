import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { test } from "node:test"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import {
  OpenAIChatCompletionsHttpError,
  api,
  toChatCompletion,
  OpenAIChatCompletionsUpstreamResponseError,
} from "@better-router/plugin-openai-chat-completions/OpenAIChatCompletionsHttp"

test("HTTP API declares the schema-backed error statuses", () => {
  const responses = OpenApi.fromApi(api).paths["/v1/chat/completions"].post.responses
  assert.deepEqual(Object.keys(responses), ["200", "400", "401", "404", "413", "415", "422", "429", "500", "502", "503", "504"])
  assert.equal(responses[401].content["application/json"].schema.type, "object")
})

test("upstream projection errors encode with their Schema", () => {
  const error = new OpenAIChatCompletionsUpstreamResponseError({ message: "Invalid response" })
  assert.equal(error instanceof Error, true)
  const encoded = Schema.encodeSync(OpenAIChatCompletionsUpstreamResponseError)(error)
  assert.deepEqual(encoded, {
    _tag: "OpenAIChatCompletionsUpstreamResponseError",
    message: "Invalid response",
  })
  assert.equal(Schema.decodeUnknownSync(OpenAIChatCompletionsUpstreamResponseError)(encoded).message, error.message)
})

const response = (
  output = [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello", annotations: [] }] }],
  extras = {},
) => ({
  id: "resp_1",
  object: "response",
  model: "gpt-test",
  created_at: 1234,
  status: "completed",
  output,
  usage: {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
    input_tokens_details: { cached_tokens: 1 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
  ...extras,
})

const standardEvents = (final = response()) => [
  { type: "response.created", response: { id: "resp_1", created_at: 1234 } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } },
  { type: "response.output_text.delta", output_index: 0, delta: "Hello" },
  { type: "response.completed", response: final },
]

function sendEvents(res, events, done = true) {
  res.writeHead(200, { "content-type": "text/event-stream" })
  const text =
    events.map((event) => "event: " + event.type + "\r\ndata: " + JSON.stringify(event) + "\r\n\r\n").join("") +
    (done ? "data: [DONE]\r\n\r\n" : "")
  const bytes = Buffer.from(text)
  for (let index = 0; index < bytes.length; index += 7) res.write(bytes.subarray(index, index + 7))
  res.end()
}

async function fixture(t) {
  let mode = "normal"
  const calls = []
  let upstreamClosed
  const closed = new Promise((resolve) => {
    upstreamClosed = resolve
  })
  const upstream = createServer(async (req, res) => {
    const body = JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString())
    calls.push({ headers: req.headers, body })
    if (mode === "rate-limit") {
      res.writeHead(429, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "rate limited" } }))
    } else if (mode === "interrupted") {
      sendEvents(res, standardEvents().slice(0, 3), false)
    } else if (mode === "trailing") {
      sendEvents(
        res,
        [...standardEvents(), { type: "response.output_text.delta", output_index: 0, delta: "late" }],
        false,
      )
    } else if (mode === "bad-snapshot") {
      sendEvents(res, standardEvents(response([], { status: "failed" })))
    } else if (mode === "hold") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      const first = standardEvents()[0]
      res.write("event: " + first.type + "\ndata: " + JSON.stringify(first) + "\n\n")
      res.on("close", upstreamClosed)
    } else if (mode === "tools") {
      sendEvents(res, [
        standardEvents()[0],
        { type: "response.output_item.added", output_index: 0, item: { type: "message", role: "assistant" } },
        { type: "response.output_text.delta", output_index: 0, delta: "Hi" },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "function_call", call_id: "call_1", name: "lookup" },
        },
        { type: "response.function_call_arguments.delta", output_index: 1, delta: "{}" },
        {
          type: "response.completed",
          response: response([
            { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi", annotations: [] }] },
            { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
          ]),
        },
      ])
    } else {
      sendEvents(res, standardEvents())
    }
  })
  upstream.listen(0, "127.0.0.1")
  await once(upstream, "listening")
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: process.cwd() + "/examples/chat-completions-gateway",
    env: {
      ...process.env,
      OPENAI_API_KEY: "provider",
      GATEWAY_API_KEY: "client",
      OPENAI_MODEL: "gpt-test",
      GATEWAY_MODEL: "chat",
      GATEWAY_PORT: "0",
      OPENAI_RESPONSES_URL: "http://127.0.0.1:" + upstream.address().port + "/v1/responses",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  t.after(async () => {
    const exited = child.exitCode === null ? once(child, "exit") : Promise.resolve()
    child.kill()
    await exited
    const serverClosed = once(upstream, "close")
    upstream.close()
    await serverClosed
  })
  let logs = ""
  const port = await Promise.race([
    new Promise((resolve, reject) => {
      const onData = (chunk) => {
        logs += chunk.toString()
        const address = logs.match(/Listening on (?:https?:\/\/)?127\.0\.0\.1:(\d+)/)
        if (address) resolve(Number(address[1]))
      }
      child.stdout.on("data", onData)
      child.stderr.on("data", onData)
      child.once("exit", (code) => reject(new Error("Gateway exited (" + code + "): " + logs)))
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Gateway startup timed out: " + logs)), 10000).unref(),
    ),
  ])
  return {
    port,
    calls,
    closed,
    setMode: (next) => {
      mode = next
    },
    request: (body, key = "client") =>
      fetch("http://127.0.0.1:" + port + "/v1/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer " + key, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  }
}

test("projects multi-item text, function calls, refusals, and usage", () => {
  const result = toChatCompletion(
    response([
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking", annotations: [] }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
      { type: "function_call", call_id: "call_2", name: "log", arguments: "{}" },
    ]),
    "chat",
  )
  assert.equal(result.id, "chatcmpl-resp_1")
  assert.equal(result.model, "chat")
  assert.equal(result.choices[0].finish_reason, "tool_calls")
  assert.equal(result.choices[0].message.content, "Checking")
  assert.deepEqual(
    result.choices[0].message.tool_calls.map((call) => call.id),
    ["call_1", "call_2"],
  )
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 1)
  assert.equal(
    toChatCompletion(response([{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "No" }] }]))
      .choices[0].message.refusal,
    "No",
  )
  assert.equal(
    toChatCompletion(response([], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }))
      .choices[0].finish_reason,
    "length",
  )
  assert.throws(
    () =>
      toChatCompletion(
        response([
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "x", annotations: [{ type: "url_citation" }] }],
          },
        ]),
      ),
    OpenAIChatCompletionsUpstreamResponseError,
  )
  assert.throws(() => toChatCompletion(response([], { status: "failed" })), OpenAIChatCompletionsUpstreamResponseError)
})

test("Effect Node host routes Chat Completions through OpenResponses", async (t) => {
  const gateway = await fixture(t)
  const minimal = { model: "chat", messages: [{ role: "user", content: "Hi" }] }

  const unauthorized = await gateway.request(minimal, "wrong")
  assert.equal(unauthorized.status, 401)
  assert.equal(Schema.decodeUnknownSync(OpenAIChatCompletionsHttpError)(await unauthorized.json()).error.type, "authentication_error")
  assert.throws(() => Schema.decodeUnknownSync(OpenAIChatCompletionsHttpError)({ error: { message: "bad", type: "unknown" } }))
  assert.equal(gateway.calls.length, 0)
  assert.equal((await gateway.request({ ...minimal, model: "unknown" })).status, 404)
  assert.equal((await gateway.request({ ...minimal, n: 2 })).status, 422)
  assert.equal((await gateway.request({ ...minimal, temperature: "high" })).status, 400)
  assert.equal(gateway.calls.length, 0)

  const json = await gateway.request(minimal)
  assert.equal(json.status, 200)
  assert.equal((await json.json()).choices[0].message.content, "Hello")
  assert.equal(gateway.calls[0].headers.authorization, "Bearer provider")
  assert.deepEqual(gateway.calls[0].body, {
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
  assert.match(streamed.headers.get("content-type"), /text\/event-stream/)
  const frames = (await streamed.text())
    .trim()
    .split("\n\n")
    .map((entry) => entry.slice(6))
  assert.equal(frames.at(-1), "[DONE]")
  const chunks = frames.slice(0, -1).map(JSON.parse)
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
  assert.deepEqual(gateway.calls[1].body.stream_options, { include_obfuscation: false })

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
  const chunkedRequest = (body) =>
    fetch("http://127.0.0.1:" + gateway.port + "/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer client", "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(body)))
          controller.close()
        },
      }),
      duplex: "half",
    })
  const chunked = await chunkedRequest({ ...minimal, messages: [{ role: "user", content: "x".repeat(1024 * 1024) }] })
  assert.equal(chunked.status, 413)
  assert.equal((await chunkedRequest(minimal)).status, 200)

  gateway.setMode("hold")
  const holding = await gateway.request({ ...minimal, stream: true })
  const reader = holding.body.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /chat\.completion\.chunk/)
  await reader.cancel()
  await Promise.race([
    gateway.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Upstream was not canceled")), 3000).unref()),
  ])
})
