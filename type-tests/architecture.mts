import { Effect, Layer, Redacted, Schema, Stream } from "effect"
import type { Scope } from "effect"
import type { HttpClient } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Plugin, Router } from "@better-router/core"
import type { Deployment } from "@better-router/core"
import type { ModelRequest } from "@better-router/core/Model"
import type { AnthropicMessages, AnthropicMessagesPlugin } from "@better-router/plugin-anthropic-messages"
import { OpenAIChatCompletions, OpenAIChatCompletionsPlugin } from "@better-router/plugin-openai-chat-completions"
import { OpenAIResponses, OpenAIResponsesPlugin } from "@better-router/plugin-openai-responses"
import type { OpenAIResponsesDeployment } from "@better-router/plugin-openai-responses/OpenAIResponses"

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
      execute: { http: () => Effect.succeed(Stream.empty), websocket: () => Effect.succeed(Stream.empty) },
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
type CombinedGroups = Router.ComposedHttpApi<typeof plugins>["groups"]
const responseGroup: CombinedGroups["responses"] = responses
void responseGroup

const router = Router.make({
  plugins,
  routes: [{ model: "chat", deployments: ["openai-main", "anthropic-fallback"] }],
})
void router

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

const request: ModelRequest = { model: "chat", input: [] }
void request
const opened = Effect.flatMap(router, (value) => value.open(request))
void opened

const noRoute: Router.RouterError = Router.RouterError.cases.NoRoute.make({ model: "chat" })
if (Router.RouterError.guards.NoRoute(noRoute)) {
  const model: string = noRoute.model
  void model
}
const setupError: Plugin.SetupError = Plugin.SetupError.cases.DuplicateId.make({ kind: "plugin", id: "duplicate" })
void setupError
const decodeRouterError: (value: unknown) => Router.RouterError = Schema.decodeUnknownSync(Router.RouterError)
void decodeRouterError
const decodeSetupError: (value: unknown) => Plugin.SetupError = Schema.decodeUnknownSync(Plugin.SetupError)
void decodeSetupError

// @ts-expect-error A NoRoute error requires a model.
Router.RouterError.cases.NoRoute.make({})

// @ts-expect-error DuplicateId kind must be a declared registry kind.
Plugin.SetupError.cases.DuplicateId.make({ kind: "other", id: "duplicate" })

// @ts-expect-error Matching RouterError must account for all variants.
Router.RouterError.match(noRoute, { NoRoute: ({ model }) => model })

const conversionError = new OpenAIChatCompletions.OpenAIChatCompletionsConversionError({
  path: "request.model",
  reason: "invalid",
  message: "request.model: required",
})
void conversionError

// @ts-expect-error Schema errors require an object of fields, not positional arguments.
new OpenAIChatCompletions.OpenAIChatCompletionsConversionError("request.model", "invalid", "required")

// @ts-expect-error A deployment must establish the connection in an Effect before returning its event Stream.
const wrongExecutor: Deployment.ModelExecutor = () => Stream.empty
void wrongExecutor

const chat = OpenAIChatCompletionsPlugin.make({ gatewayKey: Redacted.make("client") })
const responsesPlugin = OpenAIResponsesPlugin.make({
  deployments: [OpenAIResponses.make({ id: "openai-http", model: "gpt-5", apiKey: Redacted.make("upstream") })],
})
const gatewayPlugins = [chat, responsesPlugin] as const
const gatewayRouter = Router.make({ plugins: gatewayPlugins, routes: [{ model: "chat", deployments: ["openai-http"] }] })
void gatewayRouter
type GatewayGroups = Router.ComposedHttpApi<typeof gatewayPlugins>["groups"]
const chatGroup: GatewayGroups["openAIChatCompletions"] = chat.http.api.groups.openAIChatCompletions
void chatGroup

// @ts-expect-error The Chat HTTP group is qualified by its provider.
const ambiguousChatGroup: GatewayGroups["chatCompletions"] = chat.http.api.groups.openAIChatCompletions
void ambiguousChatGroup
const gatewayRequirement: Equal<EnvironmentOf<typeof gatewayRouter>, Scope.Scope | HttpClient.HttpClient> = true
void gatewayRequirement

const chatOnlyRouter = Router.make({ plugins: [chat], routes: [] })
const chatOnlyRequirement: Equal<EnvironmentOf<typeof chatOnlyRouter>, Scope.Scope> = true
void chatOnlyRequirement

// @ts-expect-error Ingress authentication cannot be omitted.
OpenAIChatCompletionsPlugin.make({})

// @ts-expect-error Responses plugin requires deployment declarations.
OpenAIResponsesPlugin.make({})

// @ts-expect-error The old messages field is not in the OpenResponses request body.
const legacyRequest: ModelRequest = { model: "chat", messages: [] }
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

const invalidDeployment: Deployment.ModelDeployment = {
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

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type EnvironmentOf<T> = T extends Effect.Effect<unknown, unknown, infer R> ? R : never

const pluginRequirement: Equal<Plugin.PluginRequirements<typeof audit>, AuditLog> = true
const routerRequirement: Equal<EnvironmentOf<typeof withRequirements>, Scope.Scope | AuditLog> = true
void pluginRequirement
void routerRequirement
