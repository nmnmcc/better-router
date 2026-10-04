import type { Redacted } from "effect"
import { Plugin as RouterPlugin } from "@better-router/core"
import * as Protocol from "@better-router/protocol-openai-chat-completions"
import * as Provider from "@better-router/provider-openai"

export interface Options {
	readonly gatewayKey?: Redacted.Redacted<string>
	readonly provider?: Parameters<typeof Provider.OpenAIChatCompletions.layer>[0]
}

type PluginState = {
	readonly apis: readonly [ReturnType<typeof Protocol.makeContract>]
	readonly providers:
		readonly [] | readonly [ReturnType<typeof Provider.OpenAIChatCompletions.layer>]
}

export type Plugin = RouterPlugin.RouterPlugin<
	"openai-chat-completions",
	readonly [typeof Protocol.capability, typeof Provider.OpenAIChatCompletions.capability],
	PluginState
>

/** Compose Chat Completions capability declarations and state configuration. */
export const plugin = (options: Options = {}): Plugin =>
	RouterPlugin.make({
		id: "openai-chat-completions",
		capabilities: [Protocol.capability, Provider.OpenAIChatCompletions.capability] as const,
		state: {
			apis: [Protocol.makeContract({ gatewayKey: options.gatewayKey })] as const,
			providers:
				options.provider === undefined
					? ([] as const)
					: ([Provider.OpenAIChatCompletions.layer(options.provider)] as const),
		},
	})

export const make = plugin
export const makePlugin = plugin
