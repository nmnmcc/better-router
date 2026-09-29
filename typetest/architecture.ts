import { Effect, Layer, Redacted, Result, Schema, Stream } from "effect"
import type { Scope } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Plugin, Registry, Router } from "@better-router/core"
import type { Deployment } from "@better-router/core"
import type { GenerationRequest } from "@better-router/core/Generation"
import type {
	AnthropicMessages,
	AnthropicMessagesPlugin,
} from "@better-router/plugin-anthropic-messages"
import {
	OpenAIChatCompletions,
	OpenAIChatCompletionsPlugin,
} from "@better-router/plugin-openai-chat-completions"
import {
	OpenAIResponses,
	OpenAIResponsesHttp,
	OpenAIResponsesPlugin,
} from "@better-router/plugin-openai-responses"
import type { OpenAIResponsesDeployment } from "@better-router/plugin-openai-responses/OpenAIResponses"
import type { DirectPipeline } from "@better-router/core/Pipeline"

const responses = HttpApiGroup.make("responses").add(
	HttpApiEndpoint.post("create", "/v1/responses", {
		payload: Schema.Struct({ model: Schema.String }),
		success: Schema.Struct({ id: Schema.String }),
	}),
)

const openaiApi = HttpApi.make("openai").add(responses)
const responsesHandlers = HttpApiBuilder.group(openaiApi, "responses", (handlers) =>
	handlers.handle("create", ({ payload }) => Effect.succeed({ id: payload.model })),
)
const openaiRoutes = HttpApiBuilder.layer(openaiApi).pipe(Layer.provide(responsesHandlers))

const openai = {
	id: "openai-api-fixture",
	deployments: [
		{
			id: "openai-main",
			provider: "openai",
			model: "gpt-5",
			protocol: "openai.responses",
			execute: {
				http: () => Effect.succeed(Stream.empty),
				websocket: () => Effect.succeed(Stream.empty),
			},
		},
	],
	http: {
		api: openaiApi,
		routes: () => openaiRoutes,
	},
} as const satisfies Plugin.RouterPlugin<"openai-api-fixture", never, typeof openaiApi>

const anthropic = {
	id: "anthropic-messages",
	deployments: [
		{
			id: "anthropic-fallback",
			provider: "anthropic",
			model: "claude",
			protocol: "anthropic.messages",
			execute: { http: () => Effect.succeed(Stream.empty) },
		},
	],
} as const satisfies AnthropicMessagesPlugin.AnthropicMessagesPlugin

const legacyAnthropicPlugin: AnthropicMessagesPlugin.AnthropicMessagesPlugin = {
	// @ts-expect-error Plugin IDs identify both the creator and the protocol.
	id: "anthropic",
}
void legacyAnthropicPlugin

const plugins = [openai, anthropic] as const
const declaredDeploymentIds: Equal<
	Plugin.PluginDeploymentIds<typeof plugins>,
	"openai-main" | "anthropic-fallback"
> = true
void declaredDeploymentIds
const concreteRoute: import("@better-router/core/Routing").ModelRoute<"openai-main"> = {
	model: "chat",
	// @ts-expect-error A concrete route type rejects a foreign deployment ID.
	deployments: ["missing-deployment"],
}
void concreteRoute
type CombinedGroups = Router.ComposedHttpApi<typeof plugins>["groups"]
const responseGroup: CombinedGroups["responses"] = responses
void responseGroup

const router = Router.make({
	plugins,
	routes: [{ model: "chat", deployments: ["openai-main", "anthropic-fallback"] }],
})
void router

type DeclaredRoute = Router.RouterOptions<typeof plugins>["routes"][number]
type AllowedRouteDeployment = DeclaredRoute["deployments"][number]
const allowedRouteDeployment: Equal<AllowedRouteDeployment, "openai-main" | "anthropic-fallback"> =
	true
void allowedRouteDeployment
const invalidDeclaredRoute: DeclaredRoute = {
	model: "invalid",
	// @ts-expect-error The instantiated route type excludes undeclared deployment IDs.
	deployments: ["missing-deployment"],
}
void invalidDeclaredRoute

// @ts-expect-error Route deployment IDs must come from the plugin declarations.
Router.make({ plugins, routes: [{ model: "chat", deployments: ["missing-deployment"] }] })

Router.make({
	plugins,
	// @ts-expect-error Duplicate literal model aliases are rejected during composition.
	routes: [
		{ model: "chat", deployments: ["openai-main"] },
		{ model: "chat", deployments: ["anthropic-fallback"] },
	],
})

const policyPlugin = {
	...openai,
	id: "openai-policy",
	policies: [
		{
			id: "fallback",
			rank: (_request, candidates) => Effect.succeed(candidates),
		},
	],
} as const satisfies Plugin.RouterPlugin<"openai-policy">
Router.make({
	plugins: [policyPlugin],
	routes: [{ model: "chat", deployments: ["openai-main"], policy: "fallback" }],
})
Router.make({
	plugins: [policyPlugin],
	// @ts-expect-error Route policy IDs must come from the plugin declarations.
	routes: [{ model: "chat", deployments: ["openai-main"], policy: "missing-policy" }],
})
Router.layer({
	plugins: [policyPlugin],
	// @ts-expect-error Layer construction checks the same route references as make.
	routes: [{ model: "chat", deployments: ["openai-main"], policy: "missing-policy" }],
})

const runtimeDeploymentId: string = "openai-main"
const runtimePolicyId: string = "fallback"
Router.make({
	plugins: [policyPlugin],
	routes: [{ model: "dynamic", deployments: [runtimeDeploymentId], policy: runtimePolicyId }],
})

const dynamicDeployment = {
	...openai.deployments[0],
	id: runtimeDeploymentId,
}
Router.make({
	plugins: [{ id: "dynamic", deployments: [dynamicDeployment] }],
	routes: [{ model: "dynamic", deployments: ["unknown-at-compile-time"] }],
})

const invalidPipeline = {
	id: "native:direct",
	deployment: "missing-deployment",
	source: "missing.protocol",
	target: "missing.protocol",
	execute: (_request) => Effect.succeed({ status: 200, headers: {}, body: Stream.empty }),
} as const satisfies DirectPipeline
const invalidPipelinePlugin = {
	id: "invalid-pipeline",
	pipelines: [invalidPipeline],
} as const satisfies Plugin.RouterPlugin<"invalid-pipeline">
Router.make({
	// @ts-expect-error Pipeline references must resolve to declared deployments and protocols.
	plugins: [openai, invalidPipelinePlugin],
	routes: [],
})

const pipelineFor = <const Source extends string, const Target extends string>(
	source: Source,
	target: Target,
) => ({
	id: "native:direct",
	deployment: "openai-main",
	source,
	target,
	execute: (_request: import("@better-router/core/Pipeline").SelectedRequest) =>
		Effect.succeed({ status: 200, headers: {}, body: Stream.empty }),
})
const responsesProjectionPlugin = {
	id: "responses-projection",
	projections: [OpenAIResponsesHttp.projection],
} as const satisfies Plugin.RouterPlugin<"responses-projection">
Router.make({
	plugins: [
		openai,
		responsesProjectionPlugin,
		{
			id: "valid-pipeline",
			pipelines: [pipelineFor("openai.responses", "openai.responses")],
		},
	],
	routes: [],
})
Router.make({
	// @ts-expect-error Pipeline source must be a declared protocol.
	plugins: [
		openai,
		responsesProjectionPlugin,
		{
			id: "wrong-source",
			pipelines: [pipelineFor("undeclared.protocol", "openai.responses")],
		},
	],
	routes: [],
})
Router.make({
	// @ts-expect-error Pipeline target must match its deployment protocol.
	plugins: [
		openai,
		responsesProjectionPlugin,
		{
			id: "wrong-target",
			pipelines: [pipelineFor("openai.responses", "undeclared.protocol")],
		},
	],
	routes: [],
})

const invalidProjectionPlugin = {
	id: "invalid-projection",
	projections: [{ ...OpenAIResponsesHttp.projection, capability: "missing-capability" }],
} as const satisfies Plugin.RouterPlugin<"invalid-projection">
Router.make({
	// @ts-expect-error Projection capabilities must be declared or built in.
	plugins: [invalidProjectionPlugin],
	routes: [],
})

const invalidCapabilityPlugin = {
	id: "invalid-capability",
	capabilities: [{ id: "custom", version: 1, projections: ["missing.protocol"] }],
} as const satisfies Plugin.RouterPlugin<"invalid-capability">
Router.make({
	// @ts-expect-error Capability projections must resolve to declared protocols.
	plugins: [invalidCapabilityPlugin],
	routes: [],
})

const httpOnly: AnthropicMessages.AnthropicMessagesDeployment = anthropic.deployments[0]
void httpOnly

const openaiHttpOnly: OpenAIResponsesDeployment = {
	id: "openai-http-only",
	provider: "openai",
	model: "gpt-5",
	protocol: "openai.responses",
	execute: { http: () => Effect.succeed(Stream.empty) },
}
void openaiHttpOnly

const request: GenerationRequest = { model: "chat", input: [] }
void request
const opened = Effect.flatMap(router, (value) => value.invoke({ type: "generation", request }))
void opened

const noRoute: Router.RouterError = Router.RouterError.cases.NoRoute.make({ model: "chat" })
if (Router.RouterError.guards.NoRoute(noRoute)) {
	const model: string = noRoute.model
	void model
}
const setupError: Plugin.SetupError = Plugin.SetupError.cases.DuplicateId.make({
	kind: "plugin",
	id: "duplicate",
})
void setupError
const decodeRouterError: (value: unknown) => Router.RouterError = Schema.decodeUnknownSync(
	Router.RouterError,
)
void decodeRouterError
const decodeSetupError: (value: unknown) => Plugin.SetupError = Schema.decodeUnknownSync(
	Plugin.SetupError,
)
void decodeSetupError

// @ts-expect-error A NoRoute error requires a model.
Router.RouterError.cases.NoRoute.make({})

// @ts-expect-error DuplicateId kind must be a declared registry kind.
Plugin.SetupError.cases.DuplicateId.make({ kind: "other", id: "duplicate" })

// @ts-expect-error Matching RouterError must account for all variants.
Router.RouterError.match(noRoute, { NoRoute: ({ model }) => model })

const conversionError = OpenAIChatCompletions.OpenAIChatCompletionsConversionError.make({
	path: "request.model",
	reason: "invalid",
	message: "request.model: required",
})
void conversionError

const invalidConversion: OpenAIChatCompletions.OpenAIChatCompletionsConversionError = {
	path: "request.model",
	// @ts-expect-error A semantic conversion error only accepts the declared reasons.
	reason: "bad",
	message: "required",
}
void invalidConversion

// @ts-expect-error A deployment must establish the connection in an Effect before returning its event Stream.
const wrongExecutor: Deployment.GenerationExecutor = () => Stream.empty
void wrongExecutor

const chat = OpenAIChatCompletionsPlugin.make({ gatewayKey: Redacted.make("client") })
const configuredResponses = OpenAIResponses.make({
	id: "openai-http",
	model: "gpt-5",
	apiKey: Redacted.make("upstream"),
})
const responsesPlugin = OpenAIResponsesPlugin.make(
	Result.isSuccess(configuredResponses) ? { deployments: [configuredResponses.success] } : {},
)
if (Result.isSuccess(configuredResponses)) {
	const configuredId: Equal<typeof configuredResponses.success.id, "openai-http"> = true
	void configuredId
}
const gatewayPlugins = [chat, responsesPlugin] as const
const factoryDeploymentIds: Equal<
	Plugin.PluginDeploymentIds<typeof gatewayPlugins>,
	"openai-http"
> = true
void factoryDeploymentIds
const factoryPolicyIds: Equal<Plugin.PluginPolicyIds<typeof responsesPlugin>, never> = true
const factoryCapabilityIds: Equal<Plugin.PluginCapabilityIds<typeof responsesPlugin>, never> = true
void factoryPolicyIds
void factoryCapabilityIds
type FactoryPipeline = Plugin.PluginPipelines<typeof gatewayPlugins>
const factoryPipelineId: Equal<FactoryPipeline["id"], "openai-http:direct"> = true
void factoryPipelineId
const gatewayRouter = Router.make({
	plugins: gatewayPlugins,
	routes: [{ model: "chat", deployments: ["openai-http"] }],
})
void gatewayRouter
type GatewayGroups = Router.ComposedHttpApi<typeof gatewayPlugins>["groups"]
const chatGroup: GatewayGroups["openAIChatCompletions"] = chat.http.api.groups.openAIChatCompletions
void chatGroup

// @ts-expect-error The Chat HTTP group is qualified by its provider.
const ambiguousChatGroup: GatewayGroups["chatCompletions"] =
	chat.http.api.groups.openAIChatCompletions
void ambiguousChatGroup
const gatewayRequirement: Equal<
	EnvironmentOf<typeof gatewayRouter>,
	Scope.Scope | HttpClient.HttpClient
> = true
void gatewayRequirement

const chatOnlyRouter = Router.make({ plugins: [chat], routes: [] })
const chatOnlyRequirement: Equal<
	EnvironmentOf<typeof chatOnlyRouter>,
	Scope.Scope | HttpClient.HttpClient
> = true
void chatOnlyRequirement

// @ts-expect-error A plugin without deployments cannot satisfy a route deployment reference.
Router.make({ plugins: [chat], routes: [{ model: "chat", deployments: ["openai-http"] }] })

// @ts-expect-error The old messages field is not in the OpenResponses request body.
const legacyRequest: GenerationRequest = { model: "chat", messages: [] }
void legacyRequest

const invalidHttpPlugin: Plugin.RouterPlugin<"incomplete"> = {
	id: "incomplete",
	// @ts-expect-error An HttpApi definition requires a matching route layer.
	http: { api: openaiApi },
}
void invalidHttpPlugin

const invalidAnthropic: AnthropicMessages.AnthropicMessagesDeployment = {
	id: "not-supported",
	provider: "anthropic",
	model: "claude",
	protocol: "anthropic.messages",
	execute: {
		http: () => Effect.succeed(Stream.empty),
		// @ts-expect-error Anthropic Messages does not support upstream WebSocket.
		websocket: () => Effect.succeed(Stream.empty),
	},
}
void invalidAnthropic

const invalidDeployment: Deployment.Deployment = {
	id: "no-transport",
	provider: "openai",
	model: "gpt-5",
	protocol: "openai.responses",
	// @ts-expect-error At least one executable upstream mode is required.
	execute: {},
}
void invalidDeployment

interface AuditLog {
	readonly record: (message: string) => void
}

const audit: Plugin.RouterPlugin<"audit", AuditLog> = { id: "audit" }
const withRequirements = Router.make({ plugins: [audit], routes: [] })
void withRequirements

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type EnvironmentOf<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never

const pluginRequirement: Equal<Plugin.PluginRequirements<typeof audit>, AuditLog> = true
const routerRequirement: Equal<
	EnvironmentOf<typeof withRequirements>,
	Scope.Scope | AuditLog
> = true
void pluginRequirement
void routerRequirement

const registryInspector: Plugin.RouterPlugin<"registry-inspector", Registry.Registry> = {
	id: "registry-inspector",
}
const registryRouter = Router.make({ plugins: [registryInspector], routes: [] })
const registryRouterRequirement: Equal<EnvironmentOf<typeof registryRouter>, Scope.Scope> = true
void registryRouterRequirement
