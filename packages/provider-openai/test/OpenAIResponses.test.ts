import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Result } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as OpenAIResponses from "@better-router/provider-openai/OpenAIResponses"

const request = { model: "public", input: "Hello" } as const

it("validates provider configuration before constructing a service", () => {
	const result = OpenAIResponses.make({ model: "", apiKey: Redacted.make("secret") })
	assert.equal(Result.isFailure(result), true)
})

it.effect("injects HttpClient and normalizes upstream status failures", () =>
	Effect.gen(function* () {
		const service = yield* OpenAIResponses.OpenAIResponses
		const error = yield* Effect.flip(service.generate(request))
		assert.equal(error.kind, "rate_limited")
		assert.equal(error.retryable, true)
	}).pipe(
		Effect.provide(
			OpenAIResponses.layer({
				model: "gpt-test",
				apiKey: Redacted.make("secret"),
			}).pipe(
				Layer.provide(
					Layer.succeed(
						HttpClient.HttpClient,
						HttpClient.make((outgoing) =>
							Effect.succeed(
								HttpClientResponse.fromWeb(
									outgoing,
									new Response(null, {
										status: 429,
										headers: { "content-type": "application/json" },
									}),
								),
							),
						),
					),
				),
			),
		),
	),
)
