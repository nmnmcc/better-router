import { createServer } from "node:http"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Router } from "@better-router/core"
import { OpenAIChatCompletionsPlugin } from "@better-router/plugin-openai-chat-completions"
import { OpenAIResponses, OpenAIResponsesPlugin } from "@better-router/plugin-openai-responses"
import { Config, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"

const settings = Config.all({
  apiKey: Config.Redacted("OPENAI_API_KEY"),
  gatewayKey: Config.Redacted("GATEWAY_API_KEY"),
  upstreamModel: Config.String("OPENAI_MODEL"),
  publicModel: Config.String("GATEWAY_MODEL").pipe(Config.withDefault("")),
  url: Config.URL("OPENAI_RESPONSES_URL").pipe(Config.withDefault(new URL("https://api.openai.com/v1/responses"))),
  host: Config.String("GATEWAY_HOST").pipe(Config.withDefault("127.0.0.1")),
  port: Config.Int("GATEWAY_PORT").pipe(Config.withDefault(8787)),
})
const HostConfig = Schema.Struct({
  apiKey: Schema.Redacted(Schema.NonEmptyString),
  gatewayKey: Schema.Redacted(Schema.NonEmptyString),
  upstreamModel: Schema.NonEmptyString,
  publicModel: Schema.String,
  url: Schema.URL,
  host: Schema.NonEmptyString,
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
})

const server = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* settings.pipe(Effect.flatMap(Schema.decodeUnknownEffect(HostConfig)))
    const publicModel = config.publicModel || config.upstreamModel
    const chatCompletions = OpenAIChatCompletionsPlugin.make({ gatewayKey: config.gatewayKey })
    const deployment = yield* Effect.fromResult(
      OpenAIResponses.make({
        id: "openai-main",
        model: config.upstreamModel,
        apiKey: config.apiKey,
        url: config.url,
      }),
    )
    const responses = OpenAIResponsesPlugin.make({
      deployments: [deployment],
    })
    const routes = Layer.unwrap(
      Router.make({
        plugins: [chatCompletions, responses] as const,
        routes: [{ model: publicModel, deployments: ["openai-main"] }],
      }).pipe(Effect.map((router) => router.http.routes)),
    )

    return HttpRouter.serve(routes).pipe(
      Layer.provide(
        NodeHttpServer.layer(createServer, {
          host: config.host,
          port: config.port,
        }),
      ),
      Layer.provide(NodeHttpClient.layerUndici),
    )
  }),
)

Layer.launch(server).pipe(NodeRuntime.runMain)
