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
	gatewayKey: Config.Redacted("GATEWAY_API_KEY"),
	apiKey: Config.Redacted("OPENAI_API_KEY"),
	upstreamModel: Config.String("OPENAI_MODEL"),
	publicModel: Config.String("GATEWAY_MODEL").pipe(Config.withDefault("quickstart")),
	url: Config.URL("OPENAI_RESPONSES_URL").pipe(
		Config.withDefault(new URL("https://api.openai.com/v1/responses")),
	),
	host: Config.String("GATEWAY_HOST").pipe(Config.withDefault("127.0.0.1")),
	port: Config.Int("GATEWAY_PORT").pipe(Config.withDefault(8787)),
})

const HostConfig = Schema.Struct({
	gatewayKey: Schema.Redacted(Schema.NonEmptyString),
	apiKey: Schema.Redacted(Schema.NonEmptyString),
	upstreamModel: Schema.NonEmptyString,
	publicModel: Schema.NonEmptyString,
	url: Schema.URL,
	host: Schema.NonEmptyString,
	port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
})

const server = Layer.unwrap(
	Effect.gen(function* () {
		const config = yield* settings.pipe(Effect.flatMap(Schema.decodeUnknownEffect(HostConfig)))
		const deployment = yield* Effect.fromResult(
			OpenAIResponses.make({
				id: "openai-responses",
				model: config.upstreamModel,
				apiKey: config.apiKey,
				url: config.url,
			}),
		)
		const chat = OpenAIChatCompletionsPlugin.make({ gatewayKey: config.gatewayKey })
		const responses = OpenAIResponsesPlugin.make({ deployments: [deployment] })
		const routes = Layer.unwrap(
			Router.make({
				plugins: [chat, responses] as const,
				routes: [{ model: config.publicModel, deployments: [deployment.id] }],
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
