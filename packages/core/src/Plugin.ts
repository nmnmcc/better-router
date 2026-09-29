import { Schema } from "effect"
import type { Effect, Scope } from "effect"
import type { HttpApi } from "effect/unstable/httpapi"
import type { Capability } from "./Capability.js"
import type { Deployment } from "./Deployment.js"
import type { HttpContribution } from "./Http.js"
import type { Router } from "./Router.js"
import type { RoutingPolicy } from "./Routing.js"
import type { DirectPipeline, Middleware } from "./Pipeline.js"
import type { ProtocolDefinition } from "./Projection.js"
import type { IdOf, ItemsOf, ItemIdsOf } from "./Identifier.js"

class DuplicateId extends Schema.TaggedError<DuplicateId>()("DuplicateId", {
	kind: Schema.Literals([
		"plugin",
		"capability",
		"deployment",
		"pipeline",
		"projection",
		"policy",
		"middleware",
		"http_group",
	]),
	id: Schema.String,
}) {}

class DuplicateHttpRoute extends Schema.TaggedError<DuplicateHttpRoute>()("DuplicateHttpRoute", {
	method: Schema.String,
	path: Schema.String,
}) {}

class InvalidRoute extends Schema.TaggedError<InvalidRoute>()("InvalidRoute", {
	model: Schema.String,
	message: Schema.String,
}) {}

class PluginStartFailed extends Schema.TaggedError<PluginStartFailed>()("PluginStartFailed", {
	plugin: Schema.String,
	cause: Schema.Defect({ excludeCause: true }),
}) {}

export const SetupError = Schema.Union([
	DuplicateId,
	DuplicateHttpRoute,
	InvalidRoute,
	PluginStartFailed,
]).pipe(Schema.toTaggedUnion("_tag"))

export type SetupError = typeof SetupError.Type

/** A plugin is a declaration, not a command to register capabilities. */
export interface RouterPlugin<
	Id extends string = string,
	Requirements = never,
	Api extends HttpApi.Constraint = HttpApi.Constraint,
	Deployments extends readonly Deployment<Requirements>[] = readonly Deployment<Requirements>[],
	Policies extends readonly RoutingPolicy[] = readonly RoutingPolicy[],
	Pipelines extends readonly DirectPipeline<Requirements>[] =
		readonly DirectPipeline<Requirements>[],
	Projections extends readonly ProtocolDefinition[] = readonly ProtocolDefinition[],
	Capabilities extends readonly Capability[] = readonly Capability[],
	Middlewares extends readonly Middleware<Requirements>[] = readonly Middleware<Requirements>[],
> {
	readonly id: Id
	/** Capabilities are registered before projections and resource acquisition. */
	readonly capabilities?: Capabilities
	readonly deployments?: Deployments
	readonly policies?: Policies
	readonly middleware?: Middlewares
	readonly pipelines?: Pipelines
	readonly projections?: Projections
	readonly http?: HttpContribution<Api, Requirements>
	/** Resource acquisition only; capabilities above remain declared statically. */
	readonly start?: (router: Router) => Effect.Effect<void, SetupError, Requirements | Scope.Scope>
}

type PluginValue<Plugins> = Plugins extends readonly unknown[] ? Plugins[number] : Plugins

export type PluginIds<Plugins> = IdOf<PluginValue<Plugins>>
export type PluginDeployments<Plugins> = ItemsOf<PluginValue<Plugins>, "deployments">
export type PluginDeploymentIds<Plugins> = ItemIdsOf<PluginValue<Plugins>, "deployments">
export type PluginPolicies<Plugins> = ItemsOf<PluginValue<Plugins>, "policies">
export type PluginPolicyIds<Plugins> = ItemIdsOf<PluginValue<Plugins>, "policies">
export type PluginPipelines<Plugins> = ItemsOf<PluginValue<Plugins>, "pipelines">
export type PluginPipelineIds<Plugins> = ItemIdsOf<PluginValue<Plugins>, "pipelines">
export type PluginProjections<Plugins> = ItemsOf<PluginValue<Plugins>, "projections">
export type PluginProjectionIds<Plugins> = ItemIdsOf<PluginValue<Plugins>, "projections">
export type PluginCapabilities<Plugins> = ItemsOf<PluginValue<Plugins>, "capabilities">
export type PluginCapabilityIds<Plugins> = ItemIdsOf<PluginValue<Plugins>, "capabilities">
export type PluginMiddlewares<Plugins> = ItemsOf<PluginValue<Plugins>, "middleware">
export type PluginMiddlewareIds<Plugins> = ItemIdsOf<PluginValue<Plugins>, "middleware">

export type PluginCapabilityReferences<Plugins> =
	PluginProjections<Plugins> extends infer Projection
		? Projection extends { readonly capability: infer Capability extends string }
			? Capability
			: never
		: never

export type PluginDeploymentProtocols<Plugins> =
	PluginDeployments<Plugins> extends infer Deployment
		? Deployment extends { readonly protocol: infer Protocol extends string }
			? Protocol
			: never
		: never

/** Protocols declared by either a projection or a deployment. */
export type PluginProtocolIds<Plugins> =
	| (PluginProjections<Plugins> extends infer Projection
			? Projection extends { readonly protocol: infer Protocol extends string }
				? Protocol
				: never
			: never)
	| PluginDeploymentProtocols<Plugins>

export type PluginId<Plugin> = IdOf<Plugin>

export type PluginRequirements<Plugin> =
	Plugin extends RouterPlugin<string, infer Requirements, HttpApi.Constraint>
		? Requirements
		: never
