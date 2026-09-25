import { Effect, Redacted, Result, Stream } from "effect"
import { expect, it } from "tstyche"
import type { ModelEvent, ModelRequest } from "@better-router/core/Model"
import { make as deployment } from "@better-router/plugin-anthropic-messages/AnthropicMessages"
import type { AnthropicMessagesDeployment } from "@better-router/plugin-anthropic-messages/AnthropicMessages"
import { make as plugin } from "@better-router/plugin-anthropic-messages/AnthropicMessagesPlugin"

const execute = (_request: ModelRequest): Effect.Effect<Stream.Stream<ModelEvent>> => Effect.succeed(Stream.empty)

it("accepts HTTP but not upstream WebSocket", () => {
  const anthropic = {
    id: "anthropic-main",
    provider: "anthropic",
    model: "claude",
    protocol: "anthropic.messages",
    execute: { http: execute },
  } as const satisfies AnthropicMessagesDeployment
  expect(anthropic.execute.http).type.toBe<typeof execute>()
  expect<{ http: typeof execute; websocket: typeof execute }>().type.not.toBeAssignableTo<
    AnthropicMessagesDeployment["execute"]
  >()
})

it("declares Messages ingress and deployments with an explicit default token limit", () => {
  const key = Redacted.make("test")
  const upstream = deployment({ id: "anthropic", model: "private", apiKey: key, defaultMaxTokens: 1024 })
  const configured = Result.map(upstream, (value) => plugin({ deployments: [value] }))
  const gateway = Result.map(upstream, (value) => plugin({ gatewayKey: key, deployments: [value] }))
  expect(plugin({ gatewayKey: key }).http).type.not.toBe<undefined>()
  expect(configured).type.toBeAssignableTo<Result.Result<unknown, { readonly message: string }>>()
  expect(gateway).type.toBeAssignableTo<Result.Result<unknown, { readonly message: string }>>()
  // @ts-expect-error Argument of type
  deployment({ id: "anthropic", model: "private", apiKey: key })
  // @ts-expect-error Type 'string' is not assignable to type 'Redacted<string>'
  deployment({ id: "anthropic", model: "private", apiKey: "plaintext", defaultMaxTokens: 1024 })
  // @ts-expect-error No overload matches this call
  plugin({ gatewayKey: "plaintext" })
})
