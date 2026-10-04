import { Stream } from "effect"
import { Generation, Route, Router } from "@better-router/core"
import { OpenAIResponses } from "@better-router/provider-openai"
import * as Responses from "@better-router/protocol-openai-responses"

const route = Route.layer({
	chat: (request: Route.Request<"chat">) => {
		void request
		return Generation.Process.make(
			Stream.succeed({
				type: "response.completed" as const,
				sequence_number: 0,
				response: {} as never,
			}),
		)
	},
})

const provider = OpenAIResponses.layer({
	model: "gpt-test",
	apiKey: "secret",
})

const composed = Router.make({
	route,
	providers: [provider],
	apis: [Responses.contract],
})

void composed
