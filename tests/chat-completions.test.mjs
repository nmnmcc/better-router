import assert from "node:assert/strict"
import { test } from "node:test"
import { Schema } from "effect"
import { OpenAIChatCompletionsConversionError, toResponseRequest } from "@better-router/plugin-openai-chat-completions/OpenAIChatCompletions"

test("conversion errors are schema-backed and remain Error instances", () => {
  const error = OpenAIChatCompletionsConversionError.at("messages[0]", "unsupported", "unknown role")
  assert.equal(error instanceof Error, true)
  assert.equal(error.message, "messages[0]: unknown role")
  const encoded = Schema.encodeSync(OpenAIChatCompletionsConversionError)(error)
  assert.deepEqual(encoded, {
    _tag: "OpenAIChatCompletionsConversionError",
    path: "messages[0]",
    reason: "unsupported",
    message: "messages[0]: unknown role",
  })
  assert.equal(Schema.decodeUnknownSync(OpenAIChatCompletionsConversionError)(encoded).path, "messages[0]")
  assert.throws(() => Schema.decodeUnknownSync(OpenAIChatCompletionsConversionError)({ ...encoded, reason: "bad" }))
})

test("converts messages, images, function calls and tool results in order", () => {
  const request = {
    model: "chat",
    messages: [
      { role: "system", content: "Be concise" },
      { role: "developer", content: [{ type: "text", text: "Use tools" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this photo?" },
          { type: "image_url", image_url: { url: "https://example.com/a.png", detail: "high" } },
        ],
      },
      {
        role: "assistant",
        content: "Checking",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "identify", arguments: '{"image":1}' } },
          { id: "call_2", type: "function", function: { name: "log", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "a mountain" },
      { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "logged" }] },
      { role: "assistant", content: "A mountain" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "identify",
          description: "Identify an image",
          parameters: { type: "object", properties: { image: { type: "number" } } },
          strict: true,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "identify" } },
    response_format: { type: "json_schema", json_schema: { name: "result", schema: { type: "object" }, strict: true } },
    max_completion_tokens: 128,
    parallel_tool_calls: true,
    stream: true,
    temperature: 0.4,
    metadata: { workflow: "vision" },
  }

  assert.deepEqual(toResponseRequest(request), {
    model: "chat",
    input: [
      { type: "message", role: "system", content: "Be concise" },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Use tools" }] },
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "What is in this photo?" },
          { type: "input_image", image_url: "https://example.com/a.png", detail: "high" },
        ],
      },
      { type: "message", role: "assistant", content: "Checking" },
      { type: "function_call", call_id: "call_1", name: "identify", arguments: '{"image":1}' },
      { type: "function_call", call_id: "call_2", name: "log", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "a mountain" },
      { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "logged" }] },
      { type: "message", role: "assistant", content: "A mountain" },
    ],
    tools: [
      {
        type: "function",
        name: "identify",
        description: "Identify an image",
        parameters: { type: "object", properties: { image: { type: "number" } } },
        strict: true,
      },
    ],
    tool_choice: { type: "function", name: "identify" },
    text: { format: { type: "json_schema", name: "result", schema: { type: "object" }, strict: true } },
    max_output_tokens: 128,
    parallel_tool_calls: true,
    stream: true,
    temperature: 0.4,
    metadata: { workflow: "vision" },
  })
  assert.deepEqual(request.messages[3].tool_calls[0].function, { name: "identify", arguments: '{"image":1}' })
})

test("handles tool-only assistant messages and simple options", () => {
  assert.deepEqual(
    toResponseRequest({
      model: "chat",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "x", type: "function", function: { name: "run", arguments: "{}" } }],
        },
      ],
      max_tokens: 32,
      n: 1,
      tool_choice: "auto",
      response_format: { type: "text" },
      top_p: 0.5,
      presence_penalty: -1,
      frequency_penalty: 1,
      store: false,
    }),
    {
      model: "chat",
      input: [{ type: "function_call", call_id: "x", name: "run", arguments: "{}" }],
      max_output_tokens: 32,
      tool_choice: "auto",
      text: { format: { type: "text" } },
      top_p: 0.5,
      presence_penalty: -1,
      frequency_penalty: 1,
      store: false,
    },
  )
})

test("rejects unsupported semantics with their field path", () => {
  const minimal = { model: "chat", messages: [{ role: "user", content: "hi" }] }
  for (const [request, path] of [
    [{ ...minimal, n: 2 }, "request.n"],
    [{ ...minimal, stop: ["stop"] }, "request.stop"],
    [{ ...minimal, response_format: { type: "json_object" } }, "response_format.type"],
    [
      { ...minimal, messages: [{ role: "user", content: [{ type: "input_audio", data: "..." }] }] },
      "messages[0].content[0].type",
    ],
    [
      { ...minimal, messages: [{ role: "assistant", content: "", function_call: { name: "f", arguments: "{}" } }] },
      "messages[0].function_call",
    ],
    [
      {
        ...minimal,
        messages: [{ role: "assistant", content: "", tool_calls: [{ type: "custom", id: "1", function: {} }] }],
      },
      "messages[0].tool_calls[0].type",
    ],
    [{ ...minimal, tools: [{ type: "custom", function: {} }] }, "tools[0].type"],
    [{ ...minimal, max_completion_tokens: 1 }, "request.max_completion_tokens"],
    [
      { ...minimal, metadata: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [String(index), "value"])) },
      "request.metadata",
    ],
  ]) {
    assert.throws(
      () => toResponseRequest(request),
      (error) => error instanceof OpenAIChatCompletionsConversionError && error.path === path && error.reason === "unsupported",
    )
  }
})

test("rejects malformed requests without dropping nested data", () => {
  const minimal = { model: "chat", messages: [{ role: "user", content: "hi" }] }
  for (const [request, path] of [
    [{ ...minimal, messages: [{ role: "assistant", content: null, tool_calls: [] }] }, "messages[0]"],
    [
      { ...minimal, messages: [{ role: "user", content: [{ type: "image_url", image_url: { detail: "high" } }] }] },
      "messages[0].content[0].image_url.url",
    ],
    [{ ...minimal, max_tokens: 32, max_completion_tokens: 32 }, "request.max_tokens"],
    [{ ...minimal, temperature: Number.NaN }, "request.temperature"],
    [{ ...minimal, metadata: { team: 10 } }, "request.metadata.team"],
    [{ ...minimal, max_completion_tokens: null }, "request.max_completion_tokens"],
  ]) {
    assert.throws(
      () => toResponseRequest(request),
      (error) => error instanceof OpenAIChatCompletionsConversionError && error.path === path && error.reason === "invalid",
    )
  }
})
