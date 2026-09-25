import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Redacted, Ref, Result, Schema, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { snapshot } from "@better-router/core/ModelEvents"
import { make, OpenAIResponsesInvalidDeploymentUrl } from "@better-router/plugin-openai-responses/OpenAIResponses"

const executor = () => {
  const result = make({ id: "openai", model: "gpt-test", apiKey: Redacted.make("secret") })
  if (Result.isFailure(result)) return assert.fail(result.failure.message)
  return result.success.execute.http
}

it("invalid deployment URLs produce schema-backed errors", () => {
  const result = make({ id: "bad", model: "private", apiKey: Redacted.make("secret"), url: new URL("ftp://example.com") })
  if (Result.isSuccess(result)) return assert.fail("Expected invalid deployment")
  assert.deepEqual(Schema.encodeSync(OpenAIResponsesInvalidDeploymentUrl)(result.failure), {
    _tag: "OpenAIResponsesInvalidDeploymentUrl", message: "Responses URL must use HTTP(S)",
  })
})

it.effect("rejects nonportable extensions before making a request", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const client = HttpClient.make((request) => {
      return Ref.update(calls, (count) => count + 1).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))))
    })
    const execute = executor()
    const extension = yield* execute({
      model: "gpt-test",
      input: [{ type: "acme:receipt", id: "receipt_1", status: "completed" }],
    }).pipe(Effect.flip, Effect.provideService(HttpClient.HttpClient, client))
    assert.equal(extension.kind, "unsupported")
    const background = yield* execute({ model: "gpt-test", background: true }).pipe(Effect.flip, Effect.provideService(HttpClient.HttpClient, client))
    assert.equal(background.kind, "unsupported")
    const reasoning = yield* execute({ model: "gpt-test", reasoning: { effort: "high" } }).pipe(
      Effect.flip, Effect.provideService(HttpClient.HttpClient, client))
    assert.equal(reasoning.kind, "unsupported")
    const builtIn = yield* execute({ model: "gpt-test", tools: [{ type: "web_search" } as never] }).pipe(
      Effect.flip, Effect.provideService(HttpClient.HttpClient, client))
    assert.equal(builtIn.kind, "invalid_request")
    assert.equal(yield* Ref.get(calls), 0)
  }),
)

it.effect("classifies upstream status failures before returning a stream", () =>
  Effect.gen(function* () {
    yield* Effect.forEach([
      [429, "rate_limited", true],
      [401, "unauthorized", false],
      [503, "unavailable", false],
    ] as const, ([status, kind, retryable]) => Effect.gen(function* () {
      const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status }))))
      const error = yield* executor()({ model: "gpt-test" }).pipe(Effect.flip, Effect.provideService(HttpClient.HttpClient, client))
      assert.equal(error.kind, kind)
      assert.equal(error.retryable, retryable)
    }))
  }),
)

it.effect("rejects malformed, unterminated, and trailing SSE frames", () =>
  Effect.gen(function* () {
    const final = JSON.stringify({ type: "response.completed", sequence_number: 0,
      response: snapshot({ model: "gpt-test" }, "resp_1", 1, "gpt-test", [], "completed", null, 2) })
    yield* Effect.forEach([
      ["data: {invalid}\n\n", "Invalid upstream SSE JSON"],
      ["data: " + final.replace('"completed"', '"failed"') + "\n\n", "Invalid terminal response snapshot"],
      ["data: " + final + "\n\ndata: " + final + "\n\n", "Events followed the terminal response"],
      [`data: ${JSON.stringify({ type: "response.created", sequence_number: 0,
        response: snapshot({ model: "gpt-test" }, "resp_1", 1, "gpt-test", [], "in_progress", null, null) })}\n\n`,
      "Upstream stream ended without a terminal response"],
    ] as const, ([body, message]) => Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body, {
              headers: { "content-type": "text/event-stream" },
            }),
          ),
        ),
      )
      const error = yield* Effect.gen(function* () {
        const events = yield* executor()({ model: "gpt-test" })
        return yield* Stream.runCollect(events).pipe(Effect.flip)
      }).pipe(Effect.provideService(HttpClient.HttpClient, client))
      assert.equal(error.message, message)
    }))
  }),
)
