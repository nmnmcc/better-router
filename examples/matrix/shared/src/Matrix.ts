import { createServer } from "node:http"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Router } from "@better-router/core"
import { AnthropicMessages, AnthropicMessagesPlugin } from "@better-router/plugin-anthropic-messages"
import { OpenAIChatCompletions, OpenAIChatCompletionsPlugin } from "@better-router/plugin-openai-chat-completions"
import { OpenAIResponses, OpenAIResponsesPlugin } from "@better-router/plugin-openai-responses"
import { Config, Effect, Layer, Redacted, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"

export type Protocol = "chat" | "responses" | "anthropic"

const settings = Config.all({
  gatewayKey: Config.String("GATEWAY_API_KEY"),
  openAIKey: Config.String("OPENAI_API_KEY").pipe(Config.withDefault("")),
  anthropicKey: Config.String("ANTHROPIC_API_KEY").pipe(Config.withDefault("")),
  openAIModel: Config.String("OPENAI_MODEL").pipe(Config.withDefault("")),
  anthropicModel: Config.String("ANTHROPIC_MODEL").pipe(Config.withDefault("")),
  publicModel: Config.String("GATEWAY_MODEL").pipe(Config.withDefault("matrix")),
  chatUrl: Config.URL("OPENAI_CHAT_URL").pipe(Config.withDefault(new URL("https://api.openai.com/v1/chat/completions"))),
  responsesUrl: Config.URL("OPENAI_RESPONSES_URL").pipe(Config.withDefault(new URL("https://api.openai.com/v1/responses"))),
  anthropicUrl: Config.URL("ANTHROPIC_MESSAGES_URL").pipe(Config.withDefault(new URL("https://api.anthropic.com/v1/messages"))),
  anthropicMaxTokens: Config.Int("ANTHROPIC_MAX_TOKENS").pipe(Config.withDefault(1024)),
  host: Config.String("GATEWAY_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Int("GATEWAY_PORT").pipe(Config.withDefault(8787)),
})
const HostConfig = Schema.Struct({
  gatewayKey: Schema.NonEmptyString, openAIKey: Schema.String, anthropicKey: Schema.String,
  openAIModel: Schema.String, anthropicModel: Schema.String, publicModel: Schema.NonEmptyString,
  chatUrl: Schema.URL, responsesUrl: Schema.URL, anthropicUrl: Schema.URL,
  anthropicMaxTokens: Schema.Int, host: Schema.NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
})
const HostConfigError = Schema.Struct({ message: Schema.String })

/** Each executable entrypoint declares exactly one ingress and one deployment. */
export function start(ingress: Protocol, upstream: Protocol): void {
  const server = Layer.unwrap(Effect.gen(function* () {
    const config = yield* settings.pipe(Effect.flatMap(Schema.decodeUnknownEffect(HostConfig)))
    if (upstream === "anthropic" ? !config.anthropicKey || !config.anthropicModel
      : !config.openAIKey || !config.openAIModel) {
      return yield* Effect.fail(HostConfigError.make({ message: "Selected upstream key and model are required" }))
    }
    const gatewayKey = Redacted.make(config.gatewayKey)
    const id = `${upstream}-main`
    const chatDeployment = upstream === "chat"
      ? yield* Effect.fromResult(OpenAIChatCompletions.make({
          id, model: config.openAIModel, apiKey: Redacted.make(config.openAIKey), url: config.chatUrl,
        }))
      : undefined
    const responsesDeployment = upstream === "responses"
      ? yield* Effect.fromResult(OpenAIResponses.make({
          id, model: config.openAIModel, apiKey: Redacted.make(config.openAIKey), url: config.responsesUrl,
        }))
      : undefined
    const anthropicDeployment = upstream === "anthropic"
      ? yield* Effect.fromResult(AnthropicMessages.make({
          id, model: config.anthropicModel, apiKey: Redacted.make(config.anthropicKey),
          url: config.anthropicUrl, defaultMaxTokens: config.anthropicMaxTokens,
        }))
      : undefined
    const chat = OpenAIChatCompletionsPlugin.make({
      ...(ingress === "chat" ? { gatewayKey } : {}),
      ...(chatDeployment ? { deployments: [chatDeployment] } : {}),
    })
    const responses = OpenAIResponsesPlugin.make({
      ...(ingress === "responses" ? { gatewayKey } : {}),
      ...(responsesDeployment ? { deployments: [responsesDeployment] } : {}),
    })
    const anthropic = AnthropicMessagesPlugin.make({
      ...(ingress === "anthropic" ? { gatewayKey } : {}),
      ...(anthropicDeployment ? { deployments: [anthropicDeployment] } : {}),
    })
    const routes = Layer.unwrap(Router.make({
      plugins: [chat, responses, anthropic] as const,
      routes: [{ model: config.publicModel, deployments: [id] }],
    }).pipe(Effect.map((router) => router.http.routes)))
    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(createServer, { host: config.host, port: config.port })),
      Layer.provide(NodeHttpClient.layerUndici),
    )
  }))
  Layer.launch(server).pipe(NodeRuntime.runMain)
}
