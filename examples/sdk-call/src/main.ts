import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { ProviderContract, Router } from "@better-router/core"
import * as OpenAI from "@better-router/provider-openai"
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
	const router = yield* Effect.fromResult(
		Router.make({
			plugins: [
				OpenAI.Deployment.plugin({
					deployments: [
						{
							id: "sdk-openai",
							provider: "openai",
							model: config.upstreamModel,
							protocol: "responses",
							credentialRef: "openai",
							baseUrl: config.url.toString(),
						},
					],
					modelRoutes: [{ model: config.publicModel, deployments: ["sdk-openai"] }],
				}),
			] as const,
		}),
	)
	const runtime = yield* Router.runtime(router).pipe(
		Effect.provide(
			ProviderContract.credentialResolverLayer(() => Effect.succeed(config.apiKey)),
		),
	)
	const process = yield* runtime.generate({
		model: config.publicModel,
		input: "Give me one practical tip for designing a model router.",
	})
	const response = yield* process.response.pipe(Effect.ensuring(process.cancel))
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

	yield* Effect.log(
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
