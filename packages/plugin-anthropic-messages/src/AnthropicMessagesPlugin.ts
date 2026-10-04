import type { Redacted } from "effect"
import { Plugin as RouterPlugin } from "@better-router/core"
import * as Protocol from "@better-router/protocol-anthropic-messages"
import * as Provider from "@better-router/provider-anthropic"

export interface Options {
	readonly gatewayKey?: Redacted.Redacted<string>
	readonly provider?: Parameters<typeof Provider.AnthropicMessages.layer>[0]
}

type PluginState = {
	readonly apis: readonly [ReturnType<typeof Protocol.makeContract>]
	readonly providers: readonly [] | readonly [ReturnType<typeof Provider.AnthropicMessages.layer>]
}

export type Plugin = RouterPlugin.RouterPlugin<
	"anthropic-messages",
	readonly [typeof Protocol.capability, typeof Provider.AnthropicMessages.capability],
	PluginState
>

/** Compose Anthropic Messages capability declarations and state configuration. */
export const plugin = (options: Options = {}): Plugin =>
	RouterPlugin.make({
		id: "anthropic-messages",
		capabilities: [Protocol.capability, Provider.AnthropicMessages.capability] as const,
		state: {
			apis: [Protocol.makeContract({ gatewayKey: options.gatewayKey })] as const,
			providers:
				options.provider === undefined
					? ([] as const)
					: ([Provider.AnthropicMessages.layer(options.provider)] as const),
		},
	})

export const make = plugin
export const makePlugin = plugin
