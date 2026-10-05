import { Effect } from "effect"
import type { GenerationEvent, GenerationRequest, GenerationResponse } from "./Generation.js"
import type { DeploymentRef } from "./Policies.js"

export interface RequestHookContext {
	readonly request: GenerationRequest
	readonly model: string
	readonly metadata: Readonly<Record<string, string>>
	readonly signals: Readonly<Record<string, unknown>>
}

export interface AttemptHookContext extends RequestHookContext {
	readonly deployment: DeploymentRef
	readonly attempt: number
}

export interface ResponseHookContext extends RequestHookContext {
	readonly response: GenerationResponse
	readonly deployment?: DeploymentRef
	readonly attempt?: number
}

export interface SuccessHookContext extends AttemptHookContext {
	readonly response: GenerationResponse
}

export interface RequestErrorHookContext<ErrorType = unknown> extends RequestHookContext {
	readonly error: ErrorType
	readonly firstEventObserved: boolean
}

export interface ErrorHookContext<ErrorType = unknown> extends AttemptHookContext {
	readonly error: ErrorType
	readonly firstEventObserved: boolean
}

export interface FinalizeHookContext<ErrorType = unknown> extends AttemptHookContext {
	readonly outcome: "success" | "failure" | "cancelled"
	readonly error?: ErrorType
}

export type HookEffect<Context, ErrorType = never, Requirements = never> = (
	context: Context,
) => Effect.Effect<void, ErrorType, Requirements>

export interface HookSet<ErrorType = never, Requirements = never> {
	readonly beforeRequest?:
		readonly HookEffect<RequestHookContext, ErrorType, Requirements>[] | undefined
	readonly beforeAttempt?:
		readonly HookEffect<AttemptHookContext, ErrorType, Requirements>[] | undefined
	readonly afterResponse?:
		readonly HookEffect<ResponseHookContext, ErrorType, Requirements>[] | undefined
	readonly afterSuccess?:
		readonly HookEffect<SuccessHookContext, ErrorType, Requirements>[] | undefined
	readonly afterFailure?:
		readonly HookEffect<ErrorHookContext<ErrorType>, ErrorType, Requirements>[] | undefined
	readonly onError?:
		| readonly HookEffect<RequestErrorHookContext<ErrorType>, ErrorType, Requirements>[]
		| undefined
	readonly onStreamEvent?:
		| readonly HookEffect<
				AttemptHookContext & { readonly event: GenerationEvent },
				ErrorType,
				Requirements
		  >[]
		| undefined
	readonly onCancel?:
		readonly HookEffect<RequestHookContext, ErrorType, Requirements>[] | undefined
	readonly onFinalize?:
		readonly HookEffect<FinalizeHookContext<ErrorType>, ErrorType, Requirements>[] | undefined
}

const run = <Context, ErrorType, Requirements>(
	hooks: readonly HookEffect<Context, ErrorType, Requirements>[] | undefined,
	context: Context,
): Effect.Effect<void, ErrorType, Requirements> =>
	hooks === undefined
		? Effect.void
		: Effect.forEach(hooks, (hook) => hook(context), { discard: true })

export const runBeforeRequest = <ErrorType, Requirements>(
	hooks: HookSet<ErrorType, Requirements>,
	context: RequestHookContext,
): Effect.Effect<void, ErrorType, Requirements> => run(hooks.beforeRequest, context)

export const runBeforeAttempt = <ErrorType, Requirements>(
	hooks: HookSet<ErrorType, Requirements>,
	context: AttemptHookContext,
): Effect.Effect<void, ErrorType, Requirements> => run(hooks.beforeAttempt, context)

export const runAfterResponse = <ErrorType, Requirements>(
	hooks: HookSet<ErrorType, Requirements>,
	context: ResponseHookContext,
): Effect.Effect<void, ErrorType, Requirements> => run(hooks.afterResponse, context)

export const runAfterSuccess = <ErrorType, Requirements>(
	hooks: HookSet<ErrorType, Requirements>,
	context: SuccessHookContext,
): Effect.Effect<void, ErrorType, Requirements> => run(hooks.afterSuccess, context)

export const runAfterFailure = <ErrorType, Requirements>(
	hooks: HookSet<ErrorType, Requirements>,
	context: ErrorHookContext<ErrorType>,
): Effect.Effect<void, ErrorType, Requirements> => run(hooks.afterFailure, context)

export const runOnError = <ErrorType, Requirements>(
	hooks: HookSet<ErrorType, Requirements>,
	context: RequestErrorHookContext<ErrorType>,
): Effect.Effect<void, ErrorType, Requirements> => run(hooks.onError, context)

export const runOnStreamEvent = <ErrorType, Requirements>(
	hooks: HookSet<ErrorType, Requirements>,
	context: AttemptHookContext & { readonly event: GenerationEvent },
): Effect.Effect<void, ErrorType, Requirements> => run(hooks.onStreamEvent, context)

export const runOnCancel = <ErrorType, Requirements>(
	hooks: HookSet<ErrorType, Requirements>,
	context: RequestHookContext,
): Effect.Effect<void, ErrorType, Requirements> => run(hooks.onCancel, context)

export const runOnFinalize = <ErrorType, Requirements>(
	hooks: HookSet<ErrorType, Requirements>,
	context: FinalizeHookContext<ErrorType>,
): Effect.Effect<void, ErrorType, Requirements> => run(hooks.onFinalize, context)

/** Combine contributions while preserving declaration order for every hook. */
export const compose = <ErrorType, Requirements>(
	hooks: readonly HookSet<ErrorType, Requirements>[],
): HookSet<ErrorType, Requirements> => ({
	beforeRequest: hooks.flatMap((value) => value.beforeRequest ?? []),
	beforeAttempt: hooks.flatMap((value) => value.beforeAttempt ?? []),
	afterResponse: hooks.flatMap((value) => value.afterResponse ?? []),
	afterSuccess: hooks.flatMap((value) => value.afterSuccess ?? []),
	afterFailure: hooks.flatMap((value) => value.afterFailure ?? []),
	onError: hooks.flatMap((value) => value.onError ?? []),
	onStreamEvent: hooks.flatMap((value) => value.onStreamEvent ?? []),
	onCancel: hooks.flatMap((value) => value.onCancel ?? []),
	onFinalize: hooks.flatMap((value) => value.onFinalize ?? []),
})

export const Hooks = {
	compose,
	runBeforeRequest,
	runBeforeAttempt,
	runAfterResponse,
	runAfterSuccess,
	runAfterFailure,
	runOnError,
	runOnStreamEvent,
	runOnCancel,
	runOnFinalize,
}
