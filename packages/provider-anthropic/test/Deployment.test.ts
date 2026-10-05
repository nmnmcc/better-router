import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Result, Schema, SchemaIssue } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as ProviderContract from "@better-router/core/ProviderContract"
import * as Messages from "@better-router/provider-anthropic/AnthropicMessages"
import * as Deployment from "@better-router/provider-anthropic/Deployment"

const config = {
	model: "claude-private",
	apiKey: Redacted.make("secret"),
	defaultMaxTokens: 256,
} as const

it("publishes an Anthropic generation contract", () => {
	assert.equal(Deployment.contract.id, "anthropic")
	assert.deepEqual(Deployment.contract.protocols, ["messages"])
	assert.deepEqual(Deployment.contract.endpoints, [
		{
			id: "messages",
			parameters: [
				"input",
				"instructions",
				"tools",
				"stream",
				"temperature",
				"top_p",
				"max_output_tokens",
			],
			streaming: true,
			capabilities: ["provider.anthropic.messages"],
		},
	])
})

it("preflights only the Messages endpoint and its stable parameter inventory", () => {
	const declaration: Deployment.DeploymentConfig = {
		id: "messages",
		provider: "anthropic",
		model: "claude-private",
		protocol: "messages",
		credentialRef: "key",
	}
	assert.deepEqual(ProviderContract.capabilitiesForDeployment(Deployment.contract, declaration), [
		"provider.anthropic.messages",
	])
	assert.ok(
		Result.isSuccess(
			ProviderContract.validateDeployment(Deployment.contract, {
				...declaration,
				parameters: ["tools", "max_output_tokens"],
				capabilities: ["provider.anthropic.messages"],
			}),
		),
	)
	assert.ok(
		Result.isFailure(
			ProviderContract.validateDeployment(Deployment.contract, {
				...declaration,
				endpoint: "responses",
			}),
		),
	)
	assert.ok(
		Result.isFailure(
			ProviderContract.validateDeployment(Deployment.contract, {
				...declaration,
				parameters: ["previous_response_id"],
			}),
		),
	)
	assert.deepEqual(
		Deployment.messagesCapability.endpoints?.map(
			(endpoint: ProviderContract.Endpoint) => endpoint.id,
		),
		["messages"],
	)
})

it("encodes credentials, version, and the deployment model", () => {
	const encoded = Messages.encodeRequest(config, { model: "public", input: "hello" })
	assert.equal(Result.isSuccess(encoded), true)
	if (Result.isFailure(encoded)) return
	assert.equal(encoded.success.url, "https://api.anthropic.com/v1/messages")
	assert.equal(encoded.success.headers["x-api-key"], "secret")
	assert.equal(encoded.success.headers["anthropic-version"], "2023-06-01")
	assert.equal(encoded.success.body.model, "claude-private")
})

it("classifies rate limits and authentication failures", () => {
	const limited = Messages.classifyStatus(429)
	assert.equal(limited.kind, "rate_limited")
	assert.equal(limited.retryable, true)
	const unauthorized = Messages.classifyStatus(401)
	assert.equal(unauthorized.kind, "unauthorized")
	assert.equal(unauthorized.retryable, false)
})

const deploymentUrlCases = [
	[undefined, "https://api.anthropic.com/v1/messages"],
	["https://upstream.example", "https://upstream.example/v1/messages"],
	["https://upstream.example/", "https://upstream.example/v1/messages"],
	["https://upstream.example/v1", "https://upstream.example/v1/messages"],
	["https://upstream.example/v1/", "https://upstream.example/v1/messages"],
	["https://upstream.example/v1///", "https://upstream.example/v1/messages"],
	["https://upstream.example/proxy/team/", "https://upstream.example/proxy/team/v1/messages"],
	[
		"https://upstream.example/proxy/v1/?region=hk&route=a%2Fb#request",
		"https://upstream.example/proxy/v1/messages?region=hk&route=a%2Fb#request",
	],
	[
		"https://upstream.example/proxy/v1/messages?region=hk",
		"https://upstream.example/proxy/v1/messages?region=hk",
	],
	[
		"https://upstream.example/custom/messages/?region=hk",
		"https://upstream.example/custom/messages/?region=hk",
	],
] as const

it.effect(
	"derives Messages URLs without duplicating versions or losing custom paths and queries",
	() =>
		Effect.forEach(deploymentUrlCases, ([baseUrl, expectedUrl]) => {
			const declaration: Deployment.DeploymentConfig = {
				id: "custom",
				provider: "anthropic",
				model: "claude-private",
				protocol: "messages",
				credentialRef: "key",
				...(baseUrl === undefined ? {} : { baseUrl }),
			}
			const snapshot = JSON.stringify(declaration)
			return Effect.gen(function* () {
				const service = yield* Deployment.createForDeployment(declaration)
				const failure = yield* Effect.flip(
					service.generate({ model: "public", input: "hello" }),
				)
				assert.equal(failure.kind, "rate_limited")
				assert.equal(JSON.stringify(declaration), snapshot)
			}).pipe(
				Effect.provide(
					Layer.merge(
						ProviderContract.credentialResolverLayer(() =>
							Effect.succeed(Redacted.make("secret")),
						),
						Layer.succeed(
							HttpClient.HttpClient,
							HttpClient.make((outgoing, url) => {
								assert.equal(url.toString(), expectedUrl)
								return Effect.succeed(
									HttpClientResponse.fromWeb(
										outgoing,
										new Response(null, { status: 429 }),
									),
								)
							}),
						),
					),
				),
			)
		}).pipe(Effect.asVoid),
)

it("preflights Anthropic credentials and HTTP(S) base URLs with field paths", () => {
	const missingCredential = Deployment.contract.validateEnvironment?.({
		id: "missing",
		provider: "anthropic",
		model: "claude-private",
		protocol: "messages",
	})
	assert.ok(missingCredential && Result.isFailure(missingCredential))
	if (missingCredential && Result.isFailure(missingCredential))
		assert.deepEqual(
			missingCredential.failure.issues?.map((issue) => issue.path),
			[["credentialRef"]],
		)

	const invalidScheme = Deployment.contract.validateEnvironment?.({
		id: "ftp",
		provider: "anthropic",
		model: "claude-private",
		protocol: "messages",
		credentialRef: "key",
		baseUrl: "ftp://upstream.example/v1",
	})
	assert.ok(invalidScheme && Result.isFailure(invalidScheme))
	if (invalidScheme && Result.isFailure(invalidScheme))
		assert.deepEqual(
			invalidScheme.failure.issues?.map((issue) => issue.path),
			[["baseUrl"]],
		)

	const relativeUrl = Deployment.contract.validateEnvironment?.({
		id: "relative",
		provider: "anthropic",
		model: "claude-private",
		protocol: "messages",
		credentialRef: "key",
		baseUrl: "/v1/messages",
	})
	assert.ok(relativeUrl && Result.isFailure(relativeUrl))
	if (relativeUrl && Result.isFailure(relativeUrl))
		assert.deepEqual(
			relativeUrl.failure.issues?.map((issue) => issue.path),
			[["baseUrl"]],
		)

	const invalidLimit = Deployment.contract.validateEnvironment?.({
		id: "limit",
		provider: "anthropic",
		model: "claude-private",
		protocol: "messages",
		credentialRef: "key",
		limits: { tpm: -1 },
	})
	assert.ok(invalidLimit && Result.isFailure(invalidLimit))
	if (invalidLimit && Result.isFailure(invalidLimit))
		assert.deepEqual(
			invalidLimit.failure.issues?.map((issue) => issue.path),
			[["limits", "tpm"]],
		)

	assert.ok(
		Result.isSuccess(
			ProviderContract.validateDeployment(Deployment.contract, {
				id: "valid",
				provider: "anthropic",
				model: "claude-private",
				protocol: "messages",
				credentialRef: "key",
				baseUrl: "https://upstream.example/v1",
			}),
		),
	)
})

it.effect("preserves nested runtime deployment Schema issue paths", () =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(
			Deployment.contract.runtime!({
				id: "invalid",
				provider: "anthropic",
				model: "claude-private",
				protocol: "messages",
				credentialRef: "key",
				limits: { tpm: -1 },
			} as never),
		)
		assert.deepEqual(
			error.issues?.map((issue) => issue.path),
			[["limits", "tpm"]],
		)
	}).pipe(
		Effect.provide(
			Layer.merge(
				ProviderContract.credentialResolverLayer(() =>
					Effect.succeed(Redacted.make("secret")),
				),
				Layer.succeed(
					HttpClient.HttpClient,
					HttpClient.make((request) =>
						Effect.succeed(
							HttpClientResponse.fromWeb(
								request,
								new Response(null, { status: 429 }),
							),
						),
					),
				),
			),
		),
	),
)

it.effect("decodes direct deployments before resolving credentials", () =>
	Effect.gen(function* () {
		const resolved = yield* Ref.make(0)
		const result = yield* Effect.flip(
			Deployment.createForDeployment({
				id: "invalid-credential",
				provider: "anthropic",
				model: "claude-private",
				protocol: "messages",
				credentialRef: "",
			}).pipe(
				Effect.provide(
					Layer.merge(
						ProviderContract.credentialResolverLayer(() =>
							Ref.update(resolved, (count) => count + 1).pipe(
								Effect.as(Redacted.make("secret")),
							),
						),
						Layer.succeed(
							HttpClient.HttpClient,
							HttpClient.make((request) =>
								Effect.succeed(
									HttpClientResponse.fromWeb(
										request,
										new Response(null, { status: 429 }),
									),
								),
							),
						),
					),
				),
			),
		)
		assert.equal(result.kind, "invalid_request")
		const cause = result.cause
		assert.ok(Schema.isSchemaError(cause))
		if (!Schema.isSchemaError(cause)) return
		const issues = SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue).issues
		assert.deepEqual(
			issues.map((issue) => issue.path),
			[["credentialRef"]],
		)
		assert.equal(yield* Ref.get(resolved), 0)
	}),
)
