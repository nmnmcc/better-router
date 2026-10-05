import { createServer } from "node:http"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Provider, ProviderContract, Router } from "@better-router/core"
import * as AnthropicProvider from "@better-router/provider-anthropic"
import * as OpenAI from "@better-router/provider-openai"
import * as Anthropic from "@better-router/protocol-anthropic-messages"
import * as ChatCompletions from "@better-router/protocol-openai-chat-completions"
import { Config, Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"

const settings = Config.all({
	gatewayKey: Config.Redacted("GATEWAY_API_KEY"),
	openAIKey: Config.Redacted("OPENAI_API_KEY"),
	openAIModel: Config.String("OPENAI_MODEL"),
	openAIUrl: Config.URL("OPENAI_RESPONSES_URL").pipe(
		Config.withDefault(new URL("https://api.openai.com/v1/responses")),
	),
	anthropicKey: Config.Redacted("ANTHROPIC_API_KEY"),
	anthropicModel: Config.String("ANTHROPIC_MODEL"),
	anthropicUrl: Config.URL("ANTHROPIC_MESSAGES_URL").pipe(
		Config.withDefault(new URL("https://api.anthropic.com/v1/messages")),
	),
	anthropicMaxTokens: Config.Int("ANTHROPIC_MAX_TOKENS").pipe(Config.withDefault(1024)),
	publicModel: Config.String("GATEWAY_MODEL").pipe(Config.withDefault("reliable")),
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
								id: "primary-openai",
								provider: "openai",
								model: config.openAIModel,
								protocol: "responses",
								credentialRef: "openai",
								baseUrl: config.openAIUrl.toString(),
							},
						],
						modelRoutes: [
							{
								model: config.publicModel,
								deployments: ["primary-openai"],
								fallback: ["fallback-anthropic"],
								retry: { maxAttempts: 2 },
							},
						],
					}),
					AnthropicProvider.Deployment.plugin({
						deployments: [
							{
								id: "fallback-anthropic",
								provider: "anthropic",
								model: config.anthropicModel,
								protocol: "messages",
								credentialRef: "anthropic",
								baseUrl: config.anthropicUrl.toString(),
								defaultMaxTokens: config.anthropicMaxTokens,
							},
						],
					}),
					ChatCompletions.plugin({ gatewayKey: config.gatewayKey }),
					Anthropic.plugin({ gatewayKey: config.gatewayKey }),
				] as const,
			}),
		)
		const runtime = yield* Router.runtime(router).pipe(
			Effect.provide(
				ProviderContract.credentialResolverLayer((reference) =>
					reference === "openai"
						? Effect.succeed(config.openAIKey)
						: reference === "anthropic"
							? Effect.succeed(config.anthropicKey)
							: Effect.fail(
									Provider.Error.make({
										kind: "unauthorized",
										message: `Unknown credential reference: ${reference}`,
										retryable: false,
									}),
								),
				),
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
