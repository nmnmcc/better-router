import { createServer } from "node:http"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { ProviderContract, Router } from "@better-router/core"
import * as OpenAI from "@better-router/provider-openai"
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
		const router = yield* Effect.fromResult(
			Router.make({
				plugins: [
					OpenAI.Deployment.plugin({
						deployments: [
							{
								id: "quickstart-openai",
								provider: "openai",
								model: config.upstreamModel,
								protocol: "responses",
								credentialRef: "openai",
								baseUrl: config.url.toString(),
							},
						],
						modelRoutes: [
							{ model: config.publicModel, deployments: ["quickstart-openai"] },
						],
					}),
					ChatCompletions.plugin({ gatewayKey: config.gatewayKey }),
					Responses.plugin({ gatewayKey: config.gatewayKey }),
				] as const,
			}),
		)
		const runtime = yield* Router.runtime(router).pipe(
			Effect.provide(
				ProviderContract.credentialResolverLayer(() => Effect.succeed(config.apiKey)),
			),
		)
		return HttpRouter.serve(runtime.http.routes).pipe(
			Layer.provide(
				NodeHttpServer.layer(createServer, {
					host: config.host,
					port: config.port,
				}),
			),
		)
	}),
).pipe(Layer.provide(NodeHttpClient.layerUndici))

Layer.launch(server).pipe(NodeRuntime.runMain)
