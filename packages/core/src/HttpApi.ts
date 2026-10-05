import { Context, Effect, Layer, Schema, SchemaIssue, Scope, Stream } from "effect"
import type { FileSystem, Path } from "effect"
import { Etag, HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import type {
	HttpContext,
	HttpContribution,
	HttpContractContribution,
	HttpEndpointContribution,
	HttpHandler,
} from "./PluginContributions.js"
import type { Service as RouteService } from "./Route.js"
import { Error as RouteError } from "./Route.js"
import { Error as ProviderError } from "./Provider.js"
import { ConversionError } from "./Convert.js"
import { ProcessError } from "./GenerationProcess.js"
import { Error as RoutingError } from "./Routing.js"
import { Error as RuntimeError } from "./RoutingRuntime.js"

/** The public error shape used by direct, schema-backed HTTP contributions. */
export interface HttpIssue {
	readonly path: readonly (string | number)[]
	readonly message: string
}

export interface HttpErrorBody {
	readonly error: {
		readonly message: string
		readonly type: string
		readonly param?: string
		readonly issues?: readonly HttpIssue[]
	}
}

/** Typed public failure for direct HTTP handlers and authentication middleware. */
export class Failure extends Schema.TaggedError<Failure>()("RouterHttpFailure", {
	status: Schema.Int.check(Schema.isGreaterThanOrEqualTo(400), Schema.isLessThan(600)),
	message: Schema.String,
	type: Schema.String,
	param: Schema.optional(Schema.String),
}) {}

/** Bound inline protocol bodies while preserving streaming cancellation. */
export const defaultMaxBodyBytes = 64 * 1024 * 1024

/** Parse the case-insensitive Bearer scheme without accepting combined credentials. */
export const hasBearerCredential = (
	authorization: string | undefined,
	credential: string,
): boolean => {
	const match = /^Bearer +([^\s,]+)$/i.exec(authorization ?? "")
	return match?.[1] === credential
}

const bodyLimit = Schema.Int.check(
	Schema.isGreaterThan(0),
	Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)

/** Read JSON through a bounded stream for both native and Web HTTP requests. */
export const readJson = (
	request: HttpServerRequest.HttpServerRequest,
	maxBodyBytes: number = defaultMaxBodyBytes,
): Effect.Effect<Schema.Json, Failure> =>
	Effect.gen(function* () {
		const limit = yield* Schema.decodeUnknownEffect(bodyLimit)(maxBodyBytes).pipe(
			Effect.mapError(() =>
				Failure.make({
					status: 500,
					message: "Invalid request body limit",
					type: "internal_error",
				}),
			),
		)
		const body = yield* Stream.runFoldEffect(
			request.stream,
			() => ({ size: 0, chunks: [] as readonly Uint8Array[] }),
			(state, chunk) =>
				state.size + chunk.byteLength > limit
					? Effect.fail(
							Failure.make({
								status: 413,
								message: "Request body too large",
								type: "invalid_request_error",
							}),
						)
					: Effect.succeed({
							size: state.size + chunk.byteLength,
							chunks: [...state.chunks, chunk],
						}),
		).pipe(
			Effect.mapError((error) =>
				Schema.is(Failure)(error)
					? error
					: Failure.make({
							status: 400,
							message: "Invalid JSON body",
							type: "invalid_request_error",
						}),
			),
		)
		const bytes = Uint8Array.from(body.chunks.flatMap((chunk) => Array.from(chunk)))
		const text = yield* Effect.try({
			try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			catch: () =>
				Failure.make({
					status: 400,
					message: "Invalid JSON body",
					type: "invalid_request_error",
				}),
		})
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
			Effect.mapError(() =>
				Failure.make({
					status: 400,
					message: "Invalid JSON body",
					type: "invalid_request_error",
				}),
			),
		)
	})

/** All protocol adapters use the same gateway status mapping. */
export const statusForError = (error: unknown): number => {
	if (Schema.is(RuntimeError)(error))
		return error.kind === "capacity" || error.kind === "rate_limit" || error.kind === "budget"
			? 429
			: error.kind === "token_limit" || error.kind === "invalid"
				? 400
				: 500
	if (Schema.is(RoutingError)(error))
		return error._tag === "RoutingAccessDenied"
			? 403
			: error._tag === "RoutingNoCandidates" || error._tag === "RoutingFallbackExhausted"
				? 503
				: 500
	if (Schema.is(RouteError)(error))
		return error._tag === "RouteUnknownModel"
			? 404
			: error._tag === "RouteInvalidRequest"
				? 400
				: 502
	if (Schema.is(ProviderError)(error))
		return error.kind === "rate_limited"
			? 429
			: error.kind === "timeout"
				? 504
				: error.kind === "unavailable"
					? 503
					: error.kind === "invalid_request"
						? 400
						: error.kind === "unsupported"
							? 422
							: 502
	if (Schema.is(ConversionError)(error)) return 422
	if (Schema.is(Failure)(error)) return error.status
	return 500
}

/** Never include opaque causes or arbitrary exception messages in wire errors. */
export const messageForError = (error: unknown): string => {
	if (Schema.is(RuntimeError)(error))
		return error.kind === "budget"
			? "Request budget exceeded"
			: error.kind === "capacity"
				? "Deployment concurrency limit exceeded"
				: error.kind === "rate_limit"
					? "Deployment rate limit exceeded"
					: error.kind === "token_limit"
						? "Request token limit exceeded"
						: error.kind === "invalid"
							? "Invalid runtime request"
							: "Routing runtime failed"
	if (Schema.is(RoutingError)(error))
		return error._tag === "RoutingAccessDenied"
			? "Access to model denied"
			: error._tag === "RoutingNoCandidates"
				? `No deployments available for model: ${error.model}`
				: error._tag === "RoutingFallbackExhausted"
					? `Deployments exhausted for model: ${error.model}`
					: error._tag === "RoutingPolicyFailed"
						? "Routing policy failed"
						: "Routing failed"
	if (Schema.is(RouteError)(error))
		return error._tag === "RouteUnknownModel"
			? `Unknown model: ${error.model}`
			: error._tag === "RouteInvalidRequest"
				? "Invalid generation request"
				: error._tag === "RouteHandlerFailed"
					? "Route handler failed"
					: "Route failed"
	if (Schema.is(ProviderError)(error)) return error.message
	if (Schema.is(ConversionError)(error))
		return `Cannot project generation output at ${error.path}`
	if (Schema.is(ProcessError)(error)) return "Generation ended without a terminal response"
	if (Schema.is(Failure)(error)) return error.message
	return "Gateway failed"
}

export const paramForError = (error: unknown): string | undefined => {
	if (Schema.is(ConversionError)(error)) return error.path
	if (Schema.is(Failure)(error)) return error.param
	if (Schema.is(RouteError)(error) && error._tag === "RouteInvalidRequest")
		return error.issues?.[0]?.path.join(".")
	return undefined
}

/** Host services required by the Effect HTTP API adapter. */
export type HttpHostServices =
	| HttpRouter.HttpRouter
	| Etag.Generator
	| FileSystem.FileSystem
	| HttpPlatform.HttpPlatform
	| Path.Path

type FunctionRequirements<Value> = Value extends (
	...args: any[]
) => Effect.Effect<any, any, infer R>
	? R
	: never

type MiddlewareRequirements<Contribution> = Contribution extends {
	readonly middleware?: readonly import("./PluginContributions.js").HttpMiddleware<infer R>[]
}
	? R
	: never

type HttpRequirements<Contribution> =
	Contribution extends HttpContractContribution<any, infer R>
		? R
		: Contribution extends {
					readonly input: infer Input extends Schema.Constraint
					readonly output: infer Output extends Schema.Constraint
					readonly handler: infer Handler
			  }
			? | FunctionRequirements<Handler>
				| MiddlewareRequirements<Contribution>
				| Input["DecodingServices"]
				| Output["EncodingServices"]
			: never

export type Requirements<Contributions extends readonly HttpContribution<any, any>[]> =
	HttpRequirements<Contributions[number]>

const hopByHop = [
	"connection",
	"keep-alive",
	"proxy-connection",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
	"authorization",
	"x-api-key",
	"host",
	"content-length",
] as const

/** Strip gateway credentials and transport headers before forwarding upstream. */
export const filterForwardHeaders = (
	headers: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> => {
	const connectionHeaders = Object.entries(headers)
		.filter(([name]) => name.toLowerCase() === "connection")
		.flatMap(([, value]) => value.split(",").map((name) => name.trim().toLowerCase()))
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => {
			const normalized = name.toLowerCase()
			return (
				!(hopByHop as readonly string[]).includes(normalized) &&
				!connectionHeaders.includes(normalized)
			)
		}),
	)
}

const pathOf = (url: string): string => {
	if (URL.canParse(url)) return new URL(url).pathname
	const query = url.indexOf("?")
	return query < 0 ? url || "/" : url.slice(0, query) || "/"
}

const issuePath = (path: readonly unknown[] | undefined): readonly (string | number)[] =>
	(path ?? []).map((segment) =>
		typeof segment === "number"
			? segment
			: typeof segment === "string"
				? segment
				: String(segment),
	)

const schemaIssues = (error: Schema.SchemaError): readonly HttpIssue[] =>
	SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues.map((issue) => ({
		path: issuePath(issue.path),
		message: issue.message,
	}))

const schemaErrorResponse = (
	error: Schema.SchemaError,
	status: number,
	message: string,
): HttpServerResponse.HttpServerResponse => {
	const issues = schemaIssues(error)
	const first = issues[0]
	const param = first === undefined ? undefined : first.path.join(".")
	const body: HttpErrorBody = {
		error: {
			message,
			type: status === 400 ? "invalid_request_error" : "invalid_response_error",
			...(param === undefined || param.length === 0 ? {} : { param }),
			issues,
		},
	}
	return HttpServerResponse.jsonUnsafe(body, { status })
}

const internalError = (): HttpServerResponse.HttpServerResponse =>
	HttpServerResponse.jsonUnsafe(
		{
			error: {
				message: "HTTP handler failed",
				type: "internal_error",
			},
		},
		{ status: 500 },
	)

const isPublicFailure = (error: unknown): boolean =>
	Schema.is(Failure)(error) ||
	Schema.is(ProviderError)(error) ||
	Schema.is(RouteError)(error) ||
	Schema.is(RoutingError)(error) ||
	Schema.is(RuntimeError)(error) ||
	Schema.is(ConversionError)(error) ||
	Schema.is(ProcessError)(error)

const handlerErrorResponse = (error: unknown): HttpServerResponse.HttpServerResponse => {
	if (HttpServerResponse.isHttpServerResponse(error)) return error
	if (!isPublicFailure(error)) return internalError()
	const param = paramForError(error)
	return HttpServerResponse.jsonUnsafe(
		{
			error: {
				message: messageForError(error),
				type: Schema.is(Failure)(error) ? error.type : "gateway_error",
				...(param === undefined ? {} : { param }),
			},
		},
		{ status: statusForError(error) },
	)
}

const contextOf = (request: HttpServerRequest.HttpServerRequest): HttpContext => ({
	method: request.method,
	path: pathOf(request.url),
	headers: { ...request.headers },
})

const isContractContribution = (
	contribution: HttpContribution<any, any>,
): contribution is HttpContractContribution<any, any> => "contract" in contribution

const directHandler = (
	contribution: HttpEndpointContribution<any, any, any>,
): ((
	request: HttpServerRequest.HttpServerRequest,
) => Effect.Effect<HttpServerResponse.HttpServerResponse, never, any>) => {
	const decode = Schema.decodeUnknownEffect(contribution.input, {
		onExcessProperty: "error",
	})
	const encode = Schema.encodeUnknownEffect(contribution.output)
	const wrapped = (contribution.middleware ?? []).reduceRight<HttpHandler<any>>(
		(next, middleware) => middleware.wrap(next) as HttpHandler<any>,
		contribution.handler as HttpHandler<any>,
	)
	return (request) =>
		Effect.gen(function* () {
			const body =
				request.method === "GET" ||
				request.method === "HEAD" ||
				request.method === "OPTIONS"
					? Effect.succeed(
							Object.fromEntries(
								new URL(request.url, "http://localhost").searchParams,
							),
						)
					: readJson(request).pipe(Effect.mapError(handlerErrorResponse))
			const value = yield* body
			const input = yield* decode(value).pipe(
				Effect.mapError((error) => schemaErrorResponse(error, 400, "Invalid request")),
			)
			const output = yield* wrapped(input, contextOf(request)).pipe(
				Effect.mapError(handlerErrorResponse),
			)
			const encoded = yield* encode(output).pipe(
				Effect.mapError((error) => schemaErrorResponse(error, 500, "Invalid response")),
			)
			return yield* HttpServerResponse.json(encoded).pipe(
				Effect.mapError(() => internalError()),
			)
		}).pipe(
			Effect.catch((error) => Effect.succeed(error)),
			Effect.catchDefect(() => Effect.succeed(internalError())),
		)
}

const directLayer = (
	contribution: HttpEndpointContribution<any, any, any>,
): Layer.Layer<never, never, HttpRouter.HttpRouter | any> =>
	HttpRouter.use((router) =>
		Effect.gen(function* () {
			const environment = (yield* Effect.context<any>()).pipe(Context.omit(Scope.Scope))
			const handler = directHandler(contribution)
			yield* router.add(
				contribution.method.toUpperCase() as Parameters<HttpRouter.HttpRouter["add"]>[0],
				contribution.path as `/${string}`,
				(request) => handler(request).pipe(Effect.provideContext(environment)),
			)
		}),
	)

/**
 * Mount all plugin HTTP contributions into the host router.
 *
 * Contract contributions delegate to their protocol-owned typed HttpApi layer;
 * direct contributions are decoded and encoded here, so malformed input and
 * handler failures become public JSON errors without exposing defects.
 */
export const layer = <const Contributions extends readonly HttpContribution<any, any>[]>(
	contributions: Contributions,
	route: RouteService,
): Layer.Layer<never, unknown, HttpHostServices | Requirements<Contributions>> => {
	const layers = contributions.map((contribution) =>
		isContractContribution(contribution)
			? (contribution.contract.layer(route) as Layer.Layer<
					never,
					unknown,
					HttpRouter.HttpRouter
				>)
			: directLayer(contribution),
	)
	return (
		layers.length === 0
			? Layer.empty
			: Layer.mergeAll(
					...(layers as [
						Layer.Layer<never, unknown, any>,
						...Layer.Layer<never, unknown, any>[],
					]),
				)
	) as Layer.Layer<never, unknown, HttpHostServices | Requirements<Contributions>>
}

export const HttpApi = {
	layer,
}
