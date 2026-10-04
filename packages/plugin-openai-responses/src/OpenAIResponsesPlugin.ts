import type { Redacted } from "effect"
import { Plugin as RouterPlugin } from "@better-router/core"
import * as Protocol from "@better-router/protocol-openai-responses"
import * as Provider from "@better-router/provider-openai"

export interface Options {
	readonly gatewayKey?: Redacted.Redacted<string>
	readonly provider?: Parameters<typeof Provider.OpenAIResponses.layer>[0]
}

type PluginState = {
	readonly apis: readonly [ReturnType<typeof Protocol.makeContract>]
	readonly providers: readonly [] | readonly [ReturnType<typeof Provider.OpenAIResponses.layer>]
}

export type Plugin = RouterPlugin.RouterPlugin<
	"openai-responses",
	readonly [typeof Protocol.capability, typeof Provider.OpenAIResponses.capability],
	PluginState
>

/**
 * Compose the Responses ingress and its optional OpenAI state in one plugin.
 * The capability descriptors are stable; credentials and provider config stay
 * inside the returned state Layers.
 */
export const plugin = (options: Options = {}): Plugin =>
	RouterPlugin.make({
		id: "openai-responses",
		capabilities: [Protocol.capability, Provider.OpenAIResponses.capability] as const,
		state: {
			apis: [Protocol.makeContract({ gatewayKey: options.gatewayKey })] as const,
			providers:
				options.provider === undefined
					? ([] as const)
					: ([Provider.OpenAIResponses.layer(options.provider)] as const),
		},
	})

export const make = plugin
export const makePlugin = plugin
