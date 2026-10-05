import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Result, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Plugin from "@better-router/core/Plugin"
import * as Router from "@better-router/core/Router"
import { credentialResolverLayer } from "@better-router/core/ProviderContract"
import { plugin } from "@better-router/plugin-anthropic-messages"
import type { Options } from "@better-router/plugin-anthropic-messages"

const deployment = {
	id: "anthropic-preflight",
	provider: "anthropic",
	model: "claude-private",
	protocol: "messages",
	credentialRef: "anthropic-key",
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
	assert.equal(error.id, "anthropic-messages")
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
	{
		name: "invalid default max tokens",
		deployments: [{ ...deployment, defaultMaxTokens: 0 }],
		path: [0, "defaultMaxTokens"],
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
		deployments: [{ ...deployment, provider: "openai" }],
		path: [0, "provider"],
	},
	{
		name: "OpenAI Responses even though the deployment model is valid",
		deployments: [{ ...deployment, protocol: "responses" }],
		path: [0, "protocol"],
	},
] as const)("rejects $name at the Messages plugin bundle boundary", ({ deployments, path }) => {
	assertDeploymentIssue(deployments, path)
})

const outgoingBody = Schema.fromJsonString(
	Schema.Struct({
		model: Schema.NonEmptyString,
		stream: Schema.Boolean,
		max_tokens: Schema.Int,
	}),
)

const sse = [
	'data: {"type":"message_start","message":{"id":"message-primary","model":"claude-private"}}\n\n',
	'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
	'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":2,"output_tokens":1}}\n\n',
	'data: {"type":"message_stop"}\n\n',
].join("")

it.effect("retains Anthropic deployment defaults when composing its runtime", () =>
	Effect.gen(function* () {
		const invoked = yield* Ref.make(0)
		const client = HttpClient.make((outgoing) =>
			Effect.gen(function* () {
				assert.equal(outgoing.url, "https://upstream.example/v1/messages")
				assert.equal(outgoing.headers["x-api-key"], "secret-anthropic-key")
				assert.equal(outgoing.headers["anthropic-version"], "2024-01-01")
				assert.equal(outgoing.body._tag, "Uint8Array")
				const bytes =
					outgoing.body._tag === "Uint8Array" ? outgoing.body.body : new Uint8Array()
				const body = yield* Schema.decodeUnknownEffect(outgoingBody)(
					new TextDecoder().decode(bytes),
				).pipe(Effect.orDie)
				assert.equal(body.model, "claude-private")
				assert.equal(body.stream, true)
				assert.equal(body.max_tokens, 2_048)
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
								id: "anthropic-primary",
								provider: "anthropic",
								model: "claude-private",
								protocol: "messages",
								credentialRef: "anthropic-key",
								baseUrl: "https://upstream.example/v1/messages",
								defaultMaxTokens: 2_048,
								version: "2024-01-01",
							},
						],
						modelRoutes: [{ model: "public", deployments: ["anthropic-primary"] }],
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
		const process = yield* runtime.generate({ model: "public", input: "Hello" })
		const result = yield* process.response
		assert.equal(result.id, "message-primary")
		assert.equal(result.status, "completed")
		assert.equal(result.usage?.total_tokens, 3)
		assert.equal(yield* Ref.get(invoked), 1)
	}),
)
