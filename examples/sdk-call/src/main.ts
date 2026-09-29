import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Execution, Router } from "@better-router/core"
import { OpenAIResponses, OpenAIResponsesPlugin } from "@better-router/plugin-openai-responses"
import { Config, Effect, Match } from "effect"

const settings = Config.all({
	apiKey: Config.Redacted("OPENAI_API_KEY"),
	upstreamModel: Config.String("OPENAI_MODEL"),
	publicModel: Config.String("ROUTER_MODEL").pipe(Config.withDefault("sdk-demo")),
	url: Config.URL("OPENAI_RESPONSES_URL").pipe(
		Config.withDefault(new URL("https://api.openai.com/v1/responses")),
	),
})

const program = Effect.gen(function* () {
	const config = yield* settings
	const deployment = yield* Effect.fromResult(
		OpenAIResponses.make({
			id: "openai-sdk",
			model: config.upstreamModel,
			apiKey: config.apiKey,
			url: config.url,
		}),
	)
	const router = yield* Router.make({
		plugins: [OpenAIResponsesPlugin.make({ deployments: [deployment] })] as const,
	})({
		routes: [{ model: config.publicModel, deployments: [deployment.id] }],
	})
	const execution = yield* router.invoke({
		type: "generation",
		request: {
			model: config.publicModel,
			input: "Give me one practical tip for designing a model router.",
		},
	})
	const response = yield* Match.value(execution).pipe(
		Match.discriminatorsExhaustive("type")({
			generation: (value) => Execution.complete(value.events),
			opaque: () =>
				Effect.fail(
					Router.RouterError.cases.InvalidResponse.make({
						message: "Expected a semantic generation execution",
					}),
				),
		}),
	)
	const text = response.output
		.flatMap((item) =>
			Match.value(item).pipe(
				Match.when({ type: "message" }, (value) =>
					value.content.flatMap((part) => ("text" in part ? [part.text] : [])),
				),
				Match.orElse(() => []),
			),
		)
		.join("")
	console.log(
		JSON.stringify(
			{
				model: response.model,
				text,
				usage: response.usage,
			},
			null,
			2,
		),
	)
})

Effect.scoped(program).pipe(Effect.provide(NodeHttpClient.layerUndici), NodeRuntime.runMain)
