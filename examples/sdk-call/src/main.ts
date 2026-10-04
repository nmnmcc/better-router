import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { Route, Router } from "@better-router/core"
import { OpenAIResponses } from "@better-router/provider-openai"
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
	const router = yield* Router.make({ plugins: [route, provider] as const })
	const process = yield* router.generate({
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
