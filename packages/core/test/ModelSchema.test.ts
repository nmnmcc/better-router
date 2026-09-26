import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Result, Schema, Stream } from "effect"
import { fromSchema } from "@better-router/core/Conversion"
import type { ModelRequest } from "@better-router/core/Model"
import { fromNative, snapshot } from "@better-router/core/ModelEvents"
import { Event, Request, Response, StandardEvent, StandardRequest, StandardResponse } from "@better-router/core/ModelSchema"

const request: ModelRequest = { model: "public", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hi" }] }] }
const resource = snapshot(request, "resp_1", 1234, "private", [], "completed", null, 1235)
const created = { type: "response.created", sequence_number: 0, response: snapshot(request, "resp_1", 1234, "private", [], "in_progress", null, null) }

it("parses and encodes complete pinned requests, responses and events", () => {
  const cases = [
    [StandardRequest, request],
    [Request, request],
    [StandardResponse, resource],
    [Response, resource],
    [StandardEvent, created],
    [Event, created],
  ] as const
  assert.deepEqual(
    cases.map(([schema, value]) => {
      const parsed = Schema.decodeUnknownResult(schema)(value)
      if (Result.isFailure(parsed)) return parsed.failure.message
      const encoded = Schema.encodeUnknownResult(schema)(parsed.success)
      return Result.isSuccess(encoded) ? encoded.success : encoded.failure.message
    }),
    cases.map(([, value]) => value),
  )
})

it("preserves namespaced extensions inside requests, responses and events", () => {
  const input = { type: "acme:source", id: "item_1", status: "completed", payload: { score: 1 } }
  const tool = { type: "acme:search", options: ["fast"] }
  const extendedRequest = { ...request, input: [input], tools: [tool] }
  const extendedResponse = { ...resource, output: [input], tools: [tool] }
  const extendedEvent = { type: "acme:progress", sequence_number: 1, payload: { current: 2 } }
  const cases = [
    [Request, extendedRequest],
    [Response, extendedResponse],
    [Event, extendedEvent],
  ] as const
  assert.deepEqual(
    cases.map(([schema, value]) => {
      const parsed = Schema.decodeUnknownResult(schema)(value)
      if (Result.isFailure(parsed)) return parsed.failure.message
      const encoded = Schema.encodeUnknownResult(schema)(parsed.success)
      return Result.isSuccess(encoded) ? encoded.success : encoded.failure.message
    }),
    cases.map(([, value]) => value),
  )
  assert.equal(Result.isFailure(Schema.decodeUnknownResult(Request)({ ...request, input: [{ ...input, type: "unprefixed" }] })), true)
})

it("retains the nested field path of structural parse failures", () => {
  const parsed = Schema.decodeUnknownResult(Request)({ ...request, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: 42 }] }] })
  assert.ok(Result.isFailure(parsed))
  assert.equal(fromSchema(parsed.failure, "request").path, "request.input[0].content[0].text")
})

it("projects JSON Schema request settings into the complete response wire shape", () => {
  const configured: ModelRequest = {
    model: "private",
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object" },
        strict: true,
      },
    },
  }
  const resource = snapshot(configured, "resp_json", 1234, "private", [], "completed", null, 1235)
  const parsed = Schema.decodeUnknownResult(Response)(resource)
  assert.ok(Result.isSuccess(parsed))
  assert.deepEqual(parsed.success.text.format, {
    type: "json_schema",
    name: "answer",
    description: null,
    schema: null,
    strict: true,
  })
  const defaultFormat = Schema.decodeUnknownResult(Response)(snapshot({ model: "private", text: { verbosity: "high" } }, "resp_text", 1234, "private", [], "completed", null, 1235))
  assert.ok(Result.isSuccess(defaultFormat))
  assert.deepEqual(defaultFormat.success.text, { format: { type: "text" }, verbosity: "high" })
})

it.effect("repeated subscriptions assemble independently numbered terminal streams", () =>
  Effect.gen(function* () {
    const source = Stream.make({ type: "start" as const, id: "resp_1", createdAt: 1234, model: "private" }, { type: "text" as const, value: "Hi" }, { type: "finish" as const, reason: "stop" as const })
    const events = fromNative(request, source)
    const first = yield* Stream.runCollect(events)
    const second = yield* Stream.runCollect(events)
    assert.deepEqual(first, second)
    assert.deepEqual(
      first.map((event) => event.sequence_number),
      Array.from({ length: first.length }, (_, index) => index),
    )
    assert.equal(first.at(-1)?.type, "response.completed")
  }),
)
