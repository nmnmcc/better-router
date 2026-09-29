import assert from "node:assert/strict"
import { it as test } from "vitest"
import { Result, Schema } from "effect"
import { OpenAIChatCompletionsConversionError, parseRequest, toChatRequest, toResponseRequest } from "@better-router/plugin-openai-chat-completions/OpenAIChatCompletions"

const success = (value: unknown) => {
  const result = toResponseRequest(value)
  if (Result.isFailure(result)) return assert.fail(result.failure.message)
  return result.success
}
const failure = (value: unknown) => {
  const result = toResponseRequest(value)
  if (Result.isSuccess(result)) return assert.fail("Expected conversion failure")
  return result.failure
}

test("conversion errors are schema-backed values", () => {
  const error = OpenAIChatCompletionsConversionError.make({ path: "messages[0]", reason: "unsupported", message: "messages[0]: unknown role" })
  assert.equal(error.message, "messages[0]: unknown role")
  const encoded = Schema.encodeSync(OpenAIChatCompletionsConversionError)(error)
  assert.deepEqual(encoded, {
    _tag: "ConversionError",
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

  assert.deepEqual(success(request), {
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
  assert.deepEqual(request.messages[3]?.tool_calls?.[0]?.function, { name: "identify", arguments: '{"image":1}' })
})

test("handles tool-only assistant messages and simple options", () => {
  assert.deepEqual(
    success({
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
  const cases = [
    [{ ...minimal, n: 2 }, "request.n"],
    [{ ...minimal, stop: ["stop"] }, "request.stop"],
    [{ ...minimal, response_format: { type: "json_object" } }, "response_format.type"],
    [{ ...minimal, messages: [{ role: "user", content: [{ type: "input_audio", data: "..." }] }] }, "messages[0].content[0].type"],
    [{ ...minimal, messages: [{ role: "assistant", content: "", function_call: { name: "f", arguments: "{}" } }] }, "messages[0].function_call"],
    [
      {
        ...minimal,
        messages: [{ role: "assistant", content: "", tool_calls: [{ type: "custom", id: "1", function: {} }] }],
      },
      "messages[0].tool_calls[0].type",
    ],
    [{ ...minimal, tools: [{ type: "custom", function: {} }] }, "tools[0].type"],
    [{ ...minimal, max_completion_tokens: 1 }, "request.max_completion_tokens"],
    [{ ...minimal, metadata: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [String(index), "value"])) }, "request.metadata"],
  ] as const
  assert.deepEqual(
    cases.map(([request, path]) => {
      const error = failure(request)
      return [error.path.endsWith(path), error.reason]
    }),
    cases.map(() => [true, "unsupported"]),
  )
})

test("rejects malformed requests without dropping nested data", () => {
  const minimal = { model: "chat", messages: [{ role: "user", content: "hi" }] }
  const cases = [
    [{ ...minimal, messages: [{ role: "assistant", content: null, tool_calls: [] }] }, "messages[0]"],
    [{ ...minimal, messages: [{ role: "user", content: [{ type: "image_url", image_url: { detail: "high" } }] }] }, "messages[0].content[0].image_url.url"],
    [{ ...minimal, max_tokens: 32, max_completion_tokens: 32 }, "request.max_tokens"],
    [{ ...minimal, temperature: Number.NaN }, "request.temperature"],
    [{ ...minimal, metadata: { team: 10 } }, "request.metadata.team"],
    [{ ...minimal, max_completion_tokens: null }, "request.max_completion_tokens"],
  ] as const
  assert.deepEqual(
    cases.map(([request, path]) => {
      const error = failure(request)
      return [error.path.endsWith(path), error.reason]
    }),
    cases.map(() => [true, "invalid"]),
  )
})

test("upstream conversion refuses meaningful fields without a Chat projection", () => {
  const annotated = toChatRequest({ model: "private", input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello", annotations: [{ type: "url_citation", start_index: 0, end_index: 5, url: "https://example.com", title: "Source" }] }] }] })
  assert.ok(Result.isFailure(annotated))
  assert.match(annotated.failure.message, /annotations/)
  const phased = toChatRequest({ model: "private", input: [{ type: "message", role: "assistant", phase: "commentary", content: "Working" }] })
  assert.ok(Result.isFailure(phased))
  assert.match(phased.failure.message, /phase/)
})

test("upstream conversion accumulates typed assistant calls without changing input", () => {
  const request = {
    model: "private",
    input: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: `{"q":1}` },
      { type: "function_call", call_id: "call_2", name: "log", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_text", text: "done" }] },
      { type: "function_call", call_id: "call_3", name: "finish", arguments: "{}" },
    ],
    tools: [{ type: "function", name: "lookup", description: "Look up a value", parameters: { type: "object" }, strict: false }],
  } as const
  const before = JSON.parse(JSON.stringify(request.input))
  const result = toChatRequest(request)
  assert.ok(Result.isSuccess(result))
  assert.deepEqual(result.success, {
    model: "private",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Checking" }],
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "lookup", arguments: `{"q":1}` } },
          { id: "call_2", type: "function", function: { name: "log", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "done" }] },
      { role: "assistant", content: null, tool_calls: [{ id: "call_3", type: "function", function: { name: "finish", arguments: "{}" } }] },
    ],
    stream: true,
    stream_options: { include_usage: true },
    tools: [{ type: "function", function: { name: "lookup", description: "Look up a value", parameters: { type: "object" }, strict: false } }],
  })
  assert.deepEqual(request.input, before)
})

test("native parsing returns canonical request and ingress stream facts together", () => {
  const result = parseRequest({ model: "private", messages: [{ role: "user", content: "Hi" }], stream: true, stream_options: { include_usage: true, include_obfuscation: false } })
  assert.ok(Result.isSuccess(result))
  assert.deepEqual(result.success.ingress, { stream: true, hasStreamOptions: true, includeUsage: true })
  assert.deepEqual(result.success.request, {
    model: "private",
    input: [{ type: "message", role: "user", content: "Hi" }],
    stream: true,
    stream_options: { include_obfuscation: false },
  })
  const projected = toResponseRequest({ model: "private", messages: [{ role: "user", content: "Hi" }], stream: true, stream_options: { include_usage: true, include_obfuscation: false } })
  assert.ok(Result.isSuccess(projected))
  assert.deepEqual(projected.success, result.success.request)
})
