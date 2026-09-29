import { createServer } from "node:http"
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Router } from "@better-router/core"
import {
	AnthropicMessages,
	AnthropicMessagesPlugin,
} from "@better-router/plugin-anthropic-messages"
import { OpenAIChatCompletionsPlugin } from "@better-router/plugin-openai-chat-completions"
import { OpenAIResponses, OpenAIResponsesPlugin } from "@better-router/plugin-openai-responses"
import { Config, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"

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

const HostConfig = Schema.Struct({
	gatewayKey: Schema.Redacted(Schema.NonEmptyString),
	openAIKey: Schema.Redacted(Schema.NonEmptyString),
	openAIModel: Schema.NonEmptyString,
	openAIUrl: Schema.URL,
	anthropicKey: Schema.Redacted(Schema.NonEmptyString),
	anthropicModel: Schema.NonEmptyString,
	anthropicUrl: Schema.URL,
	anthropicMaxTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(16)),
	publicModel: Schema.NonEmptyString,
	host: Schema.NonEmptyString,
	port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
})

const server = Layer.unwrap(
	Effect.gen(function* () {
		const config = yield* settings.pipe(Effect.flatMap(Schema.decodeUnknownEffect(HostConfig)))
		const primary = yield* Effect.fromResult(
			OpenAIResponses.make({
				id: "openai-primary",
				model: config.openAIModel,
				apiKey: config.openAIKey,
				url: config.openAIUrl,
			}),
		)
		const fallback = yield* Effect.fromResult(
			AnthropicMessages.make({
				id: "anthropic-fallback",
				model: config.anthropicModel,
				apiKey: config.anthropicKey,
				url: config.anthropicUrl,
				defaultMaxTokens: config.anthropicMaxTokens,
			}),
		)
		const chat = OpenAIChatCompletionsPlugin.make({ gatewayKey: config.gatewayKey })
		const responses = OpenAIResponsesPlugin.make({ deployments: [primary] })
		const anthropic = AnthropicMessagesPlugin.make({ deployments: [fallback] })
		const routes = Layer.unwrap(
			Router.make({
				plugins: [chat, responses, anthropic] as const,
			})({
				routes: [
					{
						model: config.publicModel,
						deployments: [primary.id, fallback.id],
					},
				],
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
