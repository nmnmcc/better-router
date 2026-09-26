import { Effect, HashMap, HashSet, Layer, Option, Result, Schema, Sink, Stream } from "effect"
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
import { Request } from "./ModelSchema.js"

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
  readonly open: (request: ModelRequest, options?: InvocationOptions) => Effect.Effect<Stream.Stream<ModelEvent, RouterError>, RouterError>
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

type HttpGroups<Plugin> = Plugin extends { readonly http: { readonly api: HttpApi.HttpApi<string, infer Groups> } } ? Groups : never

export type ComposedHttpApi<Plugins extends readonly RouterPlugin<string, unknown>[]> = HttpApi.HttpApi<"better-router", HttpGroups<Plugins[number]>>

interface Registry {
  readonly deployments: HashMap.HashMap<DeploymentId, ModelDeployment<unknown>>
  readonly policies: HashMap.HashMap<string, NonNullable<RouterPlugin["policies"]>[number]>
  readonly transforms: readonly ModelTransform<unknown>[]
  readonly routes: HashMap.HashMap<ModelName, ModelRoute>
  readonly ids: HashSet.HashSet<string>
  readonly groupIds: HashSet.HashSet<string>
  readonly httpPaths: HashSet.HashSet<string>
  readonly api: HttpApi.Top
}

const emptyRegistry = (): Registry => ({
  deployments: HashMap.empty(),
  policies: HashMap.empty(),
  transforms: [],
  routes: HashMap.empty(),
  ids: HashSet.empty(),
  groupIds: HashSet.empty(),
  httpPaths: HashSet.empty(),
  api: HttpApi.make("better-router") as unknown as HttpApi.Top,
})

const duplicate = (kind: "plugin" | "deployment" | "policy" | "transform" | "http_group", id: string) => SetupError.cases.DuplicateId.make({ kind, id })

function registerPlugin(state: Registry, plugin: RouterPlugin<string, unknown>): Result.Result<Registry, SetupError> {
  return Result.gen(function* () {
    if (HashSet.has(state.ids, plugin.id)) return yield* Result.fail(duplicate("plugin", plugin.id))
    const deployments = yield* (plugin.deployments ?? []).reduce<Result.Result<Registry["deployments"], SetupError>>(
      (current, deployment) =>
        Result.gen(function* () {
          const entries = yield* current
          if (HashMap.has(entries, deployment.id)) return yield* Result.fail(duplicate("deployment", deployment.id))
          if (!deployment.execute.http && !deployment.execute.websocket) {
            return yield* Result.fail(
              SetupError.cases.InvalidRoute.make({
                model: deployment.id,
                message: "Deployment has no executor",
              }),
            )
          }
          return HashMap.set(entries, deployment.id, deployment)
        }),
      Result.succeed(state.deployments),
    )
    const policies = yield* (plugin.policies ?? []).reduce<Result.Result<Registry["policies"], SetupError>>(
      (current, policy) =>
        Result.gen(function* () {
          const entries = yield* current
          if (HashMap.has(entries, policy.id)) return yield* Result.fail(duplicate("policy", policy.id))
          return HashMap.set(entries, policy.id, policy)
        }),
      Result.succeed(state.policies),
    )
    const transforms = yield* (plugin.transforms ?? []).reduce<Result.Result<Registry["transforms"], SetupError>>(
      (current, transform) =>
        Result.gen(function* () {
          const entries = yield* current
          if (entries.some((entry) => entry.id === transform.id)) {
            return yield* Result.fail(duplicate("transform", transform.id))
          }
          return [...entries, transform]
        }),
      Result.succeed(state.transforms),
    )
    const fragment = plugin.http?.api as HttpApi.Top | undefined
    const http = yield* Object.values(fragment?.groups ?? {}).reduce<Result.Result<Pick<Registry, "groupIds" | "httpPaths">, SetupError>>(
      (current, group) =>
        Result.gen(function* () {
          const entries = yield* current
          if (HashSet.has(entries.groupIds, group.identifier)) {
            return yield* Result.fail(duplicate("http_group", group.identifier))
          }
          const paths = yield* Object.values(group.endpoints).reduce<Result.Result<Registry["httpPaths"], SetupError>>(
            (currentPaths, endpoint) =>
              Result.gen(function* () {
                const seen = yield* currentPaths
                const key = `${endpoint.method} ${endpoint.path}`
                if (HashSet.has(seen, key)) {
                  return yield* Result.fail(
                    SetupError.cases.DuplicateHttpRoute.make({
                      method: endpoint.method,
                      path: endpoint.path,
                    }),
                  )
                }
                return HashSet.add(seen, key)
              }),
            Result.succeed(entries.httpPaths),
          )
          return { groupIds: HashSet.add(entries.groupIds, group.identifier), httpPaths: paths }
        }),
      Result.succeed({ groupIds: state.groupIds, httpPaths: state.httpPaths }),
    )
    return {
      ...state,
      deployments,
      policies,
      transforms,
      ...http,
      ids: HashSet.add(state.ids, plugin.id),
      api: fragment ? state.api.addHttpApi(fragment) : state.api,
    }
  })
}

function registerRoute(state: Registry, route: ModelRoute): Result.Result<Registry, SetupError> {
  if (HashMap.has(state.routes, route.model)) {
    return Result.fail(SetupError.cases.InvalidRoute.make({ model: route.model, message: "Duplicate model route" }))
  }
  if (route.deployments.length === 0 || HashSet.size(HashSet.fromIterable(route.deployments)) !== route.deployments.length || route.deployments.some((id) => !HashMap.has(state.deployments, id)) || (route.policy && !HashMap.has(state.policies, route.policy))) {
    return Result.fail(
      SetupError.cases.InvalidRoute.make({
        model: route.model,
        message: "Unknown or duplicate deployment or policy",
      }),
    )
  }
  return Result.succeed({ ...state, routes: HashMap.set(state.routes, route.model, route) })
}

/** Compose declarations once, then keep the scope open for SDK calls and HTTP serving. */
export function make<const Plugins extends readonly RouterPlugin<string, unknown>[]>(options: RouterOptions<Plugins>): Effect.Effect<Router<ComposedHttpApi<Plugins>>, SetupError, Scope.Scope | PluginRequirements<Plugins[number]>> {
  const program = Effect.gen(function* () {
    const environment = yield* Effect.context<Scope.Scope | PluginRequirements<Plugins[number]>>()
    const plugins = options.plugins.reduce<Result.Result<Registry, SetupError>>((current, plugin) => Result.flatMap(current, (state) => registerPlugin(state, plugin)), Result.succeed(emptyRegistry()))
    const registry = yield* Effect.fromResult(options.routes.reduce<Result.Result<Registry, SetupError>>((current, route) => Result.flatMap(current, (state) => registerRoute(state, route)), plugins))

    const select: ModelHandler<unknown> = (request, invocation) =>
      Effect.gen(function* () {
        const route = yield* Option.match(HashMap.get(registry.routes, request.model), {
          onNone: () => Effect.fail(RouterError.cases.NoRoute.make({ model: request.model })),
          onSome: Effect.succeed,
        })
        if (request.previous_response_id && route.deployments.length !== 1) {
          return yield* Effect.fail(
            RouterError.cases.UnsupportedCapability.make({
              model: request.model,
              capability: "provider-owned continuation",
            }),
          )
        }
        const configured = yield* Effect.forEach(route.deployments, (id) =>
          Option.match(HashMap.get(registry.deployments, id), {
            onNone: () => Effect.fail(RouterError.cases.NoAvailableDeployment.make({ model: request.model })),
            onSome: Effect.succeed,
          }),
        )
        const required = invocation?.upstream?.mode === "require" ? invocation.upstream.transport : undefined
        const eligible = configured.filter((deployment) => !required || !!deployment.execute[required])
        if (eligible.length === 0) {
          return yield* Effect.fail(required ? RouterError.cases.UnsupportedCapability.make({ model: request.model, capability: required }) : RouterError.cases.NoAvailableDeployment.make({ model: request.model }))
        }
        const policy = route.policy ? HashMap.get(registry.policies, route.policy) : Option.none()
        const ranked = Option.isSome(policy) ? yield* policy.value.rank(request, eligible).pipe(Effect.mapError((cause) => RouterError.cases.RoutingFailed.make({ cause }))) : eligible
        const eligibleIds = HashSet.fromIterable(eligible.map((deployment) => deployment.id))
        if (HashSet.size(HashSet.fromIterable(ranked.map((entry) => entry.id))) !== ranked.length || ranked.some((entry) => !HashSet.has(eligibleIds, entry.id))) {
          return yield* Effect.fail(
            RouterError.cases.RoutingFailed.make({
              cause: { message: "Policy returned an unknown or duplicate deployment" },
            }),
          )
        }
        if (ranked.length === 0) return yield* Effect.fail(RouterError.cases.NoAvailableDeployment.make({ model: request.model }))

        const attempt = (index: number): Effect.Effect<Stream.Stream<ModelEvent, RouterError>, RouterError, unknown> =>
          Effect.gen(function* () {
            const selected = yield* Option.match(HashMap.get(registry.deployments, ranked[index].id), {
              onNone: () => Effect.fail(RouterError.cases.NoAvailableDeployment.make({ model: request.model })),
              onSome: Effect.succeed,
            })
            const preferred = invocation?.upstream?.transport
            const transport = preferred && selected.execute[preferred] ? preferred : selected.execute.http ? "http" : "websocket"
            const execute = selected.execute[transport]!
            const upstreamRequest = { ...request, model: selected.model }
            const failure = (cause: ProviderError): RouterError => RouterError.cases.ProviderFailed.make({ deployment: selected.id, cause })
            const next = (cause: ProviderError) => (cause.retryable && index + 1 < ranked.length ? attempt(index + 1) : Effect.fail(failure(cause)))
            return yield* execute(upstreamRequest).pipe(
              Effect.map(
                (events) =>
                  Stream.unwrap(
                    Stream.peel(Stream.rechunk(Stream.provideContext(events, environment), 1), Sink.head<ModelEvent>()).pipe(
                      Effect.map(([first, rest]) =>
                        Option.match(first, {
                          onNone: () => Stream.empty,
                          onSome: (event) => Stream.concat(Stream.succeed(event), Stream.mapError(rest, failure)),
                        }),
                      ),
                      Effect.catch(next),
                    ),
                  ) as Stream.Stream<ModelEvent, RouterError>,
              ),
              Effect.catch(next),
            )
          })
        return yield* attempt(0)
      })

    const handler = registry.transforms.reduceRight<ModelHandler<unknown>>((next, transform) => transform.wrap(next), select)

    const open: Router["open"] = (request, invocation) =>
      Schema.decodeUnknownEffect(Request)(request).pipe(
        Effect.mapError((error) => RouterError.cases.InvalidRequest.make({ message: error.message })),
        Effect.flatMap((parsed) => (parsed.model ? handler({ ...parsed, model: parsed.model }, invocation) : Effect.fail(RouterError.cases.InvalidRequest.make({ message: "A model alias is required" })))),
        Effect.provideContext(environment),
      ) as Effect.Effect<Stream.Stream<ModelEvent, RouterError>, RouterError>
    const stream: Router["stream"] = (request, invocation) => Stream.unwrap(open(request, invocation))
    const complete: Router["complete"] = (request, invocation) =>
      Effect.gen(function* () {
        const terminal = yield* Stream.runFoldEffect(
          stream(request, invocation),
          () => Option.none<ModelResponse>(),
          (previous, event) => (Option.isSome(previous) ? Effect.fail(RouterError.cases.InvalidResponse.make({ message: "Events followed the terminal response" })) : Effect.succeed(event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed" ? Option.some(event.response) : previous)),
        )
        return yield* Option.match(terminal, {
          onNone: () => Effect.fail(RouterError.cases.InvalidResponse.make({ message: "Missing terminal response" })),
          onSome: Effect.succeed,
        })
      })

    const router: Router<ComposedHttpApi<Plugins>> = {
      open,
      stream,
      complete,
      http: {
        api: registry.api as unknown as ComposedHttpApi<Plugins>,
        get routes() {
          const contextLayer = Layer.succeedContext(environment)
          return options.plugins.reduce<Layer.Layer<never, never, HttpHostServices>>((current, plugin) => (plugin.http ? (Layer.merge(current, Layer.provide(plugin.http.routes(router), contextLayer)) as Layer.Layer<never, never, HttpHostServices>) : current), Layer.empty)
        },
      },
    }
    yield* Effect.forEach(options.plugins, (plugin) =>
      plugin.start
        ? plugin.start(router).pipe(
            Effect.provideContext(environment),
            Effect.mapError((cause) => SetupError.cases.PluginStartFailed.make({ plugin: plugin.id, cause })),
          )
        : Effect.void,
    )
    return router
  })
  // Plugin declarations are erased in the registry; their requirements were captured above.
  return program as Effect.Effect<Router<ComposedHttpApi<Plugins>>, SetupError, Scope.Scope | PluginRequirements<Plugins[number]>>
}
