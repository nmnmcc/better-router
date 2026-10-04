import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import * as Router from "@better-router/core/Router"
import { credentialResolverLayer } from "@better-router/core/ProviderContract"
import { plugin } from "@better-router/plugin-anthropic-messages"

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
				assert.equal(outgoing.headers["anthropic-version"], "2023-06-01")
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
								version: "2023-06-01",
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
