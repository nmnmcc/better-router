import { Layer } from "effect"
import { Capability, Plugin as RouterPlugin } from "@better-router/core"
import { Route } from "@better-router/core/Route"
import type { Contract } from "@better-router/core/Api"
import * as ApiModule from "./Api.js"
import * as HttpModule from "./Http.js"

export * as Api from "./Api.js"
export * as Convert from "./Convert.js"
export * as Http from "./Http.js"

export const makeContract = (options: HttpModule.Options = {}): Contract<typeof ApiModule.api> => ({
	api: ApiModule.api,
	layer: (route) =>
		HttpModule.layer(options).pipe(Layer.provide(Layer.succeed(Route, route))) as never,
})

export const contract = makeContract()

/** Stable ingress capability; gateway credentials belong to plugin state. */
export const capability = Capability.make({
	id: "protocol.anthropic.messages",
	version: 1,
	kind: "protocol",
	projections: ["generation"],
} as const)

type PluginState = { readonly apis: readonly [Contract<typeof ApiModule.api>] }

export type Plugin = RouterPlugin.RouterPlugin<
	"anthropic-messages",
	readonly [typeof capability],
	PluginState
>

/** Better Auth-style object plugin for Anthropic Messages. */
export const plugin = (options: HttpModule.Options = {}): Plugin =>
	RouterPlugin.make({
		id: "anthropic-messages",
		capabilities: [capability] as const,
		state: { apis: [makeContract(options)] as const },
	})

export const makePlugin = plugin
