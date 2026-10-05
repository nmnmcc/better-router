import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Result, Schema, SchemaIssue } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Chat from "@better-router/provider-openai/OpenAIChatCompletions"
import * as Responses from "@better-router/provider-openai/OpenAIResponses"
import * as Deployment from "@better-router/provider-openai/Deployment"
import * as ProviderContract from "@better-router/core/ProviderContract"

const config = {
	model: "gpt-private",
	apiKey: Redacted.make("secret"),
} as const

it("publishes a stable generation contract independent of deployment state", () => {
	assert.equal(Deployment.contract.id, "openai")
	assert.deepEqual(Deployment.contract.protocols, ["responses", "chat-completions"])
	assert.deepEqual(Deployment.contract.endpoints, [
		{
			id: "responses",
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
			capabilities: ["provider.openai.responses"],
		},
		{
			id: "chat-completions",
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
			capabilities: ["provider.openai.chat-completions"],
		},
	])
})

it("narrows stable capability and parameter demands to the selected OpenAI endpoint", () => {
	const declaration: Deployment.DeploymentConfig = {
		id: "chat",
		provider: "openai",
		model: "gpt-private",
		protocol: "chat-completions",
		credentialRef: "key",
	}
	assert.deepEqual(ProviderContract.capabilitiesForDeployment(Deployment.contract, declaration), [
		"provider.openai.chat-completions",
	])
	assert.ok(
		Result.isSuccess(
			ProviderContract.validateDeployment(Deployment.contract, {
				...declaration,
				parameters: ["input", "temperature"],
				capabilities: ["provider.openai.chat-completions"],
			}),
		),
	)
	assert.ok(
		Result.isFailure(
			ProviderContract.validateDeployment(Deployment.contract, {
				...declaration,
				capabilities: ["provider.openai.responses"],
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
		Deployment.chatCompletionsCapability.endpoints?.map(
			(endpoint: ProviderContract.Endpoint) => endpoint.id,
		),
		["chat-completions"],
	)
})

it("encodes OpenAI Responses credentials and deployment model", () => {
	const encoded = Responses.encodeRequest(config, { model: "public", input: "hello" })
	assert.equal(Result.isSuccess(encoded), true)
	if (Result.isFailure(encoded)) return
	assert.equal(encoded.success.url, "https://api.openai.com/v1/responses")
	assert.equal(encoded.success.headers.authorization, "Bearer secret")
	assert.equal(encoded.success.body.model, "gpt-private")
})

it("encodes Chat Completions credentials and deployment model", () => {
	const encoded = Chat.encodeRequest(config, { model: "public", input: "hello" })
	assert.equal(Result.isSuccess(encoded), true)
	if (Result.isFailure(encoded)) return
	assert.equal(encoded.success.url, "https://api.openai.com/v1/chat/completions")
	assert.equal(encoded.success.headers.authorization, "Bearer secret")
	assert.equal(encoded.success.body.model, "gpt-private")
})

it("classifies retryable and permanent upstream statuses", () => {
	const limited = Responses.classifyStatus(429)
	assert.equal(limited.kind, "rate_limited")
	assert.equal(limited.retryable, true)
	const unauthorized = Chat.classifyStatus(401)
	assert.equal(unauthorized.kind, "unauthorized")
	assert.equal(unauthorized.retryable, false)
})

const deploymentUrlCases = (protocol: Deployment.DeploymentConfig["protocol"]) => {
	const endpoint = protocol === "responses" ? "responses" : "chat/completions"
	return [
		[undefined, `https://api.openai.com/v1/${endpoint}`],
		["https://upstream.example", `https://upstream.example/v1/${endpoint}`],
		["https://upstream.example/", `https://upstream.example/v1/${endpoint}`],
		["https://upstream.example/v1", `https://upstream.example/v1/${endpoint}`],
		["https://upstream.example/v1/", `https://upstream.example/v1/${endpoint}`],
		["https://upstream.example/v1///", `https://upstream.example/v1/${endpoint}`],
		[
			"https://upstream.example/proxy/team/",
			`https://upstream.example/proxy/team/v1/${endpoint}`,
		],
		[
			"https://upstream.example/proxy/v1/?region=hk&route=a%2Fb#request",
			`https://upstream.example/proxy/v1/${endpoint}?region=hk&route=a%2Fb#request`,
		],
		[
			`https://upstream.example/proxy/v1/${endpoint}?region=hk`,
			`https://upstream.example/proxy/v1/${endpoint}?region=hk`,
		],
		[
			`https://upstream.example/custom/${endpoint}/?region=hk`,
			`https://upstream.example/custom/${endpoint}/?region=hk`,
		],
		[
			`https://upstream.example/custom/${protocol === "responses" ? "chat/completions" : "responses"}?region=hk`,
			`https://upstream.example/custom/${protocol === "responses" ? "chat/completions" : "responses"}?region=hk`,
		],
	] as const
}

it.effect(
	"derives endpoint URLs without duplicating versions or losing custom paths and queries",
	() =>
		Effect.forEach(["responses", "chat-completions"] as const, (protocol) =>
			Effect.forEach(deploymentUrlCases(protocol), ([baseUrl, expectedUrl]) => {
				const declaration: Deployment.DeploymentConfig = {
					id: "custom",
					provider: "openai",
					model: "gpt-private",
					protocol,
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
			}),
		).pipe(Effect.asVoid),
)

it("preflights OpenAI credentials and HTTP(S) base URLs with field paths", () => {
	const missingCredential = Deployment.contract.validateEnvironment?.({
		id: "missing",
		provider: "openai",
		model: "gpt-private",
		protocol: "responses",
	})
	assert.ok(missingCredential && Result.isFailure(missingCredential))
	if (missingCredential && Result.isFailure(missingCredential))
		assert.deepEqual(
			missingCredential.failure.issues?.map((issue) => issue.path),
			[["credentialRef"]],
		)

	const invalidScheme = Deployment.contract.validateEnvironment?.({
		id: "ftp",
		provider: "openai",
		model: "gpt-private",
		protocol: "responses",
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
		provider: "openai",
		model: "gpt-private",
		protocol: "responses",
		credentialRef: "key",
		baseUrl: "/v1/responses",
	})
	assert.ok(relativeUrl && Result.isFailure(relativeUrl))
	if (relativeUrl && Result.isFailure(relativeUrl))
		assert.deepEqual(
			relativeUrl.failure.issues?.map((issue) => issue.path),
			[["baseUrl"]],
		)

	const invalidLimit = Deployment.contract.validateEnvironment?.({
		id: "limit",
		provider: "openai",
		model: "gpt-private",
		protocol: "responses",
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
				provider: "openai",
				model: "gpt-private",
				protocol: "responses",
				credentialRef: "key",
				baseUrl: "https://upstream.example/v1",
			}),
		),
	)
})

it.effect("builds independent runtime services from deployment declarations", () =>
	Effect.gen(function* () {
		const first = yield* Deployment.contract.runtime!({
			id: "first",
			provider: "openai",
			model: "gpt-first",
			protocol: "responses",
			credentialRef: "first-key",
		})
		const second = yield* Deployment.contract.runtime!({
			id: "second",
			provider: "openai",
			model: "gpt-second",
			protocol: "responses",
			credentialRef: "second-key",
		})
		const firstError = yield* Effect.flip(first.generate({ model: "public", input: "first" }))
		const secondError = yield* Effect.flip(
			second.generate({ model: "public", input: "second" }),
		)
		assert.equal(firstError.kind, "rate_limited")
		assert.equal(secondError.kind, "rate_limited")
	}).pipe(
		Effect.provide(
			Layer.merge(
				ProviderContract.credentialResolverLayer((reference) =>
					Effect.succeed(Redacted.make(`secret-${reference}`)),
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

it.effect("preserves nested runtime deployment Schema issue paths", () =>
	Effect.gen(function* () {
		const error = yield* Effect.flip(
			Deployment.contract.runtime!({
				id: "invalid",
				provider: "openai",
				model: "gpt-private",
				protocol: "responses",
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
				provider: "openai",
				model: "gpt-private",
				protocol: "responses",
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
