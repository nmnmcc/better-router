import { defineConfig } from "tsdown"

const packages = {
  core: ["Conversion", "Deployment", "Http", "HttpJson", "Model", "ModelEvents", "ModelSchema", "OpenResponses", "Plugin", "Router", "Routing", "Transform"],
  "plugin-openai-chat-completions": ["OpenAIChatCompletions", "OpenAIChatCompletionsHttp", "OpenAIChatCompletionsUpstream", "OpenAIChatCompletionsPlugin"],
  "plugin-openai-responses": ["OpenAIResponses", "OpenAIResponsesHttp", "OpenAIResponsesPlugin"],
  "plugin-anthropic-messages": ["AnthropicMessages", "AnthropicMessagesHttp", "AnthropicMessagesPlugin"],
}

export default defineConfig(
  Object.entries(packages).map(([name, modules]) => ({
    name,
    cwd: `packages/${name}`,
    entry: {
      index: "src/index.ts",
      ...Object.fromEntries(modules.map((module) => [module, `src/${module}.ts`])),
    },
    format: "esm",
    platform: "neutral",
    target: "es2022",
    fixedExtension: true,
    dts: true,
    sourcemap: true,
    deps: { neverBundle: ["effect", "@better-router/core"] },
  })),
)
