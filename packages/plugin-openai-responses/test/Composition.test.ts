import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import type { GenerationResponse } from "@better-router/core/Generation"
import * as Plugin from "@better-router/core/Plugin"
import * as Router from "@better-router/core/Router"
import { credentialResolverLayer } from "@better-router/core/ProviderContract"
import { plugin } from "@better-router/plugin-openai-responses"
import type { Options } from "@better-router/plugin-openai-responses"

const deployment = {
	id: "responses-preflight",
	provider: "openai",
	model: "gpt-private",
	protocol: "responses",
	credentialRef: "openai-key",
} as const

const assertDeploymentIssue = (deployments: unknown, path: readonly (string | number)[]) => {
	const options = { deployments }
	const before = JSON.stringify(options)
	const result = Router.make({
		plugins: [plugin(options as unknown as Options)] as const,
	})
	assert.equal(JSON.stringify(options), before)
	if (Result.isSuccess(result)) return assert.fail("Expected a typed plugin preflight failure")
	const error = result.failure
	assert.equal(error._tag, "RouterInvalidPlugin")
	if (error._tag !== "RouterInvalidPlugin") return assert.fail("Expected RouterInvalidPlugin")
	assert.equal(error.id, "openai-responses")
	const expectedPath = ["config", "deployments", ...path]
	assert.ok(
		error.issues?.some(
			(issue) =>
				issue.path.length === expectedPath.length &&
				issue.path.every((segment, index) => segment === expectedPath[index]),
		),
		`Expected Schema issue path ${JSON.stringify(expectedPath)}`,
	)
	const encoded = Schema.encodeUnknownResult(Plugin.SetupError)(error)
	if (Result.isFailure(encoded)) return assert.fail("Expected setup failure to encode")
	const decoded = Schema.decodeUnknownResult(Plugin.SetupError)(encoded.success)
	if (Result.isFailure(decoded)) return assert.fail("Expected setup failure to decode")
	assert.equal(decoded.success._tag, "RouterInvalidPlugin")
	if (decoded.success._tag !== "RouterInvalidPlugin")
		return assert.fail("Expected a decoded RouterInvalidPlugin")
	assert.deepEqual(decoded.success.issues, error.issues)
}

it.each([
	{ name: "non-array deployments", deployments: "not-an-array", path: [] },
	{ name: "null deployments", deployments: null, path: [] },
	{ name: "null deployment entry", deployments: [null], path: [0] },
	{ name: "primitive deployment entry", deployments: [42], path: [0] },
	{
		name: "invalid credential reference",
		deployments: [{ ...deployment, credentialRef: 42 }],
		path: [0, "credentialRef"],
	},
	{
		name: "invalid nested tag",
		deployments: [{ ...deployment, tags: ["primary", 42] }],
		path: [0, "tags", 1],
	},
] as const)(
	"returns a Schema-backed setup failure without throwing for $name",
	({ deployments, path }) => {
		assertDeploymentIssue(deployments, path)
	},
)

it.each([
	{
		name: "another provider",
		deployments: [{ ...deployment, provider: "anthropic" }],
		path: [0, "provider"],
	},
	{
		name: "Chat Completions even though the shared OpenAI contract supports it",
		deployments: [{ ...deployment, protocol: "chat-completions" }],
		path: [0, "protocol"],
	},
] as const)("rejects $name at the Responses plugin bundle boundary", ({ deployments, path }) => {
	assertDeploymentIssue(deployments, path)
})

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
						modelRoutes: [
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
