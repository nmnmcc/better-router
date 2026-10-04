import { Context, Effect, HashSet, Layer, Result } from "effect"
import { HttpApi } from "effect/http-api"
import { generation } from "./Capability.js"
import type { Capability } from "./Capability.js"
import type { Contract } from "./Api.js"
import {
	DuplicateHttpRoute,
	DuplicateId,
	MultipleRoutes,
	PluginStartFailed,
	SetupError,
	validate,
} from "./Plugin.js"
import type { AnyPlugin, PluginContext } from "./Plugin.js"
import type { AnyLayer, RouteLayer } from "./State.js"

/** The immutable declaration registry available to startup hooks and hosts. */
export interface Snapshot {
	readonly plugins: readonly AnyPlugin[]
	readonly capabilities: readonly Capability[]
	readonly providers: readonly AnyLayer[]
	readonly apis: readonly Contract[]
	readonly route: RouteLayer | undefined
	readonly ids: HashSet.HashSet<string>
	readonly capabilityIds: HashSet.HashSet<string>
	readonly groupIds: HashSet.HashSet<string>
	readonly httpPaths: HashSet.HashSet<string>
	readonly api: HttpApi.Top
}

export interface Extensions {
	readonly route?: RouteLayer | undefined
	readonly providers?: readonly AnyLayer[] | undefined
	readonly apis?: readonly Contract[] | undefined
}

export class Registry extends Context.Service<Registry, Snapshot>()("BetterRouterRegistry") {}

export const empty = (): Snapshot => ({
	plugins: [],
	capabilities: [generation],
	providers: [],
	apis: [],
	route: undefined,
	ids: HashSet.empty(),
	capabilityIds: HashSet.make(generation.id),
	groupIds: HashSet.empty(),
	httpPaths: HashSet.empty(),
	api: HttpApi.make("better-router") as unknown as HttpApi.Top,
})

const duplicate = (kind: "plugin" | "capability" | "http_group", id: string) =>
	DuplicateId.make({ kind, id })

const routeId = (route: RouteLayer): string => String(route)

const httpEntries = (fragment: HttpApi.Top) =>
	Object.values(fragment.groups).flatMap((group) =>
		Object.values(group.endpoints).map((endpoint) => ({
			group: group.identifier,
			path: `${endpoint.method} ${endpoint.path}`,
		})),
	)

const httpFragment = (apis: readonly Contract[]): HttpApi.Top =>
	apis.reduce<HttpApi.Top>(
		(current, contract) => current.addHttpApi(contract.api as HttpApi.Top),
		HttpApi.make("better-router") as unknown as HttpApi.Top,
	)

const addHttp = (
	snapshot: Snapshot,
	fragment: HttpApi.Top,
): Result.Result<Pick<Snapshot, "groupIds" | "httpPaths" | "api">, SetupError> => {
	const groups = Object.values(fragment.groups)
	const groupsResult = groups.reduce<Result.Result<HashSet.HashSet<string>, SetupError>>(
		(current, group) =>
			Result.flatMap(current, (seen) =>
				HashSet.has(snapshot.groupIds, group.identifier) ||
				HashSet.has(seen, group.identifier)
					? Result.fail(duplicate("http_group", group.identifier))
					: Result.succeed(HashSet.add(seen, group.identifier)),
			),
		Result.succeed(HashSet.empty()),
	)
	return Result.gen(function* () {
		const addedGroups = yield* groupsResult
		const paths = yield* httpEntries(fragment).reduce<
			Result.Result<HashSet.HashSet<string>, SetupError>
		>(
			(current, entry) =>
				Result.flatMap(current, (seen) =>
					HashSet.has(snapshot.httpPaths, entry.path) || HashSet.has(seen, entry.path)
						? Result.fail(
								DuplicateHttpRoute.make({
									method: entry.path.split(" ", 1)[0] ?? "",
									path: entry.path.slice(entry.path.indexOf(" ") + 1),
								}),
							)
						: Result.succeed(HashSet.add(seen, entry.path)),
				),
			Result.succeed(HashSet.empty()),
		)
		return {
			groupIds: HashSet.union(snapshot.groupIds, addedGroups),
			httpPaths: HashSet.union(snapshot.httpPaths, paths),
			api: snapshot.api.addHttpApi(fragment),
		}
	})
}

const addCapabilities = (
	snapshot: Snapshot,
	capabilities: readonly Capability[],
): Result.Result<Snapshot, SetupError> =>
	capabilities.reduce<Result.Result<Snapshot, SetupError>>(
		(current, capability) =>
			Result.flatMap(current, (state) =>
				HashSet.has(state.capabilityIds, capability.id)
					? Result.fail(duplicate("capability", capability.id))
					: Result.succeed({
							...state,
							capabilities: [...state.capabilities, capability],
							capabilityIds: HashSet.add(state.capabilityIds, capability.id),
						}),
			),
		Result.succeed(snapshot),
	)

/** Register one complete object plugin before any Layer is built. */
export const register = (
	snapshot: Snapshot,
	plugin: AnyPlugin,
): Result.Result<Snapshot, SetupError> =>
	Result.gen(function* () {
		const checked = yield* validate(plugin)
		if (HashSet.has(snapshot.ids, checked.id))
			return yield* Result.fail(duplicate("plugin", checked.id))
		const withCapabilities = yield* addCapabilities(snapshot, checked.capabilities ?? [])
		const state = checked.state
		const providers = state?.providers ?? state?.layers ?? []
		const route = state?.route
		if (withCapabilities.route !== undefined && route !== undefined)
			return yield* Result.fail(
				MultipleRoutes.make({
					first: routeId(withCapabilities.route),
					second: routeId(route),
				}),
			)
		const fragment = state?.apis === undefined ? undefined : httpFragment(state.apis)
		const http = fragment === undefined ? undefined : yield* addHttp(withCapabilities, fragment)
		return {
			...withCapabilities,
			plugins: [...withCapabilities.plugins, checked],
			providers: [...withCapabilities.providers, ...providers],
			apis: [...withCapabilities.apis, ...(state?.apis ?? [])],
			route: withCapabilities.route ?? route,
			ids: HashSet.add(withCapabilities.ids, checked.id),
			...(http ?? {}),
		}
	})

/** Add compatibility declarations to the same immutable snapshot as plugins. */
export const extend = (
	snapshot: Snapshot,
	extensions: Extensions,
): Result.Result<Snapshot, SetupError> =>
	Result.gen(function* () {
		const route = extensions.route
		if (snapshot.route !== undefined && route !== undefined)
			return yield* Result.fail(
				MultipleRoutes.make({
					first: routeId(snapshot.route),
					second: routeId(route),
				}),
			)
		const apis = extensions.apis ?? []
		const http = apis.length === 0 ? undefined : yield* addHttp(snapshot, httpFragment(apis))
		return {
			...snapshot,
			providers: [...snapshot.providers, ...(extensions.providers ?? [])],
			apis: [...snapshot.apis, ...apis],
			route: snapshot.route ?? route,
			...(http ?? {}),
		}
	})

export const registerMany = (
	snapshot: Snapshot,
	plugins: readonly AnyPlugin[],
): Result.Result<Snapshot, SetupError> =>
	plugins.reduce<Result.Result<Snapshot, SetupError>>(
		(current, plugin) => Result.flatMap(current, (state) => register(state, plugin)),
		Result.succeed(snapshot),
	)

export const fromPlugins = (plugins: readonly AnyPlugin[]): Result.Result<Snapshot, SetupError> =>
	registerMany(empty(), plugins)

export const context = (snapshot: Snapshot): PluginContext => ({
	plugins: snapshot.plugins,
	capabilities: snapshot.capabilities,
	providers: snapshot.providers,
	apis: snapshot.apis,
	route: snapshot.route,
})

export const layer = (snapshot: Snapshot): Layer.Layer<Registry> =>
	Layer.succeed(Registry, snapshot)

export const start = (
	snapshot: Snapshot,
): Effect.Effect<void, SetupError, import("effect").Scope.Scope> =>
	Effect.forEach(snapshot.plugins, (plugin) =>
		plugin.init === undefined
			? Effect.void
			: plugin
					.init(context(snapshot))
					.pipe(
						Effect.mapError((cause) =>
							PluginStartFailed.make({ plugin: plugin.id, cause }),
						),
					),
	).pipe(Effect.asVoid)
