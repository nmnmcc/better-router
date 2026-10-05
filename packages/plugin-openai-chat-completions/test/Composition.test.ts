import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Plugin from "@better-router/core/Plugin"
import * as Router from "@better-router/core/Router"
import { credentialResolverLayer } from "@better-router/core/ProviderContract"
import { plugin } from "@better-router/plugin-openai-chat-completions"
import type { Options } from "@better-router/plugin-openai-chat-completions"

const deployment = {
	id: "chat-preflight",
	provider: "openai",
	model: "gpt-private",
	protocol: "chat-completions",
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
	assert.equal(error.id, "openai-chat-completions")
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
		deployments: [{ ...deployment, tags: ["ok", 42] }],
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
		name: "Responses even though the shared OpenAI contract supports it",
		deployments: [{ ...deployment, protocol: "responses" }],
		path: [0, "protocol"],
	},
] as const)(
	"rejects $name at the Chat Completions plugin bundle boundary",
	({ deployments, path }) => {
		assertDeploymentIssue(deployments, path)
	},
)

const outgoingBody = Schema.fromJsonString(
	Schema.Struct({ model: Schema.NonEmptyString, stream: Schema.Boolean }),
)

const sse = [
	'data: {"id":"chat-primary","created":1,"model":"gpt-private","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
	'data: {"id":"chat-primary","created":1,"model":"gpt-private","choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
	"data: [DONE]\n\n",
].join("")

it.effect("binds a Chat Completions plugin to its deployment without singleton services", () =>
	Effect.gen(function* () {
		const invoked = yield* Ref.make(0)
		const client = HttpClient.make((outgoing) =>
			Effect.gen(function* () {
				assert.equal(outgoing.url, "https://upstream.example/v1/chat/completions")
				assert.equal(outgoing.headers.authorization, "Bearer secret-chat-key")
				assert.equal(outgoing.body._tag, "Uint8Array")
				const bytes =
					outgoing.body._tag === "Uint8Array" ? outgoing.body.body : new Uint8Array()
				const body = yield* Schema.decodeUnknownEffect(outgoingBody)(
					new TextDecoder().decode(bytes),
				).pipe(Effect.orDie)
				assert.equal(body.model, "gpt-private")
				assert.equal(body.stream, true)
				yield* Ref.update(invoked, (count) => count + 1)
				return HttpClientResponse.fromWeb(
					outgoing,
					new Response(sse, { headers: { "content-type": "text/event-stream" } }),
				)
			}),
		)
		const declaration = yield* Effect.fromResult(
			Router.make({
				plugins: [
					plugin({
						deployments: [
							{
								id: "chat-primary",
								provider: "openai",
								model: "gpt-private",
								protocol: "chat-completions",
								credentialRef: "chat-key",
								baseUrl: "https://upstream.example/v1/chat/completions",
							},
						],
						modelRoutes: [{ model: "public", deployments: ["chat-primary"] }],
					}),
				] as const,
			}),
		)
		const result = yield* Effect.gen(function* () {
			const runtime = yield* Router.RouterRuntime
			const process = yield* runtime.generate({ model: "public", input: "Hello" })
			return yield* process.response
		}).pipe(
			Effect.provide(
				Router.layer(declaration).pipe(
					Layer.provide(
						Layer.merge(
							Layer.succeed(HttpClient.HttpClient, client),
							credentialResolverLayer((reference) =>
								Effect.succeed(Redacted.make(`secret-${reference}`)),
							),
						),
					),
				),
			),
		)
		assert.equal(result.id, "chat-primary")
		assert.equal(result.status, "completed")
		assert.equal(yield* Ref.get(invoked), 1)
	}),
)
