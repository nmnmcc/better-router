import { Effect, Layer, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { ProviderError } from "./Deployment.js"
import type { DeploymentId, InvocationOptions, ModelDeployment } from "./Deployment.js"
import type { HttpHostServices } from "./Http.js"
import type { ModelEvent, ModelName, ModelRequest, ModelResponse } from "./Model.js"
import { SetupError } from "./Plugin.js"
import type { PluginRequirements, RouterPlugin } from "./Plugin.js"
import { RoutingError } from "./Routing.js"
import type { ModelRoute } from "./Routing.js"
import type { ModelHandler, ModelTransform } from "./Transform.js"

export const RouterError = Schema.TaggedUnion({
  InvalidRequest: { message: Schema.String },
  NoRoute: { model: Schema.String },
  NoAvailableDeployment: { model: Schema.String },
  UnsupportedCapability: { model: Schema.String, capability: Schema.String },
  RoutingFailed: { cause: RoutingError },
  ProviderFailed: { deployment: Schema.String, cause: ProviderError },
  TransformFailed: { id: Schema.String, cause: Schema.Defect({ excludeCause: true }) },
  InvalidResponse: { message: Schema.String },
})

export type RouterError = typeof RouterError.Type

export interface Router<Api extends HttpApi.Constraint = HttpApi.Constraint> {
  /** Establish the selected upstream before committing an HTTP streaming response. */
  readonly open: (
    request: ModelRequest,
    options?: InvocationOptions,
  ) => Effect.Effect<Stream.Stream<ModelEvent, RouterError>, RouterError>
  /** Fallback is possible only before the first event has been emitted. */
  readonly stream: (request: ModelRequest, options?: InvocationOptions) => Stream.Stream<ModelEvent, RouterError>
  /** Returns the terminal OpenResponses response snapshot from the same execution path. */
  readonly complete: (request: ModelRequest, options?: InvocationOptions) => Effect.Effect<ModelResponse, RouterError>
  /** The composed HTTP surface and routes; hosts may serve them or make a fetch handler. */
  readonly http: {
    readonly api: Api
    readonly routes: Layer.Layer<never, never, HttpHostServices>
  }
}

export interface RouterOptions<Plugins extends readonly RouterPlugin<string, unknown>[]> {
  readonly routes: readonly ModelRoute[]
  readonly plugins: Plugins
}

type HttpGroups<Plugin> = Plugin extends { readonly http: { readonly api: HttpApi.HttpApi<string, infer Groups> } }
  ? Groups
  : never

export type ComposedHttpApi<Plugins extends readonly RouterPlugin<string, unknown>[]> = HttpApi.HttpApi<
  "better-router",
  HttpGroups<Plugins[number]>
>

/** Compose declarations once, then keep the scope open for SDK calls and HTTP serving. */
export function make<const Plugins extends readonly RouterPlugin<string, unknown>[]>(
  options: RouterOptions<Plugins>,
): Effect.Effect<Router<ComposedHttpApi<Plugins>>, SetupError, Scope.Scope | PluginRequirements<Plugins[number]>> {
  const program = Effect.gen(function* () {
    const environment = yield* Effect.context<Scope.Scope | PluginRequirements<Plugins[number]>>()
    const deployments = new Map<DeploymentId, ModelDeployment<unknown>>()
    const policies = new Map<string, NonNullable<RouterPlugin["policies"]>[number]>()
    const transforms: ModelTransform<unknown>[] = []
    const routes = new Map<ModelName, ModelRoute>()
    const ids = new Set<string>()
    const groupIds = new Set<string>()
    const httpPaths = new Set<string>()
    let api: HttpApi.Top = HttpApi.make("better-router") as unknown as HttpApi.Top

    for (const plugin of options.plugins) {
      if (ids.has(plugin.id)) return yield* Effect.fail(SetupError.cases.DuplicateId.make({ kind: "plugin", id: plugin.id }))
      ids.add(plugin.id)
      for (const deployment of plugin.deployments ?? []) {
        if (deployments.has(deployment.id))
          return yield* Effect.fail(SetupError.cases.DuplicateId.make({ kind: "deployment", id: deployment.id }))
        if (!deployment.execute.http && !deployment.execute.websocket) {
          return yield* Effect.fail(SetupError.cases.InvalidRoute.make({
            model: deployment.id,
            message: "Deployment has no executor",
          }))
        }
        deployments.set(deployment.id, deployment)
      }
      for (const policy of plugin.policies ?? []) {
        if (policies.has(policy.id))
          return yield* Effect.fail(SetupError.cases.DuplicateId.make({ kind: "policy", id: policy.id }))
        policies.set(policy.id, policy)
      }
      for (const transform of plugin.transforms ?? []) {
        if (transforms.some((entry) => entry.id === transform.id)) {
          return yield* Effect.fail(SetupError.cases.DuplicateId.make({ kind: "transform", id: transform.id }))
        }
        transforms.push(transform)
      }
      if (plugin.http) {
        const fragment = plugin.http.api as HttpApi.Top
        for (const group of Object.values(fragment.groups)) {
          if (groupIds.has(group.identifier)) {
            return yield* Effect.fail(SetupError.cases.DuplicateId.make({ kind: "http_group", id: group.identifier }))
          }
          groupIds.add(group.identifier)
          for (const endpoint of Object.values(group.endpoints)) {
            const key = `${endpoint.method} ${endpoint.path}`
            if (httpPaths.has(key)) {
              return yield* Effect.fail(SetupError.cases.DuplicateHttpRoute.make({
                method: endpoint.method,
                path: endpoint.path,
              }))
            }
            httpPaths.add(key)
          }
        }
        api = api.addHttpApi(fragment)
      }
    }

    for (const route of options.routes) {
      if (routes.has(route.model)) {
        return yield* Effect.fail(SetupError.cases.InvalidRoute.make({
          model: route.model,
          message: "Duplicate model route",
        }))
      }
      if (
        route.deployments.length === 0 ||
        new Set(route.deployments).size !== route.deployments.length ||
        route.deployments.some((id) => !deployments.has(id)) ||
        (route.policy && !policies.has(route.policy))
      ) {
        return yield* Effect.fail(SetupError.cases.InvalidRoute.make({
          model: route.model,
          message: "Unknown or duplicate deployment or policy",
        }))
      }
      routes.set(route.model, route)
    }

    const select: ModelHandler<unknown> = (request, invocation) =>
      Effect.gen(function* () {
        if (!request || typeof request.model !== "string" || !request.model) {
          return yield* Effect.fail(RouterError.cases.InvalidRequest.make({ message: "A model alias is required" }))
        }
        const route = routes.get(request.model)
        if (!route) return yield* Effect.fail(RouterError.cases.NoRoute.make({ model: request.model }))
        if (request.previous_response_id && route.deployments.length !== 1) {
          return yield* Effect.fail(RouterError.cases.UnsupportedCapability.make({
            model: request.model,
            capability: "provider-owned continuation",
          }))
        }
        const configured = route.deployments.map((id) => deployments.get(id)!)
        const required = invocation?.upstream?.mode === "require" ? invocation.upstream.transport : undefined
        const eligible = configured.filter((deployment) => !required || !!deployment.execute[required])
        if (eligible.length === 0) {
          return yield* Effect.fail(
            required
              ? RouterError.cases.UnsupportedCapability.make({ model: request.model, capability: required })
              : RouterError.cases.NoAvailableDeployment.make({ model: request.model }),
          )
        }
        const policy = route.policy ? policies.get(route.policy) : undefined
        const ranked = policy
          ? yield* policy
              .rank(request, eligible)
              .pipe(Effect.mapError((cause) => RouterError.cases.RoutingFailed.make({ cause })))
          : eligible
        const eligibleIds = new Set(eligible.map((deployment) => deployment.id))
        if (
          new Set(ranked.map((entry) => entry.id)).size !== ranked.length ||
          ranked.some((entry) => !eligibleIds.has(entry.id))
        ) {
          return yield* Effect.fail(RouterError.cases.RoutingFailed.make({
            cause: { message: "Policy returned an unknown or duplicate deployment" },
          }))
        }
        if (ranked.length === 0)
          return yield* Effect.fail(RouterError.cases.NoAvailableDeployment.make({ model: request.model }))

        const attempt = (
          index: number,
        ): Effect.Effect<Stream.Stream<ModelEvent, RouterError>, RouterError, unknown> => {
          const selected = deployments.get(ranked[index].id)!
          const preferred = invocation?.upstream?.transport
          const transport =
            preferred && selected.execute[preferred] ? preferred : selected.execute.http ? "http" : "websocket"
          const execute = selected.execute[transport]!
          const upstreamRequest = { ...request, model: selected.model }
          const failure = (cause: ProviderError): RouterError =>
            RouterError.cases.ProviderFailed.make({ deployment: selected.id, cause })
          const next = (cause: ProviderError) =>
            cause.retryable && index + 1 < ranked.length ? attempt(index + 1) : Effect.fail(failure(cause))
          return execute(upstreamRequest).pipe(
            Effect.map((events) =>
              Stream.suspend(() => {
                let emitted = false
                return Stream.provideContext(events, environment).pipe(
                  Stream.map((event) => {
                    emitted = true
                    return event
                  }),
                  Stream.mapError(failure),
                  Stream.catch((error) =>
                    !emitted &&
                    RouterError.guards.ProviderFailed(error) &&
                    error.cause.retryable &&
                    index + 1 < ranked.length
                      ? Stream.unwrap(attempt(index + 1))
                      : Stream.fail(error),
                  ),
                ) as Stream.Stream<ModelEvent, RouterError>
              }),
            ),
            Effect.catch(next),
          )
        }
        return yield* attempt(0)
      })

    let handler = select
    for (const transform of [...transforms].reverse()) handler = transform.wrap(handler)

    const open: Router["open"] = (request, invocation) =>
      handler(request, invocation).pipe(Effect.provideContext(environment)) as Effect.Effect<
        Stream.Stream<ModelEvent, RouterError>,
        RouterError
      >
    const stream: Router["stream"] = (request, invocation) => Stream.unwrap(open(request, invocation))
    const complete: Router["complete"] = (request, invocation) =>
      Effect.gen(function* () {
        let terminal: ModelResponse | undefined
        yield* Stream.runForEach(stream(request, invocation), (event) => {
          if (terminal)
            return Effect.fail(RouterError.cases.InvalidResponse.make({ message: "Events followed the terminal response" }))
          if (
            event.type === "response.completed" ||
            event.type === "response.incomplete" ||
            event.type === "response.failed"
          ) {
            terminal = event.response
          }
          return Effect.void
        })
        if (!terminal)
          return yield* Effect.fail(RouterError.cases.InvalidResponse.make({ message: "Missing terminal response" }))
        return terminal
      })

    let httpRoutes: Layer.Layer<never, never, HttpHostServices> = Layer.empty
    const router: Router<ComposedHttpApi<Plugins>> = {
      open,
      stream,
      complete,
      http: {
        api: api as unknown as ComposedHttpApi<Plugins>,
        get routes() {
          return httpRoutes
        },
      },
    }
    const contextLayer = Layer.succeedContext(environment)
    httpRoutes = options.plugins.reduce<Layer.Layer<never, never, HttpHostServices>>(
      (current, plugin) =>
        plugin.http
          ? (Layer.merge(current, Layer.provide(plugin.http.routes(router), contextLayer)) as Layer.Layer<
              never,
              never,
              HttpHostServices
            >)
          : current,
      Layer.empty,
    )
    for (const plugin of options.plugins) {
      if (plugin.start) {
        yield* plugin.start(router).pipe(
          Effect.provideContext(environment),
          Effect.mapError((cause) => SetupError.cases.PluginStartFailed.make({ plugin: plugin.id, cause })),
        )
      }
    }
    return router
  })
  // Plugin declarations are erased in the registry; their requirements were captured above.
  return program as Effect.Effect<
    Router<ComposedHttpApi<Plugins>>,
    SetupError,
    Scope.Scope | PluginRequirements<Plugins[number]>
  >
}
