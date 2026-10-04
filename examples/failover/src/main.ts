import { createServer } from "node:http"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Route, Router } from "@better-router/core"
import { AnthropicMessages } from "@better-router/provider-anthropic"
import { OpenAIResponses } from "@better-router/provider-openai"
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
		const openAI = OpenAIResponses.plugin({
			model: config.openAIModel,
			apiKey: config.openAIKey,
			url: config.openAIUrl,
		})
		const anthropic = AnthropicMessages.plugin({
			model: config.anthropicModel,
			apiKey: config.anthropicKey,
			url: config.anthropicUrl,
			defaultMaxTokens: config.anthropicMaxTokens,
		})
		const route = Route.plugin({
			[config.publicModel]: (request: Route.Request) =>
				Effect.gen(function* () {
					const primary = yield* OpenAIResponses.OpenAIResponses
					const fallback = yield* AnthropicMessages.AnthropicMessages
					return yield* primary.generate(request).pipe(
						Effect.catchIf(
							(error) => error.retryable,
							() => fallback.generate(request),
						),
					)
				}),
		})
		const router = yield* Router.make({
			plugins: [
				route,
				openAI,
				anthropic,
				ChatCompletions.plugin({ gatewayKey: config.gatewayKey }),
				Anthropic.plugin({ gatewayKey: config.gatewayKey }),
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
