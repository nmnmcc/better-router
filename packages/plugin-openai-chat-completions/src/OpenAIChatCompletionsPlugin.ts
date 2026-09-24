import type { Redacted } from "effect"
import type { RouterPlugin } from "@better-router/core/Plugin"
import * as OpenAIChatCompletionsHttp from "./OpenAIChatCompletionsHttp.js"

export interface OpenAIChatCompletionsPlugin
  extends RouterPlugin<"openai-chat-completions", never, typeof OpenAIChatCompletionsHttp.api> {
  readonly http: ReturnType<typeof OpenAIChatCompletionsHttp.make>
}

export interface OpenAIChatCompletionsPluginOptions {
  readonly gatewayKey: Redacted.Redacted<string>
}

/** Declare only the Chat Completions HTTP ingress. */
export function make(options: OpenAIChatCompletionsPluginOptions): OpenAIChatCompletionsPlugin {
  return {
    id: "openai-chat-completions",
    http: OpenAIChatCompletionsHttp.make({ gatewayKey: options.gatewayKey }),
  }
}
