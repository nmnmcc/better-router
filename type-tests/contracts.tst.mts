import { Effect, Stream } from "effect"
import type { Scope } from "effect"
import { describe, expect, it } from "tstyche"
import { Router } from "@better-router/core"
import type { Deployment, Plugin } from "@better-router/core"
import type { ModelEvent, ModelRequest, ModelResponse } from "@better-router/core/Model"
import type { OpenAIResponsesDeployment } from "@better-router/plugin-openai-responses/OpenAIResponses"
import type { AnthropicMessagesDeployment } from "@better-router/plugin-anthropic-messages/AnthropicMessages"
import { toResponseRequest } from "@better-router/plugin-openai-chat-completions/OpenAIChatCompletions"

const execute = (_request: ModelRequest): Effect.Effect<Stream.Stream<ModelEvent>> => Effect.succeed(Stream.empty)
const converted: ModelRequest = toResponseRequest({ model: "chat", messages: [] })
void converted

describe("OpenResponses IR", () => {
  it("accepts standard items, tools, and namespaced extensions", () => {
    const request = {
      model: "chat",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Describe this image" },
            { type: "input_image", image_url: "https://example.com/image.png" },
          ],
        },
        { type: "function_call_output", call_id: "call_1", output: "Done" },
        { type: "acme:receipt", id: "receipt_1", status: "completed", data: { ok: true } },
      ],
      tools: [
        { type: "function", name: "lookup", parameters: { type: "object", properties: { city: { type: "string" } } } },
      ],
      previous_response_id: "resp_1",
      text: { format: { type: "json_schema", name: "result", schema: { type: "object" } } },
    } as const satisfies ModelRequest
    expect(request.input[0].type).type.toBe<"message">()
    expect(request.tools[0].parameters.properties.city.type).type.toBe<"string">()

    expect<{
      type: "response.output_text.delta"
      sequence_number: number
      item_id: string
      output_index: number
      content_index: number
      delta: string
    }>().type.toBeAssignableTo<ModelEvent>()
    expect<{ type: "acme:trace"; sequence_number: number; trace_id: string }>().type.toBeAssignableTo<ModelEvent>()
    expect<{
      type: "response.output_item.added"
      sequence_number: number
      output_index: number
      item: { type: "acme:receipt"; id: string; status: string }
    }>().type.toBeAssignableTo<ModelEvent>()
    expect<{
      type: "response.completed"
      sequence_number: number
      response: ModelResponse
    }>().type.toBeAssignableTo<ModelEvent>()
    expect<{
      type: "response.incomplete"
      sequence_number: number
      response: ModelResponse
    }>().type.toBeAssignableTo<ModelEvent>()
    expect<{
      type: "response.failed"
      sequence_number: number
      response: ModelResponse
    }>().type.toBeAssignableTo<ModelEvent>()
  })

  it("rejects old fields, malformed items, and unprefixed extension events", () => {
    expect<{ input: string }>().type.not.toBeAssignableTo<ModelRequest>()
    expect<{
      model: string
      input: [{ type: "message"; role: "user"; content: [{ type: "input_sound"; url: string }] }]
    }>().type.not.toBeAssignableTo<ModelRequest>()
    expect<{
      model: string
      input: [{ type: "acme:receipt"; status: "completed" }]
    }>().type.not.toBeAssignableTo<ModelRequest>()
    expect<{ type: "text-delta"; text: string }>().type.not.toBeAssignableTo<ModelEvent>()
    expect<{ type: "custom-event"; sequence_number: number }>().type.not.toBeAssignableTo<ModelEvent>()
    expect<{ type: "response.completed"; sequence_number: number }>().type.not.toBeAssignableTo<ModelEvent>()
    expect<{ text: string; toolCalls: [] }>().type.not.toBeAssignableTo<ModelResponse>()
  })
})

describe("deployment contracts", () => {
  it("requires an executable upstream transport", () => {
    expect<{ http: typeof execute }>().type.toBeAssignableTo<Deployment.UpstreamExecutors>()
    expect<{ websocket: typeof execute }>().type.toBeAssignableTo<Deployment.UpstreamExecutors>()
    expect<{}>().type.not.toBeAssignableTo<Deployment.UpstreamExecutors>()
    expect<() => Stream.Stream<ModelEvent>>().type.not.toBeAssignableTo<Deployment.ModelExecutor>()
  })

  it("keeps provider-specific transport restrictions", () => {
    const openai = {
      id: "openai-main",
      provider: "openai",
      model: "gpt-5",
      protocol: "openai.responses",
      execute: { http: execute, websocket: execute },
    } as const satisfies OpenAIResponsesDeployment
    expect(openai.execute.websocket).type.toBe<typeof execute>()

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
})

describe("router inference", () => {
  it("propagates plugin services into the acquisition effect", () => {
    interface AuditLog {
      readonly record: (message: string) => void
    }
    const audit: Plugin.RouterPlugin<"audit", AuditLog> = { id: "audit" }
    const router = Router.make({ plugins: [audit], routes: [] })
    expect(router).type.toBe<
      Effect.Effect<
        Router.Router<Router.ComposedHttpApi<readonly [typeof audit]>>,
        Plugin.SetupError,
        Scope.Scope | AuditLog
      >
    >()
    expect<Plugin.PluginRequirements<typeof audit>>().type.toBe<AuditLog>()
  })
})
