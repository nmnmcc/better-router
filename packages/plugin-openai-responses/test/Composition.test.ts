import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import type { GenerationResponse } from "@better-router/core/Generation"
import * as Router from "@better-router/core/Router"
import { credentialResolverLayer } from "@better-router/core/ProviderContract"
import { plugin } from "@better-router/plugin-openai-responses"

const outgoingBody = Schema.fromJsonString(
	Schema.Struct({ model: Schema.NonEmptyString, stream: Schema.Boolean }),
)

const response = (model: string): GenerationResponse => ({
	id: `response-${model}`,
	object: "response",
	created_at: 1,
	completed_at: 2,
	status: "completed",
	incomplete_details: null,
	model,
	previous_response_id: null,
	instructions: null,
	output: [],
	error: null,
	tools: [],
	tool_choice: "auto",
	truncation: "disabled",
	parallel_tool_calls: true,
	text: { format: { type: "text" } },
	top_p: 1,
	presence_penalty: 0,
	frequency_penalty: 0,
	top_logprobs: 0,
	temperature: 1,
	reasoning: null,
	usage: null,
	max_output_tokens: null,
	max_tool_calls: null,
	store: false,
	background: false,
	service_tier: "default",
	metadata: null,
	safety_identifier: null,
	prompt_cache_key: null,
})

interface SeenRequest {
	readonly url: string
	readonly authorization: string | undefined
	readonly model: string
}

it.effect("keeps models and credentials independent for multiple OpenAI deployments", () =>
	Effect.gen(function* () {
		const requests = yield* Ref.make<readonly SeenRequest[]>([])
		const client = HttpClient.make((outgoing) =>
			Effect.gen(function* () {
				assert.equal(outgoing.body._tag, "Uint8Array")
				const bytes =
					outgoing.body._tag === "Uint8Array" ? outgoing.body.body : new Uint8Array()
				const body = yield* Schema.decodeUnknownEffect(outgoingBody)(
					new TextDecoder().decode(bytes),
				).pipe(Effect.orDie)
				yield* Ref.update(requests, (current) => [
					...current,
					{
						url: outgoing.url,
						authorization: outgoing.headers.authorization,
						model: body.model,
					},
				])
				return HttpClientResponse.fromWeb(outgoing, Response.json(response(body.model)))
			}),
		)
		const declaration = yield* Effect.fromResult(
			Router.make({
				plugins: [
					plugin({
						deployments: [
							{
								id: "first",
								provider: "openai",
								model: "gpt-first",
								protocol: "responses",
								credentialRef: "first-key",
							},
							{
								id: "second",
								provider: "openai",
								model: "gpt-second",
								protocol: "responses",
								credentialRef: "second-key",
							},
						],
						routes: [
							{ model: "public-first", deployments: ["first"] },
							{ model: "public-second", deployments: ["second"] },
						],
					}),
				] as const,
			}),
		)
		const runtime = yield* Router.runtime(declaration).pipe(
			Effect.provide(
				Layer.merge(
					Layer.succeed(HttpClient.HttpClient, client),
					credentialResolverLayer((reference) =>
						Effect.succeed(Redacted.make(`secret-${reference}`)),
					),
				),
			),
		)
		const responses = yield* Effect.forEach(["public-first", "public-second"], (model) =>
			runtime
				.generate({ model, input: "Hello" })
				.pipe(Effect.flatMap((process) => process.response)),
		)
		assert.deepEqual(
			responses.map((value) => value.id),
			["response-gpt-first", "response-gpt-second"],
		)
		assert.deepEqual(yield* Ref.get(requests), [
			{
				url: "https://api.openai.com/v1/responses",
				authorization: "Bearer secret-first-key",
				model: "gpt-first",
			},
			{
				url: "https://api.openai.com/v1/responses",
				authorization: "Bearer secret-second-key",
				model: "gpt-second",
			},
		])
	}),
)
