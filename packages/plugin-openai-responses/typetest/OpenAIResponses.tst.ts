import { Effect, Redacted, Result, Stream } from "effect"
import { expect, it } from "tstyche"
import type { ModelEvent, ModelRequest } from "@better-router/core/Model"
import { make as deployment } from "@better-router/plugin-openai-responses/OpenAIResponses"
import type { OpenAIResponsesDeployment } from "@better-router/plugin-openai-responses/OpenAIResponses"
import { make as plugin } from "@better-router/plugin-openai-responses/OpenAIResponsesPlugin"

const execute = (_request: ModelRequest): Effect.Effect<Stream.Stream<ModelEvent>> => Effect.succeed(Stream.empty)

it("supports optional upstream WebSocket alongside HTTP", () => {
  const openai = {
    id: "openai-main",
    provider: "openai",
    model: "gpt-5",
    protocol: "openai.responses",
    execute: { http: execute, websocket: execute },
  } as const satisfies OpenAIResponsesDeployment
  expect(openai.execute.websocket).type.toBe<typeof execute>()
})

it("declares Responses ingress and deployments separately or together", () => {
  const key = Redacted.make("test")
  const configured = deployment({ id: "responses", model: "private", apiKey: key })
  expect(plugin({ gatewayKey: key }).http).type.not.toBe<undefined>()
  if (Result.isSuccess(configured)) {
    expect(plugin({ deployments: [configured.success] }).deployments).type.toBeAssignableTo<readonly (typeof configured.success)[] | undefined>()
    expect(plugin({ gatewayKey: key, deployments: [configured.success] }).http).type.not.toBe<undefined>()
  }
  // @ts-expect-error No overload matches this call
  plugin({ gatewayKey: "plaintext" })
  // @ts-expect-error Type 'string' is not assignable to type 'Redacted<string>'
  deployment({ id: "responses", model: "private", apiKey: "plaintext" })
})
