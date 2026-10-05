import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Failure, filterForwardHeaders, layer as httpLayer } from "@better-router/core/HttpApi"
import type { Requirements as HttpRequirements } from "@better-router/core/HttpApi"
import type {
	HttpEndpointContribution,
	HttpMiddleware,
} from "@better-router/core/PluginContributions"
import { Error as ProviderError } from "@better-router/core/Provider"
import { InvalidRequest, UnknownModel } from "@better-router/core/Route"
import type { Service as RouteService } from "@better-router/core/Route"
import { AccessDenied } from "@better-router/core/Routing"
import { Error as RuntimeError } from "@better-router/core/RoutingRuntime"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"

class FixtureService extends Context.Service<FixtureService, { readonly marker: string }>()(
	"BetterRouterHttpApiFixture",
) {}

const route: RouteService = {
	generate: () => Effect.die(new Error("direct HTTP tests do not invoke the generation route")),
}

const Input = Schema.Struct({
	request: Schema.Struct({ value: Schema.String }),
})

const Output = Schema.Struct({
	accepted: Schema.Boolean,
})

const ErrorBody = Schema.Struct({
	error: Schema.Struct({
		message: Schema.String,
		type: Schema.String,
		param: Schema.optional(Schema.String),
		issues: Schema.optional(
			Schema.Array(
				Schema.Struct({
					path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
					message: Schema.String,
				}),
			),
		),
	}),
})

const request = (path: string, body: unknown, headers: Readonly<Record<string, string>> = {}) =>
	new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	})

const serve = <const Contribution extends HttpEndpointContribution<any, any, any>>(
	contribution: Contribution,
	incoming: Request,
	services: Layer.Layer<HttpRequirements<readonly [Contribution]>, never, never>,
) =>
	Effect.gen(function* () {
		const app = httpLayer([contribution] as const, route).pipe(
			Layer.provide(HttpServer.layerServices),
			Layer.provide(services),
		)
		const handler = yield* HttpRouter.toHttpEffect(app)
		const response = yield* Effect.provideService(
			handler,
			HttpServerRequest.HttpServerRequest,
			HttpServerRequest.fromWeb(incoming),
		)
		return HttpServerResponse.toWeb(response)
	})

const noServices = Layer.empty

const readError = (response: Response) =>
	Effect.promise(() => response.json()).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(ErrorBody)),
	)

const readOutput = (response: Response) =>
	Effect.promise(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Output)))

it("filters gateway credentials, transport headers, and Connection tokens", () => {
	assert.deepEqual(
		filterForwardHeaders({
			authorization: "Bearer gateway",
			"x-api-key": "gateway-key",
			host: "gateway",
			"content-length": "10",
			"proxy-connection": "keep-alive",
			connection: "X-Trace, custom-hop",
			"x-trace": "secret-hop",
			"custom-hop": "secret-hop",
			"keep-alive": "timeout=5",
			"transfer-encoding": "chunked",
			"x-request-id": "request-1",
		}),
		{ "x-request-id": "request-1" },
	)
})

it.effect("preserves nested input issue paths and does not invoke the handler", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const contribution: HttpEndpointContribution<never, typeof Input, typeof Output> = {
			id: "nested-input",
			method: "POST",
			path: "/nested-input",
			input: Input,
			output: Output,
			handler: () =>
				Ref.update(calls, (value) => value + 1).pipe(
					Effect.andThen(Effect.succeed({ accepted: true })),
				),
		}
		const response = yield* serve(
			contribution,
			request("/nested-input", { request: { value: 42 } }),
			noServices,
		)
		assert.equal(response.status, 400)
		const body = yield* readError(response)
		assert.equal(body.error.message, "Invalid request")
		assert.equal(body.error.type, "invalid_request_error")
		assert.equal(body.error.param, "request.value")
		assert.deepEqual(
			body.error.issues?.map(({ path }) => path),
			[["request", "value"]],
		)
		assert.ok(body.error.issues?.[0]?.message.length)
		assert.equal(yield* Ref.get(calls), 0)
	}),
)

it.effect("rejects malformed UTF-8 JSON before invoking the handler", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const contribution: HttpEndpointContribution<never, typeof Input, typeof Output> = {
			id: "malformed-utf8",
			method: "POST",
			path: "/malformed-utf8",
			input: Input,
			output: Output,
			handler: () =>
				Ref.update(calls, (value) => value + 1).pipe(
					Effect.andThen(Effect.succeed({ accepted: true })),
				),
		}
		const body = new Uint8Array([
			...new TextEncoder().encode('{"request":{"value":"'),
			0xff,
			...new TextEncoder().encode('"}}'),
		])
		const incoming = new Request("http://localhost/malformed-utf8", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		})
		const response = yield* serve(contribution, incoming, noServices)
		assert.equal(response.status, 400)
		assert.deepEqual(yield* readError(response), {
			error: {
				message: "Invalid JSON body",
				type: "invalid_request_error",
			},
		})
		assert.equal(yield* Ref.get(calls), 0)
	}),
)

it.effect("preserves nested output issue paths during encoding", () =>
	Effect.gen(function* () {
		const output = Schema.Struct({
			result: Schema.Struct({ value: Schema.String }),
		})
		const contribution: HttpEndpointContribution<never, typeof Input, typeof output> = {
			id: "nested-output",
			method: "POST",
			path: "/nested-output",
			input: Input,
			output,
			handler: () =>
				Effect.succeed({ result: { value: 42 } } as unknown as typeof output.Type),
		}
		const response = yield* serve(
			contribution,
			request("/nested-output", { request: { value: "ok" } }),
			noServices,
		)
		assert.equal(response.status, 500)
		const body = yield* readError(response)
		assert.equal(body.error.message, "Invalid response")
		assert.equal(body.error.type, "invalid_response_error")
		assert.equal(body.error.param, "result.value")
		assert.deepEqual(
			body.error.issues?.map(({ path }) => path),
			[["result", "value"]],
		)
		assert.ok(body.error.issues?.[0]?.message.length)
	}),
)

it.effect("runs middleware in declaration order around the handler", () =>
	Effect.gen(function* () {
		const seen = yield* Ref.make<readonly string[]>([])
		const record = (value: string) => Ref.update(seen, (items) => [...items, value])
		const middleware = (id: string): HttpMiddleware => ({
			id,
			wrap: (next) => (input, context) =>
				record(`${id}:before`).pipe(
					Effect.andThen(next(input, context)),
					Effect.tap(() => record(`${id}:after`)),
				),
		})
		const contribution: HttpEndpointContribution<never, typeof Input, typeof Output> = {
			id: "middleware-order",
			method: "POST",
			path: "/middleware-order",
			input: Input,
			output: Output,
			middleware: [middleware("outer"), middleware("inner")],
			handler: (_input, context) =>
				record(`handler:${context.method}:${context.path}`).pipe(
					Effect.andThen(Effect.succeed({ accepted: true })),
				),
		}
		const response = yield* serve(
			contribution,
			request("/middleware-order", { request: { value: "ok" } }),
			noServices,
		)
		assert.equal(response.status, 200)
		assert.deepEqual(yield* readOutput(response), { accepted: true })
		assert.deepEqual(yield* Ref.get(seen), [
			"outer:before",
			"inner:before",
			"handler:POST:/middleware-order",
			"inner:after",
			"outer:after",
		])
	}),
)

it.effect("maps typed authentication failures before the endpoint handler", () =>
	Effect.gen(function* () {
		const calls = yield* Ref.make(0)
		const contribution: HttpEndpointContribution<never, typeof Input, typeof Output> = {
			id: "auth",
			method: "POST",
			path: "/auth",
			input: Input,
			output: Output,
			middleware: [
				{
					id: "auth",
					wrap: () => () =>
						Effect.fail(
							Failure.make({
								status: 401,
								message: "Authentication failed",
								type: "authentication_error",
							}),
						),
				},
			],
			handler: () =>
				Ref.update(calls, (value) => value + 1).pipe(
					Effect.andThen(Effect.succeed({ accepted: true })),
				),
		}
		const response = yield* serve(
			contribution,
			request("/auth", { request: { value: "ok" } }),
			noServices,
		)
		assert.equal(response.status, 401)
		assert.deepEqual(yield* readError(response), {
			error: {
				message: "Authentication failed",
				type: "authentication_error",
			},
		})
		assert.equal(yield* Ref.get(calls), 0)
	}),
)

it.effect("captures handler services and sanitizes unknown failures", () =>
	Effect.gen(function* () {
		const success: HttpEndpointContribution<FixtureService, typeof Input, typeof Output> = {
			id: "service",
			method: "POST",
			path: "/service",
			input: Input,
			output: Output,
			handler: () =>
				Effect.gen(function* () {
					const fixture = yield* FixtureService
					return { accepted: fixture.marker === "provided" }
				}),
		}
		const response = yield* serve(
			success,
			request("/service", { request: { value: "ok" } }),
			Layer.succeed(FixtureService, { marker: "provided" }),
		)
		assert.equal(response.status, 200)
		assert.deepEqual(yield* readOutput(response), { accepted: true })

		const failing: HttpEndpointContribution<never, typeof Input, typeof Output> = {
			id: "unknown-failure",
			method: "POST",
			path: "/unknown-failure",
			input: Input,
			output: Output,
			handler: () => Effect.fail(new Error("secret implementation detail")),
		}
		const failedResponse = yield* serve(
			failing,
			request("/unknown-failure", { request: { value: "ok" } }),
			noServices,
		)
		assert.equal(failedResponse.status, 500)
		const failedBody = yield* readError(failedResponse)
		assert.deepEqual(failedBody, {
			error: { message: "HTTP handler failed", type: "internal_error" },
		})
		assert.equal(JSON.stringify(failedBody).includes("secret implementation detail"), false)
	}),
)

it.effect("sanitizes handler defects without exposing their causes", () =>
	Effect.gen(function* () {
		const contribution: HttpEndpointContribution<never, typeof Input, typeof Output> = {
			id: "defect",
			method: "POST",
			path: "/defect",
			input: Input,
			output: Output,
			handler: () => Effect.die(new Error("private defect with secret credentials")),
		}
		const response = yield* serve(
			contribution,
			request("/defect", { request: { value: "ok" } }),
			noServices,
		)
		assert.equal(response.status, 500)
		assert.deepEqual(yield* readError(response), {
			error: { message: "HTTP handler failed", type: "internal_error" },
		})
	}),
)

it.effect("maps provider, routing, route, and runtime failures to public HTTP statuses", () =>
	Effect.forEach(
		[
			{
				id: "rate-limit",
				failure: ProviderError.make({
					kind: "rate_limited",
					message: "Provider request limit reached",
					retryable: true,
					cause: new Error("private provider details"),
				}),
				status: 429,
				message: "Provider request limit reached",
			},
			{
				id: "access-denied",
				failure: AccessDenied.make({
					model: "private",
					message: "private tenant denial details",
				}),
				status: 403,
				message: "Access to model denied",
			},
			{
				id: "unknown-model",
				failure: UnknownModel.make({ model: "missing" }),
				status: 404,
				message: "Unknown model: missing",
			},
			{
				id: "invalid-request",
				failure: InvalidRequest.make({
					message: "private invalid request details",
					issues: [{ path: ["request", "model"], message: "Expected a string" }],
				}),
				status: 400,
				message: "Invalid generation request",
				param: "request.model",
			},
			{
				id: "budget",
				failure: RuntimeError.make({
					kind: "budget",
					message: "private ledger state",
					retryable: false,
					cause: new Error("private database details"),
				}),
				status: 429,
				message: "Request budget exceeded",
			},
		] as const,
		(test) =>
			Effect.gen(function* () {
				const contribution: HttpEndpointContribution<never, typeof Input, typeof Output> = {
					id: test.id,
					method: "POST",
					path: `/${test.id}`,
					input: Input,
					output: Output,
					handler: () => Effect.fail(test.failure),
				}
				const response = yield* serve(
					contribution,
					request(`/${test.id}`, { request: { value: "ok" } }),
					noServices,
				)
				assert.equal(response.status, test.status)
				const body = yield* readError(response)
				assert.equal(body.error.message, test.message)
				assert.equal(body.error.param, "param" in test ? test.param : undefined)
				assert.equal(JSON.stringify(body).includes("private"), false)
			}),
	).pipe(Effect.asVoid),
)
