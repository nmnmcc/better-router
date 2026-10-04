import type { Layer } from "effect"
import type { HttpApi } from "effect/http-api"
import type { Service as RouteService } from "./Route.js"

/** A protocol owns this contract and its handler layer. Core only composes them. */
export interface Contract<Api extends HttpApi.Constraint = HttpApi.Constraint, Requirements = any> {
	readonly api: Api
	readonly layer: (route: RouteService) => Layer.Layer<never, any, Requirements>
}

export type Definition<
	Api extends HttpApi.Constraint = HttpApi.Constraint,
	Requirements = any,
> = Contract<Api, Requirements>

export const make = <Api extends HttpApi.Constraint, Requirements>(
	definition: Definition<Api, Requirements>,
): Definition<Api, Requirements> => definition
