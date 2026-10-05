import { Effect, Redacted } from "effect"
import { ProviderContract, Router } from "@better-router/core"
import * as OpenAI from "@better-router/provider-openai"
import * as Responses from "@better-router/protocol-openai-responses"

const provider = OpenAI.Deployment.plugin({
	deployments: [
		{
			id: "architecture-openai",
			provider: "openai",
			model: "gpt-test",
			protocol: "responses",
			credentialRef: "architecture",
		},
	],
	modelRoutes: [{ model: "architecture", deployments: ["architecture-openai"] }],
})

const protocol = Responses.plugin({ gatewayKey: Redacted.make("gateway") })
const staticResult = Router.make({ plugins: [provider, protocol] as const })

const runtime = Effect.fromResult(staticResult).pipe(
	Effect.flatMap(Router.runtime),
	Effect.provide(
		ProviderContract.credentialResolverLayer(() => Effect.succeed(Redacted.make("secret"))),
	),
)

void runtime
