import assert from "node:assert/strict"
import { it as test } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref, Stream } from "effect"
import { HttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { make as makeRouter } from "@better-router/core/Router"
import { RouterError } from "@better-router/core/Router"
import { RoutingError } from "@better-router/core/Routing"
import type { Router } from "@better-router/core/Router"
import { ProviderError } from "@better-router/core/Deployment"
import type { GenerationEvent } from "@better-router/core/Generation"
import { snapshot } from "@better-router/core/GenerationEvents"
import { OpenAIResponsesPlugin } from "@better-router/plugin-openai-responses"

test.effect("Responses ingress serves JSON and SSE through a configured deployment", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const invoked = yield* Ref.make<readonly string[]>([])
			const deployment = {
				id: "local",
				provider: "local",
				protocol: "local.responses",
				model: "private",
				execute: {
					http: (request: { model: string }) =>
						Ref.update(invoked, (models) => [...models, request.model]).pipe(
							Effect.map(() => {
								const item = {
									type: "message",
									id: "msg_1",
									status: "completed",
									role: "assistant",
									content: [
										{ type: "output_text", text: "Hello", annotations: [] },
									],
								} as const
								return Stream.fromIterable([
									{
										type: "response.created",
										sequence_number: 0,
										response: snapshot(
											request,
											"resp_1",
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
										item_id: "msg_1",
										output_index: 0,
										content_index: 0,
										delta: "Hello",
									},
									{
										type: "response.completed",
										sequence_number: 3,
										response: snapshot(
											request,
											"resp_1",
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
			const routes = Layer.unwrap(
				makeRouter({
					plugins: [
						OpenAIResponsesPlugin.make({
							gatewayKey: Redacted.make("client"),
							deployments: [],
						}),
						{ id: "local", deployments: [deployment] },
					],
				})({
					routes: [{ model: "public", deployments: ["local"] }],
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
					new Request("http://localhost/v1/responses", {
						method: "POST",
						headers: {
							authorization: `Bearer ${key}`,
							"content-type": "application/json",
						},
						body: JSON.stringify({ model: "public", input: "Hi", stream }),
					}),
				)
			yield* Effect.promise(async () => {
				assert.equal((await send("wrong")).status, 401)
				assert.deepEqual(Effect.runSync(Ref.get(invoked)), [])
				const json = await send("client")
				assert.equal(json.status, 200)
				const result = (await json.json()) as {
					model: string
					output: { content: { text: string }[] }[]
				}
				assert.equal(result.model, "public")
				assert.equal(result.output[0].content[0].text, "Hello")
				const streamed = await send("client", true)
				assert.equal(streamed.status, 200)
				const frames = await streamed.text()
				assert.match(frames, /event: response.output_text.delta/)
				assert.match(frames, /"model":"public"/)
				assert.match(frames, /data: \[DONE\]/)
				assert.deepEqual(Effect.runSync(Ref.get(invoked)), ["private", "private"])
			})
		}),
	),
)

test.effect("invalid upstream resources return 502 rather than a client parse error", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const local = {
				id: "broken",
				provider: "local",
				protocol: "local.responses",
				model: "private",
				execute: {
					http: () =>
						Effect.succeed(
							Stream.succeed({
								type: "response.completed",
								sequence_number: 0,
								response: { id: "incomplete" },
							} as GenerationEvent),
						),
				},
			}
			const routes = Layer.unwrap(
				makeRouter({
					plugins: [
						OpenAIResponsesPlugin.make({ gatewayKey: Redacted.make("client") }),
						{ id: "local", deployments: [local] },
					],
				})({
					routes: [{ model: "public", deployments: ["broken"] }],
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
			const response = yield* Effect.promise(() =>
				handler(
					new Request("http://localhost/v1/responses", {
						method: "POST",
						headers: {
							authorization: "Bearer client",
							"content-type": "application/json",
						},
						body: JSON.stringify({ model: "public", input: "Hi" }),
					}),
				),
			)
			assert.equal(response.status, 502)
		}),
	),
)

test.effect("Responses ingress maps router, provider, and conversion failures", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fakeRouter = (error: RouterError): Router =>
				({ invoke: () => Effect.fail(error) }) as unknown as Router
			const contribution = OpenAIResponsesPlugin.make({ gatewayKey: Redacted.make("client") })
			const routes = contribution.http
				.routes(fakeRouter(RouterError.cases.NoRoute.make({ model: "missing" })))
				.pipe(
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
			const send = (body: unknown) =>
				handler(
					new Request("http://localhost/v1/responses", {
						method: "POST",
						headers: {
							authorization: "Bearer client",
							"content-type": "application/json",
						},
						body: JSON.stringify(body),
					}),
				)
			const noRoute = yield* Effect.promise(() => send({ model: "missing", input: "Hi" }))
			assert.equal(noRoute.status, 404)
			const unsupported = yield* Effect.promise(() =>
				send({ model: "missing", input: [{ type: "reasoning", summary: [] }] }),
			)
			assert.equal(unsupported.status, 422)
			const providerRoutes = contribution.http
				.routes(
					fakeRouter(
						RouterError.cases.ProviderFailed.make({
							deployment: "upstream",
							cause: ProviderError.make({
								kind: "timeout",
								message: "timed out",
								retryable: false,
							}),
						}),
					),
				)
				.pipe(
					Layer.provide(HttpServer.layerServices),
					Layer.provide(
						Layer.succeed(
							HttpClient.HttpClient,
							HttpClient.make(() => Effect.die("Unexpected upstream HTTP")),
						),
					),
				)
			const { handler: providerHandler } = yield* Effect.acquireRelease(
				Effect.sync(() => HttpRouter.toWebHandler(providerRoutes, { disableLogger: true })),
				({ dispose }) => Effect.promise(() => dispose()),
			)
			const provider = yield* Effect.promise(() =>
				providerHandler(
					new Request("http://localhost/v1/responses", {
						method: "POST",
						headers: {
							authorization: "Bearer client",
							"content-type": "application/json",
						},
						body: JSON.stringify({ model: "missing", input: "Hi" }),
					}),
				),
			)
			assert.equal(provider.status, 504)
		}),
	),
)

test.effect("Responses ingress maps every RouterError variant", () =>
	Effect.scoped(
		Effect.gen(function* () {
			const routeError = yield* Ref.make<RouterError>(
				RouterError.cases.NoRoute.make({ model: "missing" }),
			)
			const router = {
				invoke: () => Ref.get(routeError).pipe(Effect.flatMap(Effect.fail)),
			} as unknown as Router
			const routes = OpenAIResponsesPlugin.make({ gatewayKey: Redacted.make("client") })
				.http.routes(router)
				.pipe(
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
			const send = () =>
				handler(
					new Request("http://localhost/v1/responses", {
						method: "POST",
						headers: {
							authorization: "Bearer client",
							"content-type": "application/json",
						},
						body: JSON.stringify({ model: "missing", input: "Hi" }),
					}),
				)
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
						"unauthorized",
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
						Effect.promise(() => send()).pipe(
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

test.effect(
	"Responses native direct execution preserves opaque streams and reports stream errors",
	() =>
		Effect.scoped(
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
									Stream.succeed(new TextEncoder().encode("data: direct\n\n")),
									Stream.fail(upstreamError),
								),
							},
							cancel: Effect.void,
						}),
				} as unknown as Router
				const routes = OpenAIResponsesPlugin.make({ gatewayKey: Redacted.make("client") })
					.http.routes(router)
					.pipe(Layer.provide(HttpServer.layerServices))
				const { handler } = yield* Effect.acquireRelease(
					Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
					({ dispose }) => Effect.promise(() => dispose()),
				)
				const response = yield* Effect.promise(() =>
					handler(
						new Request("http://localhost/v1/responses", {
							method: "POST",
							headers: {
								authorization: "Bearer client",
								"content-type": "application/json",
							},
							body: JSON.stringify({ model: "public", input: "Hi", stream: true }),
						}),
					),
				)
				assert.equal(response.status, 207)
				const text = yield* Effect.promise(() => response.text())
				assert.match(text, /data: direct/)
				assert.match(text, /upstream failed/)
				const invalid = yield* Effect.promise(() =>
					handler(
						new Request("http://localhost/v1/responses", {
							method: "POST",
							headers: {
								authorization: "Bearer client",
								"content-type": "application/json",
							},
							body: JSON.stringify({ model: "public", input: "Hi" }),
						}),
					),
				)
				assert.equal(invalid.status, 502)
			}),
		),
)
