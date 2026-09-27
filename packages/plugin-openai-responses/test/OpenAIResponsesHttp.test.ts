import assert from "node:assert/strict"
import { it } from "vitest"
import { Result } from "effect"
import { toResponseRequest } from "@better-router/plugin-openai-responses/OpenAIResponsesHttp"

it("normalizes supported input parts without changing their source form", () => {
  const input = {
    model: "private",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Hi" },
          { type: "input_image", image_url: "https://example.com/a.png", detail: "auto" },
        ],
      },
    ],
    tools: [],
  } as const
  const before = structuredClone(input)
  const result = toResponseRequest(input)
  assert.ok(Result.isSuccess(result))
  assert.deepEqual(result.success, {
    model: "private",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Hi" },
          { type: "input_image", image_url: "https://example.com/a.png", detail: "auto" },
        ],
      },
    ],
    tools: [],
  })
  assert.deepEqual(input, before)
})

it("reports item semantics before nested image facts", () => {
  const result = toResponseRequest({
    model: "private",
    input: [
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "not-a-url" }] },
      { type: "reasoning", summary: [] },
    ],
  })
  assert.ok(Result.isFailure(result))
  assert.equal(result.failure.path, "request.input[1].type")
  assert.equal(result.failure.reason, "unsupported")
})

it("reports the first unsupported part before invalid image data", () => {
  const result = toResponseRequest({
    model: "private",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Hi", cache_control: { type: "ephemeral" } },
          { type: "input_image", image_url: "not-a-url" },
        ],
      },
    ],
  })
  assert.ok(Result.isFailure(result))
  assert.equal(result.failure.path, "request.input[0].content[0].cache_control")
  assert.equal(result.failure.reason, "unsupported")
})
