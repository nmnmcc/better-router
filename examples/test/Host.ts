import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import { Deferred, Effect, Option, Ref } from "effect"
import type { Scope } from "effect"

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url))
const host = "127.0.0.1"

export interface SeenRequest {
	readonly method: string
	readonly path: string
	readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>
	readonly body: string
}

export type UpstreamResponder = (request: SeenRequest, response: ServerResponse) => void

export interface Upstream {
	readonly url: string
	readonly requests: Ref.Ref<readonly SeenRequest[]>
}

export interface ProcessExit {
	readonly code: number | null
	readonly signal: NodeJS.Signals | null
}

export interface ExampleProcess {
	readonly output: Ref.Ref<readonly string[]>
	readonly awaitExit: Effect.Effect<ProcessExit, Error>
}

export interface GatewayProcess extends ExampleProcess {
	readonly url: string
}

const hostError = (cause: unknown): Error =>
	cause instanceof Error ? cause : new Error(String(cause))

const listen = (server: Server): Effect.Effect<number, Error> =>
	Effect.callback((resume, signal) => {
		const onError = (error: Error): void => resume(Effect.fail(error))
		const onAbort = (): void => {
			server.close(() => undefined)
			server.off("error", onError)
		}
		server.once("error", onError)
		signal.addEventListener("abort", onAbort, { once: true })
		server.listen({ host, port: 0 }, () => {
			server.off("error", onError)
			signal.removeEventListener("abort", onAbort)
			if (signal.aborted) return
			const address = server.address()
			return typeof address === "object" && address !== null
				? resume(Effect.succeed(address.port))
				: resume(Effect.fail(new Error("The local server did not expose a port")))
		})
		return Effect.sync(() => {
			server.off("error", onError)
			signal.removeEventListener("abort", onAbort)
		})
	})

const close = (server: Server): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		if (!server.listening) return resume(Effect.void)
		server.close(() => resume(Effect.void))
		server.closeAllConnections()
	}).pipe(Effect.timeout("2 seconds"), Effect.ignore)

const reservePort = Effect.scoped(
	Effect.acquireRelease(
		Effect.sync(() => createServer()),
		close,
	).pipe(Effect.flatMap(listen)),
)

const bodyFrom = (chunks: readonly Uint8Array[]): string => Buffer.concat(chunks).toString("utf8")

const requestHandler =
	(requests: Ref.Ref<readonly SeenRequest[]>, responder: UpstreamResponder) =>
	(request: IncomingMessage, response: ServerResponse): void => {
		const chunks = Ref.makeUnsafe<readonly Uint8Array[]>([])
		request.on("data", (chunk: Buffer | string) =>
			Effect.runSync(
				Ref.update(chunks, (current) => [
					...current,
					typeof chunk === "string"
						? new TextEncoder().encode(chunk)
						: new Uint8Array(chunk),
				]),
			),
		)
		request.once("end", () => {
			const seen: SeenRequest = {
				method: request.method ?? "",
				path: request.url ?? "",
				headers: Object.fromEntries(
					Object.entries(request.headers).map(([name, value]) => [
						name,
						Array.isArray(value) ? [...value] : value,
					]),
				),
				body: bodyFrom(Ref.getUnsafe(chunks)),
			}
			Effect.runSync(Ref.update(requests, (current) => [...current, seen]))
			responder(seen, response)
		})
		request.once("error", (error) => response.destroy(error))
	}

/** Every test owns its upstream sockets and immutable request history. */
export const upstream = (
	responder: UpstreamResponder,
): Effect.Effect<Upstream, Error, Scope.Scope> =>
	Effect.gen(function* () {
		const requests = yield* Ref.make<readonly SeenRequest[]>([])
		const server = yield* Effect.acquireRelease(
			Effect.sync(() => createServer(requestHandler(requests, responder))),
			close,
		)
		const port = yield* listen(server)
		return { url: `http://${host}:${port}`, requests }
	})

const signalGroup = (child: ChildProcess, signal: NodeJS.Signals): Effect.Effect<void> =>
	Effect.try({
		try: () =>
			child.pid === undefined ? child.kill(signal) : process.kill(-child.pid, signal),
		catch: hostError,
	}).pipe(Effect.asVoid, Effect.ignore)

const stop = (
	child: ChildProcess,
	done: Deferred.Deferred<ProcessExit, Error>,
): Effect.Effect<void> =>
	Deferred.isDone(done).pipe(
		Effect.flatMap((closed) =>
			closed
				? Effect.void
				: signalGroup(child, "SIGTERM").pipe(
						Effect.andThen(Deferred.await(done).pipe(Effect.timeoutOption("1 second"))),
						Effect.flatMap((exit) =>
							Option.isSome(exit)
								? Effect.void
								: signalGroup(child, "SIGKILL").pipe(
										Effect.andThen(Deferred.await(done)),
										Effect.timeout("2 seconds"),
										Effect.asVoid,
									),
						),
						Effect.ignore,
					),
		),
	)

const appendOutput = (output: Ref.Ref<readonly string[]>, chunk: Uint8Array | string): void =>
	Effect.runSync(
		Ref.update(output, (current) => [
			...current,
			typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
		]),
	)

/** Run the actual workspace start command and terminate its process group on Scope exit. */
export const example = (
	name: "quickstart" | "failover" | "sdk-call" | "sqlite",
	environment: Readonly<Record<string, string>>,
): Effect.Effect<ExampleProcess, Error, Scope.Scope> =>
	Effect.gen(function* () {
		const output = yield* Ref.make<readonly string[]>([])
		const done = yield* Deferred.make<ProcessExit, Error>()
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				const child = spawn(
					"yarn",
					["workspace", `@better-router/example-${name}`, "start"],
					{
						cwd: repositoryRoot,
						env: { ...process.env, ...environment },
						stdio: ["ignore", "pipe", "pipe"],
						detached: true,
					},
				)
				child.stdout?.setEncoding("utf8")
				child.stderr?.setEncoding("utf8")
				child.stdout?.on("data", (chunk: Uint8Array | string) =>
					appendOutput(output, chunk),
				)
				child.stderr?.on("data", (chunk: Uint8Array | string) =>
					appendOutput(output, chunk),
				)
				child.once("error", (error) => Effect.runSync(Deferred.fail(done, error)))
				child.once("close", (code, signal) =>
					Effect.runSync(Deferred.succeed(done, { code, signal })),
				)
				return child
			}),
			(child) => stop(child, done),
		)
		return {
			output,
			awaitExit: Deferred.await(done).pipe(
				Effect.timeout("8 seconds"),
				Effect.mapError(hostError),
			),
		}
	})

const waitForGateway = (url: string, attempts: number): Effect.Effect<void, Error> =>
	Effect.tryPromise({
		try: async (signal) => {
			const response = await fetch(`${url}/__better_router_host_ready`, { signal })
			await response.body?.cancel()
			return response.status
		},
		catch: hostError,
	}).pipe(
		Effect.timeout("300 millis"),
		Effect.mapError(hostError),
		Effect.flatMap((status) =>
			status === 404
				? Effect.void
				: Effect.fail(new Error(`Readiness returned HTTP ${status}`)),
		),
		Effect.catch((error) =>
			attempts <= 0
				? Effect.fail(error)
				: Effect.sleep("60 millis").pipe(
						Effect.andThen(Effect.suspend(() => waitForGateway(url, attempts - 1))),
					),
		),
	)

/** Examples accept a port setting, so release a port-0 reservation immediately before spawn. */
export const gateway = (
	name: "quickstart" | "failover",
	environment: Readonly<Record<string, string>>,
): Effect.Effect<GatewayProcess, Error, Scope.Scope> =>
	Effect.gen(function* () {
		const port = yield* reservePort
		const process = yield* example(name, {
			...environment,
			GATEWAY_HOST: host,
			GATEWAY_PORT: String(port),
		})
		const url = `http://${host}:${port}`
		yield* Effect.raceFirst(
			waitForGateway(url, 100).pipe(Effect.timeout("6 seconds"), Effect.mapError(hostError)),
			process.awaitExit.pipe(
				Effect.flatMap(({ code }) =>
					Effect.fail(new Error(`Example ${name} exited during startup (${code})`)),
				),
			),
		).pipe(
			Effect.mapError(
				(error) => new Error(`${error.message}\n${Ref.getUnsafe(process.output).join("")}`),
			),
		)
		return { ...process, url }
	})

/** Register cancellation before requesting a response, including unread/suspended SSE bodies. */
export const request = (
	url: string,
	options: RequestInit = {},
): Effect.Effect<Response, Error, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.sync(() => new AbortController()),
		(controller) => Effect.sync(() => controller.abort()),
	).pipe(
		Effect.flatMap((controller) =>
			Effect.tryPromise({
				try: (signal) =>
					fetch(url, {
						...options,
						signal: AbortSignal.any([controller.signal, signal]),
					}),
				catch: hostError,
			}).pipe(Effect.timeout("3 seconds"), Effect.mapError(hostError)),
		),
	)

export const readText = (response: Response): Effect.Effect<string, Error> =>
	Effect.tryPromise({ try: () => response.text(), catch: hostError }).pipe(
		Effect.timeout("3 seconds"),
		Effect.mapError(hostError),
	)
