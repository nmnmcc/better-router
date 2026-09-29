import { Context, HashMap, HashSet, Layer, Result } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { generation } from "./Capability.js"
import type { Capability } from "./Capability.js"
import type { Deployment, DeploymentId } from "./Deployment.js"
import type { ModelAlias } from "./Generation.js"
import type { DirectPipeline, Middleware } from "./Pipeline.js"
import { SetupError } from "./Plugin.js"
import type { RouterPlugin } from "./Plugin.js"
import type { ProtocolDefinition } from "./Projection.js"
import type { ModelRoute, RoutingPolicy } from "./Routing.js"

/** The immutable declaration state used by composition and runtime inspection. */
export interface Snapshot {
  readonly deployments: HashMap.HashMap<DeploymentId, Deployment<unknown>>
  readonly policies: HashMap.HashMap<string, RoutingPolicy>
  readonly middleware: readonly Middleware<unknown>[]
  readonly pipelines: readonly DirectPipeline<unknown>[]
  readonly projections: HashMap.HashMap<string, ProtocolDefinition>
  readonly capabilities: HashMap.HashMap<string, Capability>
  readonly routes: HashMap.HashMap<ModelAlias, ModelRoute>
  readonly ids: HashSet.HashSet<string>
  readonly groupIds: HashSet.HashSet<string>
  readonly httpPaths: HashSet.HashSet<string>
  readonly api: HttpApi.Top
}

/** The composed declaration registry is available to plugin resources and hosts. */
export class Registry extends Context.Service<Registry, Snapshot>()("Registry") {}

export const empty = (): Snapshot => ({
  deployments: HashMap.empty(),
  policies: HashMap.empty(),
  middleware: [],
  pipelines: [],
  projections: HashMap.empty(),
  capabilities: HashMap.set(HashMap.empty(), generation.id, generation),
  routes: HashMap.empty(),
  ids: HashSet.empty(),
  groupIds: HashSet.empty(),
  httpPaths: HashSet.empty(),
  api: HttpApi.make("better-router") as unknown as HttpApi.Top,
})

const duplicate = (kind: "plugin" | "capability" | "deployment" | "pipeline" | "projection" | "policy" | "middleware" | "http_group", id: string) => SetupError.cases.DuplicateId.make({ kind, id })

export const addCapability = (snapshot: Snapshot, capability: Capability): Result.Result<Snapshot, SetupError> => (HashMap.has(snapshot.capabilities, capability.id) ? Result.fail(duplicate("capability", capability.id)) : Result.succeed({ ...snapshot, capabilities: HashMap.set(snapshot.capabilities, capability.id, capability) }))

export const addDeployment = (snapshot: Snapshot, deployment: Deployment<unknown>): Result.Result<Snapshot, SetupError> => (HashMap.has(snapshot.deployments, deployment.id) ? Result.fail(duplicate("deployment", deployment.id)) : !deployment.execute.http && !deployment.execute.websocket ? Result.fail(SetupError.cases.InvalidRoute.make({ model: deployment.id, message: "Deployment has no executor" })) : Result.succeed({ ...snapshot, deployments: HashMap.set(snapshot.deployments, deployment.id, deployment) }))

export const addPolicy = (snapshot: Snapshot, policy: RoutingPolicy): Result.Result<Snapshot, SetupError> => (HashMap.has(snapshot.policies, policy.id) ? Result.fail(duplicate("policy", policy.id)) : Result.succeed({ ...snapshot, policies: HashMap.set(snapshot.policies, policy.id, policy) }))

export const addMiddleware = (snapshot: Snapshot, middleware: Middleware<unknown>): Result.Result<Snapshot, SetupError> => (snapshot.middleware.some((entry) => entry.id === middleware.id) ? Result.fail(duplicate("middleware", middleware.id)) : Result.succeed({ ...snapshot, middleware: [...snapshot.middleware, middleware] }))

export const addPipeline = (snapshot: Snapshot, pipeline: DirectPipeline<unknown>): Result.Result<Snapshot, SetupError> => (snapshot.pipelines.some((entry) => entry.id === pipeline.id) ? Result.fail(duplicate("pipeline", pipeline.id)) : Result.succeed({ ...snapshot, pipelines: [...snapshot.pipelines, pipeline] }))

export const addProjection = (snapshot: Snapshot, projection: ProtocolDefinition): Result.Result<Snapshot, SetupError> => (HashMap.has(snapshot.projections, projection.protocol) ? Result.fail(duplicate("projection", projection.protocol)) : !HashMap.has(snapshot.capabilities, projection.capability) ? Result.fail(SetupError.cases.InvalidRoute.make({ model: projection.protocol, message: `Unknown capability ${projection.capability}` })) : Result.succeed({ ...snapshot, projections: HashMap.set(snapshot.projections, projection.protocol, projection) }))

const addHttp = (snapshot: Snapshot, fragment: HttpApi.Top): Result.Result<Pick<Snapshot, "groupIds" | "httpPaths">, SetupError> =>
  Object.values(fragment.groups).reduce<Result.Result<Pick<Snapshot, "groupIds" | "httpPaths">, SetupError>>(
    (current, group) =>
      Result.gen(function* () {
        const entries = yield* current
        if (HashSet.has(entries.groupIds, group.identifier)) return yield* Result.fail(duplicate("http_group", group.identifier))
        const paths = yield* Object.values(group.endpoints).reduce<Result.Result<Snapshot["httpPaths"], SetupError>>(
          (currentPaths, endpoint) =>
            Result.gen(function* () {
              const seen = yield* currentPaths
              const key = `${endpoint.method} ${endpoint.path}`
              if (HashSet.has(seen, key)) {
                return yield* Result.fail(SetupError.cases.DuplicateHttpRoute.make({ method: endpoint.method, path: endpoint.path }))
              }
              return HashSet.add(seen, key)
            }),
          Result.succeed(entries.httpPaths),
        )
        return { groupIds: HashSet.add(entries.groupIds, group.identifier), httpPaths: paths }
      }),
    Result.succeed({ groupIds: snapshot.groupIds, httpPaths: snapshot.httpPaths }),
  )

const addMany = <Value>(snapshot: Snapshot, values: readonly Value[], add: (snapshot: Snapshot, value: Value) => Result.Result<Snapshot, SetupError>): Result.Result<Snapshot, SetupError> => values.reduce<Result.Result<Snapshot, SetupError>>((current, value) => Result.flatMap(current, (state) => add(state, value)), Result.succeed(snapshot))

/** Register a complete plugin declaration before any resource effect runs. */
export const registerPlugin = (snapshot: Snapshot, plugin: RouterPlugin<string, unknown>): Result.Result<Snapshot, SetupError> =>
  Result.gen(function* () {
    if (HashSet.has(snapshot.ids, plugin.id)) return yield* Result.fail(duplicate("plugin", plugin.id))
    const withCapabilities = yield* addMany(snapshot, plugin.capabilities ?? [], addCapability)
    const withDeployments = yield* addMany(withCapabilities, plugin.deployments ?? [], addDeployment)
    const withPolicies = yield* addMany(withDeployments, plugin.policies ?? [], addPolicy)
    const withMiddleware = yield* addMany(withPolicies, plugin.middleware ?? [], addMiddleware)
    const withPipelines = yield* addMany(withMiddleware, plugin.pipelines ?? [], addPipeline)
    const state = yield* addMany(withPipelines, plugin.projections ?? [], addProjection)
    const fragment = plugin.http?.api as HttpApi.Top | undefined
    const http = fragment ? yield* addHttp(state, fragment) : { groupIds: state.groupIds, httpPaths: state.httpPaths }
    return {
      ...state,
      ...http,
      ids: HashSet.add(state.ids, plugin.id),
      api: fragment ? state.api.addHttpApi(fragment) : state.api,
    }
  })

export const addRoute = (snapshot: Snapshot, route: ModelRoute): Result.Result<Snapshot, SetupError> => (HashMap.has(snapshot.routes, route.model) ? Result.fail(SetupError.cases.InvalidRoute.make({ model: route.model, message: "Duplicate model route" })) : route.deployments.length === 0 || HashSet.size(HashSet.fromIterable(route.deployments)) !== route.deployments.length || route.deployments.some((id) => !HashMap.has(snapshot.deployments, id)) || (route.policy !== undefined && !HashMap.has(snapshot.policies, route.policy)) ? Result.fail(SetupError.cases.InvalidRoute.make({ model: route.model, message: "Unknown or duplicate deployment or policy" })) : Result.succeed({ ...snapshot, routes: HashMap.set(snapshot.routes, route.model, route) }))

export const validatePipelines = (snapshot: Snapshot): Result.Result<void, SetupError> =>
  snapshot.pipelines.reduce<Result.Result<void, SetupError>>(
    (current, pipeline) =>
      Result.flatMap(current, () => {
        const deployment = HashMap.get(snapshot.deployments, pipeline.deployment)
        return deployment._tag === "Some" && deployment.value.protocol === pipeline.target ? Result.succeed(void 0) : Result.fail(SetupError.cases.InvalidRoute.make({ model: pipeline.deployment, message: `Invalid direct pipeline ${pipeline.id}` }))
      }),
    Result.succeed(void 0),
  )

export const layer = (snapshot: Snapshot): Layer.Layer<Registry> => Layer.succeed(Registry, snapshot)
