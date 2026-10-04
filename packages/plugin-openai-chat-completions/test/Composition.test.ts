import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Router from "@better-router/core/Router"
import { credentialResolverLayer } from "@better-router/core/ProviderContract"
import { plugin } from "@better-router/plugin-openai-chat-completions"

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
						routes: [{ model: "public", deployments: ["chat-primary"] }],
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
