import { Context, Effect, Layer, Schema, SchemaGetter } from "effect"
import { HttpApi as EffectHttpApi } from "effect/http-api"
import { describe, expect, it } from "tstyche"
import * as Api from "@better-router/core/Api"
import * as HttpApi from "@better-router/core/HttpApi"
import type {
	HttpContractContribution,
	HttpEndpointContribution,
	HttpMiddleware,
} from "@better-router/core/PluginContributions"
import * as Route from "@better-router/core/Route"

class HandlerDependency extends Context.Service<HandlerDependency, { readonly name: string }>()(
	"BetterRouterHttpTypeHandler",
) {}

class MiddlewareDependency extends Context.Service<
	MiddlewareDependency,
	{ readonly token: string }
>()("BetterRouterHttpTypeMiddleware") {}

class DecodeDependency extends Context.Service<DecodeDependency, { readonly name: string }>()(
	"BetterRouterHttpTypeDecode",
) {}

class EncodeDependency extends Context.Service<EncodeDependency, { readonly name: string }>()(
	"BetterRouterHttpTypeEncode",
) {}

class UnusedSchemaDependency extends Context.Service<
	UnusedSchemaDependency,
	{ readonly name: string }
>()("BetterRouterHttpTypeUnusedSchema") {}

class ContractDependency extends Context.Service<ContractDependency, { readonly name: string }>()(
	"BetterRouterHttpTypeContract",
) {}

const valueSchema = Schema.Struct({ value: Schema.String })
const route: Route.Service = {
	generate: () => Effect.fail(Route.UnknownModel.make({ model: "unused" })),
}

const independent = {
	id: "independent-http",
	method: "POST",
	path: "/independent",
	input: valueSchema,
	output: valueSchema,
	handler: (input: typeof valueSchema.Type) => Effect.succeed(input),
} as const satisfies HttpEndpointContribution<never, typeof valueSchema, typeof valueSchema>

const handlerDependent = {
	...independent,
	id: "handler-dependent-http",
	path: "/handler",
	handler: () => Effect.map(HandlerDependency, ({ name }) => ({ value: name })),
} as const satisfies HttpEndpointContribution<
	HandlerDependency,
	typeof valueSchema,
	typeof valueSchema
>

const middleware: HttpMiddleware<MiddlewareDependency> = {
	id: "dependent-middleware",
	wrap: (next) => (input, context) =>
		Effect.asVoid(MiddlewareDependency).pipe(Effect.andThen(next(input, context))),
}

const middlewareDependent = {
	...independent,
	id: "middleware-dependent-http",
	path: "/middleware",
	middleware: [middleware] as const,
} as const satisfies HttpEndpointContribution<
	MiddlewareDependency,
	typeof valueSchema,
	typeof valueSchema
>

const inputSchema = Schema.Struct({
	value: Schema.String.pipe(
		Schema.decodeTo(Schema.String, {
			decode: SchemaGetter.transformEffect((value: string) =>
				Effect.as(DecodeDependency, value),
			),
			encode: SchemaGetter.transformEffect((value: string) =>
				Effect.as(UnusedSchemaDependency, value),
			),
		}),
	),
})

const outputSchema = Schema.Struct({
	value: Schema.String.pipe(
		Schema.decodeTo(Schema.String, {
			decode: SchemaGetter.transformEffect((value: string) =>
				Effect.as(UnusedSchemaDependency, value),
			),
			encode: SchemaGetter.transformEffect((value: string) =>
				Effect.as(EncodeDependency, value),
			),
		}),
	),
})

const schemaDependent = {
	...independent,
	id: "schema-dependent-http",
	path: "/schema",
	input: inputSchema,
	output: outputSchema,
} as const satisfies HttpEndpointContribution<never, typeof inputSchema, typeof outputSchema>

const api = EffectHttpApi.make("contract-requirements")
const contractDependent = {
	id: "contract-dependent-http",
	api,
	contract: Api.make({
		api,
		layer: () => Layer.effectDiscard(Effect.asVoid(ContractDependency)),
	}),
} as const satisfies HttpContractContribution<typeof api, ContractDependency>

describe("HTTP contribution requirements", () => {
	it("keeps a service-free direct contribution and the empty registry service-free", () => {
		const contributions = [independent] as const
		const layer = HttpApi.layer(contributions, route)
		const emptyLayer = HttpApi.layer([] as const, route)

		expect<HttpApi.Requirements<typeof contributions>>().type.toBe<never>()
		expect<HttpApi.Requirements<readonly []>>().type.toBe<never>()
		expect<Layer.Services<typeof layer>>().type.toBe<HttpApi.HttpHostServices>()
		expect<Layer.Services<typeof emptyLayer>>().type.toBe<HttpApi.HttpHostServices>()
	})

	it("requires each direct handler's external services", () => {
		const contributions = [handlerDependent] as const
		const layer = HttpApi.layer(contributions, route)

		expect<HttpApi.Requirements<typeof contributions>>().type.toBe<HandlerDependency>()
		expect<Layer.Services<typeof layer>>().type.toBe<
			HttpApi.HttpHostServices | HandlerDependency
		>()
		expect(layer).type.not.toBeAssignableTo<
			Layer.Layer<never, unknown, HttpApi.HttpHostServices>
		>()
	})

	it("requires middleware services even when the handler has none", () => {
		const contributions = [middlewareDependent] as const
		const layer = HttpApi.layer(contributions, route)

		expect<HttpApi.Requirements<typeof contributions>>().type.toBe<MiddlewareDependency>()
		expect<Layer.Services<typeof layer>>().type.toBe<
			HttpApi.HttpHostServices | MiddlewareDependency
		>()
		expect(layer).type.not.toBeAssignableTo<
			Layer.Layer<never, unknown, HttpApi.HttpHostServices>
		>()
	})

	it("requires input decoding and output encoding services at the HTTP boundary", () => {
		const contributions = [schemaDependent] as const
		const layer = HttpApi.layer(contributions, route)

		expect<typeof inputSchema.DecodingServices>().type.toBe<DecodeDependency>()
		expect<typeof outputSchema.EncodingServices>().type.toBe<EncodeDependency>()
		expect<HttpApi.Requirements<typeof contributions>>().type.toBe<
			DecodeDependency | EncodeDependency
		>()
		expect<Layer.Services<typeof layer>>().type.toBe<
			HttpApi.HttpHostServices | DecodeDependency | EncodeDependency
		>()
		expect(layer).type.not.toBeAssignableTo<
			Layer.Layer<never, unknown, HttpApi.HttpHostServices>
		>()
	})

	it("preserves a protocol contract's Layer requirements", () => {
		const contributions = [contractDependent] as const
		const layer = HttpApi.layer(contributions, route)

		expect<HttpApi.Requirements<typeof contributions>>().type.toBe<ContractDependency>()
		expect<Layer.Services<typeof layer>>().type.toBe<
			HttpApi.HttpHostServices | ContractDependency
		>()
		expect(layer).type.not.toBeAssignableTo<
			Layer.Layer<never, unknown, HttpApi.HttpHostServices>
		>()
	})

	it("combines distinct direct and protocol dependencies without widening them", () => {
		const contributions = [
			independent,
			handlerDependent,
			middlewareDependent,
			schemaDependent,
			contractDependent,
		] as const
		const layer = HttpApi.layer(contributions, route)

		expect<HttpApi.Requirements<typeof contributions>>().type.toBe<
			| HandlerDependency
			| MiddlewareDependency
			| DecodeDependency
			| EncodeDependency
			| ContractDependency
		>()
		expect<Layer.Services<typeof layer>>().type.toBe<
			| HttpApi.HttpHostServices
			| HandlerDependency
			| MiddlewareDependency
			| DecodeDependency
			| EncodeDependency
			| ContractDependency
		>()
	})
})
