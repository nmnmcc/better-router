import { expect, it } from "tstyche"
import { Redacted, Result } from "effect"
import type { GenerationRequest } from "@better-router/core/Generation"
import { make as deployment, toResponseRequest } from "@better-router/plugin-openai-chat-completions/OpenAIChatCompletions"
import { make as plugin } from "@better-router/plugin-openai-chat-completions/OpenAIChatCompletionsPlugin"

it("converts Chat requests into the canonical request contract", () => {
  const converted = toResponseRequest({ model: "chat", messages: [] })
  if (Result.isSuccess(converted)) expect(converted.success).type.toBeAssignableTo<GenerationRequest>()
})

it("declares Chat ingress and deployments separately or together with redacted credentials", () => {
  const key = Redacted.make("test")
  const upstream = deployment({ id: "chat", model: "private", apiKey: key })
  expect(plugin({ gatewayKey: key }).http).type.not.toBe<undefined>()
  if (Result.isSuccess(upstream)) {
    expect(plugin({ deployments: [upstream.success] }).deployments).type.toBeAssignableTo<readonly (typeof upstream.success)[] | undefined>()
    expect(plugin({ gatewayKey: key, deployments: [upstream.success] }).http).type.not.toBe<undefined>()
  }
  // @ts-expect-error No overload matches this call
  plugin({ gatewayKey: "plaintext" })
  // @ts-expect-error Type 'string' is not assignable to type 'Redacted<string>'
  deployment({ id: "chat", model: "private", apiKey: "plaintext" })
})
