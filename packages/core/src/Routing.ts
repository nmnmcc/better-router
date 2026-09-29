import { Schema } from "effect"
import type { Effect } from "effect"
import type { DeploymentId, DeploymentRef } from "./Deployment.js"
import type { GenerationRequest, ModelAlias } from "./Generation.js"
import type { Identifier } from "./Identifier.js"

export interface ModelRoute<
	Deployment extends string = string,
	Policy extends string = string,
	Model extends string = string,
> {
	readonly model: ModelAlias<Model>
	/** Listed order is fallback order when no policy is selected. */
	readonly deployments: readonly DeploymentId<Deployment>[]
	readonly policy?: Identifier<Policy>
}

export type RouteModels<Routes> = Routes extends readonly (infer Route)[]
	? Route extends { readonly model: infer Model extends string }
		? Model
		: never
	: never

export type DuplicateRouteModels<
	Routes extends readonly { readonly model: string }[],
	Seen extends string = never,
> = Routes extends readonly [
	infer Head extends { readonly model: string },
	...infer Tail extends readonly { readonly model: string }[],
]
	? string extends Head["model"]
		? DuplicateRouteModels<Tail, Seen>
		: [Extract<Head["model"], Seen>] extends [never]
			? DuplicateRouteModels<Tail, Seen | Head["model"]>
			: Extract<Head["model"], Seen> | DuplicateRouteModels<Tail, Seen | Head["model"]>
	: never

export class RoutingError extends Schema.TaggedError<RoutingError>()("RoutingError", {
	message: Schema.String,
	cause: Schema.optional(Schema.Defect({ excludeCause: true })),
}) {}

export interface RoutingPolicy<Id extends string = string> {
	readonly id: Identifier<Id>
	/** Return an ordered subset of candidates; do not introduce new deployments. */
	readonly rank: (
		request: GenerationRequest,
		candidates: readonly DeploymentRef[],
	) => Effect.Effect<readonly DeploymentRef[], RoutingError>
}
