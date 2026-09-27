import assert from "node:assert/strict"
import { it } from "vitest"
import { Redacted, Result, Schema } from "effect"
import { snapshot } from "@better-router/core/ModelEvents"
import type { ModelRequest } from "@better-router/core/Model"
import { AnthropicEvent, make, toMessagesRequest } from "@better-router/plugin-anthropic-messages/AnthropicMessages"
import { AnthropicMessage, AnthropicOutboundEvent, AnthropicRequest, toMessage, toResponseRequest } from "@better-router/plugin-anthropic-messages/AnthropicMessagesHttp"

const request = {
  model: "public",
  max_tokens: 64,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "Describe" },
        { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      ],
    },
  ],
}

it("parses Messages requests and projects them without changing the source", () => {
  const original = structuredClone(request)
  const parsed = toResponseRequest(request)
  assert.ok(Result.isSuccess(parsed))
  assert.deepEqual(request, original)
  assert.deepEqual(parsed.success.input, [
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "Describe" },
        { type: "input_image", image_url: "https://example.com/a.png", detail: "auto" },
      ],
    },
  ])
  const outgoing = toMessagesRequest(parsed.success, 1024)
  assert.ok(Result.isSuccess(outgoing))
  assert.deepEqual(outgoing.success.messages, request.messages)
  assert.deepEqual(request, original)
  assert.ok(Result.isSuccess(Schema.encodeUnknownResult(AnthropicRequest)(request)))
})

it("distinguishes structural paths from unportable semantics", () => {
  const invalid = toResponseRequest({ ...request, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: 17 } }] }] })
  assert.ok(Result.isFailure(invalid))
  assert.equal(invalid.failure.reason, "invalid")
  assert.equal(invalid.failure.path, "request.messages[0].content[0].source.url")
  const unsupported = toResponseRequest({ ...request, messages: [{ role: "user", content: [{ type: "text", text: "Hi", cache_control: { type: "ephemeral" } }] }] })
  assert.ok(Result.isFailure(unsupported))
  assert.equal(unsupported.failure.path, "request.messages[0].content[0].cache_control")
  assert.equal(unsupported.failure.reason, "unsupported")
})

it("schema-encodes native responses and ordered event variants", () => {
  const output = [{ id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hello", annotations: [] }] }] as const
  const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
  const message = toMessage(snapshot({ model: "private" }, "resp_1", 1234, "private", output, "completed", usage, 1235), "public")
  assert.ok(Result.isSuccess(message))
  assert.ok(Result.isSuccess(Schema.encodeUnknownResult(AnthropicMessage)(message.success)))
  assert.deepEqual(message.success.content, [{ type: "text", text: "Hello" }])
  assert.ok(Result.isSuccess(Schema.encodeUnknownResult(AnthropicOutboundEvent)({ type: "message_stop" })))
  assert.ok(Result.isSuccess(Schema.decodeUnknownResult(AnthropicEvent)({ type: "message_stop" })))
})

it("deployment construction rejects invalid configuration as data", () => {
  const invalid = make({ id: "bad", model: "private", apiKey: Redacted.make("secret"), defaultMaxTokens: 4 })
  assert.ok(Result.isFailure(invalid))
  assert.match(invalid.failure.message, /defaultMaxTokens/)
})

it("upstream conversion rejects unportable phase, annotations and strict tool semantics", () => {
  const cases: readonly [ModelRequest, string][] = [
    [{ model: "private", input: [{ type: "message", role: "assistant", phase: "commentary", content: "Working" }] }, "phase"],
    [{ model: "private", input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi", annotations: [{ type: "url_citation", start_index: 0, end_index: 2, url: "https://example.com", title: "Source" }] }] }] }, "annotations"],
    [{ model: "private", tools: [{ type: "function", name: "lookup", strict: true }] }, "strict"],
  ]
  assert.deepEqual(
    cases.map(([value, field]) => {
      const converted = toMessagesRequest(value, 1024)
      return Result.isFailure(converted) && converted.failure.message.includes(field)
    }),
    cases.map(() => true),
  )
})

it("groups outgoing text, calls and results without changing source forms", () => {
  const input = [
    { type: "message", role: "assistant", content: "Checking" },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"x"}' },
    { type: "function_call", call_id: "call_2", name: "log", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "found" },
    { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "saved" }] },
    { type: "message", role: "user", content: "Continue" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
  ] as const
  const before = structuredClone(input)
  const result = toMessagesRequest({ model: "private", input, tools: [] }, 64)
  assert.ok(Result.isSuccess(result))
  assert.deepEqual(result.success, {
    model: "private",
    max_tokens: 64,
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking" },
          { type: "tool_use", id: "call_1", name: "lookup", input: { query: "x" } },
          { type: "tool_use", id: "call_2", name: "log", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "found" },
          { type: "tool_result", tool_use_id: "call_2", content: [{ type: "text", text: "saved" }] },
        ],
      },
      { role: "user", content: "Continue" },
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ],
    stream: true,
    tools: [],
  })
  assert.deepEqual(input, before)
  const omitted = toMessagesRequest({ model: "private", input: "Hi" }, 64)
  const nullable = toMessagesRequest({ model: "private", input: "Hi", tools: null }, 64)
  assert.ok(Result.isSuccess(omitted))
  assert.ok(Result.isSuccess(nullable))
  assert.deepEqual(omitted.success, { model: "private", max_tokens: 64, messages: [{ role: "user", content: "Hi" }], stream: true })
  assert.deepEqual(nullable.success, omitted.success)
})
