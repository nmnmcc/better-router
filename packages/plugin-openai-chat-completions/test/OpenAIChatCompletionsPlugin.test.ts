import assert from "node:assert/strict"
import { it as test } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Stream } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/http"
import { make as makeRouter } from "@better-router/core/Router"
import { RouterError } from "@better-router/core/Router"
import { RoutingError } from "@better-router/core/Routing"
import type { Router } from "@better-router/core/Router"
import type { Deployment } from "@better-router/core/Deployment"
import { ProviderError } from "@better-router/core/Deployment"
import type { GenerationEvent } from "@better-router/core/Generation"
import { snapshot } from "@better-router/core/GenerationEvents"
import type { RouterPlugin } from "@better-router/core/Plugin"
import { OpenAIChatCompletionsPlugin } from "@better-router/plugin-openai-chat-completions"

test.effect("Chat Completions ingress runs against a non-OpenAI deployment", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const invokedModels = yield* Ref.make<readonly string[]>([])
			const local: Deployment = {
				id: "local",
				provider: "local",
				protocol: "local.responses",
				model: "local-private",
				execute: {
					http: (request) =>
						Ref.update(invokedModels, (models) => [...models, request.model]).pipe(
							Effect.map(() => {
								const item = {
									type: "message",
									id: "msg_local",
									status: "completed",
									role: "assistant",
									content: [
										{ type: "output_text", text: "Local", annotations: [] },
									],
								} as const
								return Stream.fromIterable([
									{
										type: "response.created",
										sequence_number: 0,
										response: snapshot(
											request,
											"resp_local",
											1234,
											request.model,
											[],
											"in_progress",
											null,
											null,
										),
									},
									{
										type: "response.output_item.added",
										sequence_number: 1,
										output_index: 0,
										item,
									},
									{
										type: "response.output_text.delta",
										sequence_number: 2,
										output_index: 0,
										item_id: "msg_local",
										content_index: 0,
										delta: "Local",
									},
									{
										type: "response.completed",
										sequence_number: 3,
										response: snapshot(
											request,
											"resp_local",
											1234,
											request.model,
											[item],
											"completed",
											null,
											1235,
										),
									},
								] as GenerationEvent[])
							}),
						),
				},
			}
			const localPlugin: RouterPlugin<"local"> = { id: "local", deployments: [local] }
			const routes = Layer.unwrap(
				makeRouter({
					plugins: [
						OpenAIChatCompletionsPlugin.make({ gatewayKey: Redacted.make("client") }),
						localPlugin,
					] as const,
				})({
					routes: [{ model: "chat", deployments: ["local"] }],
				}).pipe(Effect.map((router) => router.http.routes)),
			).pipe(
				Layer.provide(HttpServer.layerServices),
				Layer.provide(
					Layer.succeed(
						HttpClient.HttpClient,
						HttpClient.make(() => Effect.die("Unexpected upstream HTTP")),
					),
				),
			)
			const { handler } = yield* Effect.acquireRelease(
				Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
				({ dispose }) => Effect.promise(() => dispose()),
			)

			const send = (key: string, stream = false) =>
				handler(
					new Request("http://localhost/v1/chat/completions", {
						method: "POST",
						headers: {
							authorization: "Bearer " + key,
							"content-type": "application/json",
						},
						body: JSON.stringify({
							model: "chat",
							messages: [{ role: "user", content: "Hi" }],
							stream,
						}),
					}),
				)

			yield* Effect.promise(async () => {
				assert.equal((await send("wrong")).status, 401)
				assert.deepEqual(Effect.runSync(Ref.get(invokedModels)), [])

				const json = await send("client")
				assert.equal(json.status, 200)
				assert.equal(
					((await json.json()) as { choices: { message: { content: string } }[] })
						.choices[0]?.message.content,
					"Local",
				)

				const streamed = await send("client", true)
				assert.equal(streamed.status, 200)
				const chunks = await streamed.text()
				assert.match(chunks, /"content":"Local"/)
				assert.match(chunks, /data: \[DONE\]/)
				assert.deepEqual(Effect.runSync(Ref.get(invokedModels)), [
					"local-private",
					"local-private",
				])
			})
		}),
	),
)

test.effect(
	"Chat ingress maps conversion, routing and provider failures to its error envelope",
	() =>
		Effect.scoped(
			Effect.gen(function* () {
				const routeError = yield* Ref.make<RouterError>(
					RouterError.cases.NoRoute.make({ model: "missing" }),
				)
				const errorRouter = (): Router =>
					({
						invoke: () => Ref.get(routeError).pipe(Effect.flatMap(Effect.fail)),
					}) as unknown as Router
				const contribution = OpenAIChatCompletionsPlugin.make({
					gatewayKey: Redacted.make("client"),
				})
				const routes = contribution.http.routes(errorRouter()).pipe(
					Layer.provide(HttpServer.layerServices),
					Layer.provide(
						Layer.succeed(
							HttpClient.HttpClient,
							HttpClient.make(() => Effect.die("Unexpected upstream HTTP")),
						),
					),
				)

				yield* Effect.scoped(
					Effect.gen(function* () {
						const upstreamError = ProviderError.make({
							kind: "unknown",
							message: "upstream failed",
							retryable: false,
						})
						const router = {
							invoke: () =>
								Effect.succeed({
									type: "opaque" as const,
									response: {
										status: 207,
										headers: { "content-type": "text/event-stream" },
										body: Stream.concat(
											Stream.succeed(
												new TextEncoder().encode("data: direct\n\n"),
											),
											Stream.fail(upstreamError),
										),
									},
									cancel: Effect.void,
								}),
						} as unknown as Router
						const routes = OpenAIChatCompletionsPlugin.make({
							gatewayKey: Redacted.make("client"),
						})
							.http.routes(router)
							.pipe(Layer.provide(HttpServer.layerServices))
						const { handler } = yield* Effect.acquireRelease(
							Effect.sync(() =>
								HttpRouter.toWebHandler(routes, { disableLogger: true }),
							),
							({ dispose }) => Effect.promise(() => dispose()),
						)
						const response = yield* Effect.promise(() =>
							handler(
								new Request("http://localhost/v1/chat/completions", {
									method: "POST",
									headers: {
										authorization: "Bearer client",
										"content-type": "application/json",
									},
									body: JSON.stringify({
										model: "public",
										messages: [{ role: "user", content: "Hi" }],
										stream: true,
									}),
								}),
							),
						)
						assert.equal(response.status, 207)
						const text = yield* Effect.promise(() => response.text())
						assert.match(text, /data: direct/)
						assert.match(text, /upstream failed/)
						const invalid = yield* Effect.promise(() =>
							handler(
								new Request("http://localhost/v1/chat/completions", {
									method: "POST",
									headers: {
										authorization: "Bearer client",
										"content-type": "application/json",
									},
									body: JSON.stringify({
										model: "public",
										messages: [{ role: "user", content: "Hi" }],
									}),
								}),
							),
						)
						assert.equal(invalid.status, 502)
					}),
				)
				const { handler } = yield* Effect.acquireRelease(
					Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
					({ dispose }) => Effect.promise(() => dispose()),
				)
				const send = (body: unknown, stream = false) =>
					handler(
						new Request("http://localhost/v1/chat/completions", {
							method: "POST",
							headers: {
								authorization: "Bearer client",
								"content-type": "application/json",
							},
							body: JSON.stringify({ ...(body as object), stream }),
						}),
					)
				const noRoute = yield* Effect.promise(() =>
					send({ model: "missing", messages: [{ role: "user", content: "Hi" }] }),
				)
				assert.equal(noRoute.status, 404)
				const invalidStreamOptions = yield* Effect.promise(() =>
					send({
						model: "missing",
						messages: [{ role: "user", content: "Hi" }],
						stream_options: { include_usage: true },
					}),
				)
				assert.equal(invalidStreamOptions.status, 400)
				const unsupported = yield* Effect.promise(() =>
					send({
						model: "missing",
						messages: [{ role: "user", content: [{ type: "input_audio", data: "x" }] }],
					}),
				)
				assert.equal(unsupported.status, 422)
				const errors: readonly (readonly [RouterError, number])[] = [
					[RouterError.cases.InvalidRequest.make({ message: "bad request" }), 400],
					[
						RouterError.cases.UnsupportedCapability.make({
							model: "missing",
							capability: "websocket",
						}),
						422,
					],
					[RouterError.cases.NoAvailableDeployment.make({ model: "missing" }), 503],
					[RouterError.cases.InvalidResponse.make({ message: "bad response" }), 502],
					[
						RouterError.cases.RoutingFailed.make({
							cause: RoutingError.make({ message: "none" }),
						}),
						502,
					],
					[
						RouterError.cases.MiddlewareFailed.make({
							id: "middleware",
							cause: new Error("failed"),
						}),
						502,
					],
					...(
						[
							"rate_limited",
							"timeout",
							"unavailable",
							"invalid_request",
							"unsupported",
							"unknown",
						] as const
					).map(
						(kind) =>
							[
								RouterError.cases.ProviderFailed.make({
									deployment: "upstream",
									cause: ProviderError.make({
										kind,
										message: kind,
										retryable: false,
									}),
								}),
								kind === "rate_limited"
									? 429
									: kind === "timeout"
										? 504
										: kind === "unavailable"
											? 503
											: kind === "invalid_request"
												? 400
												: kind === "unsupported"
													? 422
													: 502,
							] as const,
					),
				]
				yield* Effect.forEach(errors, ([error, status]) =>
					Ref.set(routeError, error).pipe(
						Effect.flatMap(() =>
							Effect.promise(() =>
								send({
									model: "missing",
									messages: [{ role: "user", content: "Hi" }],
								}),
							).pipe(
								Effect.tap((response) =>
									Effect.sync(() => assert.equal(response.status, status)),
								),
							),
						),
					),
				)
			}),
		),
)
