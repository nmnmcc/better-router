import { defineConfig } from "tsdown"

const packages = {
	core: [
		"Capability",
		"Catalog",
		"Conversion",
		"Deployment",
		"Execution",
		"Generation",
		"GenerationEvents",
		"GenerationSchema",
		"Http",
		"HttpJson",
		"Ingress",
		"Identifier",
		"Lifecycle",
		"Pipeline",
		"Plugin",
		"Projection",
		"Registry",
		"Runtime",
		"Router",
		"Routing",
		"Services",
	],
	"plugin-openai-chat-completions": [
		"OpenAIChatCompletions",
		"OpenAIChatCompletionsHttp",
		"OpenAIChatCompletionsUpstream",
		"OpenAIChatCompletionsPlugin",
	],
	"plugin-openai-responses": [
		"OpenAIResponses",
		"OpenAIResponsesHttp",
		"OpenAIResponsesPlugin",
		"OpenAIResponsesSchema",
		"OpenResponses",
	],
	"plugin-anthropic-messages": [
		"AnthropicMessages",
		"AnthropicMessagesHttp",
		"AnthropicMessagesPlugin",
	],
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
