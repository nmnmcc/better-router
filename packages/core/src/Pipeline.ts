import { Schema, Stream } from "effect"
import type { Effect } from "effect"
import type { ProviderError } from "./Deployment.js"
import type { Execution } from "./Execution.js"
import type { Command } from "./Projection.js"
import type { RouterError } from "./Router.js"
import type { InvocationOptions } from "./Deployment.js"
import type { Identifier } from "./Identifier.js"

export const ProtocolRequest = Schema.Struct({
	protocol: Schema.NonEmptyString,
	model: Schema.NonEmptyString,
	body: Schema.Unknown,
	headers: Schema.Record(Schema.String, Schema.String),
})

export type ProtocolRequest = typeof ProtocolRequest.Type

export interface SelectedRequest extends ProtocolRequest {
	readonly targetModel: string
}

export interface ProtocolResponse {
	readonly status: number
	readonly headers: Readonly<Record<string, string>>
	readonly body: Stream.Stream<Uint8Array, ProviderError>
}

/** The implementation may convert directly from any declared ingress protocol. */
export interface DirectPipeline<
	Requirements = never,
	Id extends string = string,
	DeploymentId extends string = string,
	Source extends string = string,
	Target extends string = string,
> {
	readonly id: Identifier<Id>
	readonly deployment: Identifier<DeploymentId>
	readonly source: Identifier<Source>
	readonly target: Identifier<Target>
	readonly execute: (
		request: SelectedRequest,
	) => Effect.Effect<ProtocolResponse, ProviderError, Requirements>
}

export type DirectPipelineFor<
	Requirements,
	Deployment extends {
		readonly id: string
		readonly protocol: string
		readonly execute: { readonly direct?: (...args: never[]) => unknown }
	},
> = DirectPipeline<
	Requirements,
	`${Deployment["id"]}:direct`,
	Deployment["id"],
	Deployment["protocol"],
	Deployment["protocol"]
>

/** Middleware wraps the entire invocation, including opaque direct execution. */
export type Handler<Requirements = never> = (
	command: Command,
	options?: InvocationOptions,
) => Effect.Effect<Execution, RouterError, Requirements>

export interface Middleware<Requirements = never, Id extends string = string> {
	readonly id: Identifier<Id>
	readonly wrap: <R>(next: Handler<R>) => Handler<R | Requirements>
}
