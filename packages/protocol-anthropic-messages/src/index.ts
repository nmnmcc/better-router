import { Layer, Result, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { Capability, Plugin as RouterPlugin } from "@better-router/core"
import type { HttpContractContribution, Projection } from "@better-router/core/PluginContributions"
import { Route } from "@better-router/core/Route"
import type { Contract } from "@better-router/core/Api"
import { Response as GenerationResponseSchema } from "@better-router/core/GenerationSchema"
import { fromSchema } from "@better-router/core/Convert"
import * as ApiModule from "./Api.js"
import * as ConvertModule from "./Convert.js"
import * as HttpModule from "./Http.js"

export * as Api from "./Api.js"
export * as Convert from "./Convert.js"
export * as Http from "./Http.js"

/** The schema-backed HTTP API exposed by this protocol package. */
export const api = ApiModule.api

export const makeContract = (
	options: HttpModule.Options = {},
): Contract<typeof ApiModule.api, never> => ({
	api: ApiModule.api,
	layer: (route) =>
		HttpModule.layer(options).pipe(HttpRouter.provideRequest(Layer.succeed(Route, route))),
})

export const makeHttpContribution = (
	options: HttpModule.Options = {},
): HttpContractContribution<typeof ApiModule.api, never> => {
	const contract = makeContract(options)
	return { id: "anthropic-messages", api: contract.api, contract }
}

export const contract = makeContract()

/** Explicit contribution factory used by plugin composition and hosts. */
export const createHttpContract = makeContract

/** Stable ingress capability; credentials are supplied to runtime handlers. */
export const capability: Capability.Capability<
	"protocol.anthropic.messages",
	"protocol",
	"generation"
> = Capability.make({
	id: "protocol.anthropic.messages",
	version: 1,
	kind: "protocol",
	projections: ["generation"],
	endpoints: [{ id: "generation", parameters: ["input", "stream"], streaming: true }],
} as const)

/** Protocol projection metadata used by routing preflight. */
export const projection: Projection<
	"anthropic.messages",
	"anthropic.messages",
	"protocol.anthropic.messages"
> = {
	id: "anthropic.messages",
	protocol: "anthropic.messages",
	capability: capability.id,
	decode: ConvertModule.decodeRequest,
	encode: (value) =>
		Schema.decodeUnknownResult(GenerationResponseSchema)(value).pipe(
			Result.mapError((error) => fromSchema(error, "response")),
			Result.flatMap(ConvertModule.encodeResponse),
		),
}

export type PluginConfig = {
	readonly http: readonly [HttpContractContribution<typeof ApiModule.api, never>]
	readonly projections: readonly [typeof projection]
}

export type Plugin = RouterPlugin.RouterPlugin<
	"anthropic-messages",
	readonly [typeof capability],
	PluginConfig
>

/** Better Auth-style object plugin for Anthropic Messages. */
export const plugin = (options: HttpModule.Options = {}): Plugin =>
	RouterPlugin.make({
		id: "anthropic-messages",
		capabilities: [capability] as const,
		config: {
			http: [makeHttpContribution(options)] as const,
			projections: [projection] as const,
		},
	})

export const makePlugin = plugin
