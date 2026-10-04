import { createServer } from "node:http"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Route, Router } from "@better-router/core"
import { OpenAIResponses } from "@better-router/provider-openai"
import * as ChatCompletions from "@better-router/protocol-openai-chat-completions"
import * as Responses from "@better-router/protocol-openai-responses"
import { Config, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"

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

const server = Layer.unwrap(
	Effect.gen(function* () {
		const config = yield* settings
		const provider = OpenAIResponses.plugin({
			model: config.upstreamModel,
			apiKey: config.apiKey,
			url: config.url,
		})
		const route = Route.plugin({
			[config.publicModel]: (request: Route.Request) =>
				Effect.gen(function* () {
					const openai = yield* OpenAIResponses.OpenAIResponses
					return yield* openai.generate(request)
				}),
		})
		const router = yield* Router.make({
			plugins: [
				route,
				provider,
				ChatCompletions.plugin({ gatewayKey: config.gatewayKey }),
				Responses.plugin({ gatewayKey: config.gatewayKey }),
			] as const,
		})
		return HttpRouter.serve(router.http.routes).pipe(
			Layer.provide(
				NodeHttpServer.layer(createServer, {
					host: config.host,
					port: config.port,
				}),
			),
		)
	}).pipe(Effect.provide(NodeHttpClient.layerUndici)),
)

Layer.launch(server).pipe(NodeRuntime.runMain)
