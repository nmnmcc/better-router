import { Chunk, Effect, Schema, Stream } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"

export const HttpJsonError = Schema.Struct({ status: Schema.Number, message: Schema.String })
export type HttpJsonError = typeof HttpJsonError.Type

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** Authenticate before consuming a bounded JSON body. */
export function read(request: HttpServerRequest.HttpServerRequest, authorized: boolean): Effect.Effect<unknown, HttpJsonError> {
  if (!authorized) return Effect.fail({ status: 401, message: "Invalid gateway key" })
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    return Effect.fail({ status: 415, message: "Expected application/json" })
  }
  const limit = 1024 * 1024
  if (Number(request.headers["content-length"]) > limit) {
    return Effect.fail({ status: 413, message: "Request too large" })
  }
  return Effect.gen(function* () {
    // Drain an oversized chunked upload so the Node host can send its error response.
    const body = yield* Stream.runFold(
      request.stream,
      () => ({ size: 0, chunks: Chunk.empty<Uint8Array>() }),
      (state, chunk) => {
        const size = state.size + chunk.byteLength
        return { size, chunks: size <= limit ? Chunk.append(state.chunks, chunk.slice()) : state.chunks }
      },
    ).pipe(Effect.mapError((): HttpJsonError => ({ status: 400, message: "Invalid request body" })))
    if (body.size > limit) return yield* Effect.fail({ status: 413, message: "Request too large" })
    const bytes = Uint8Array.from(Chunk.toReadonlyArray(Chunk.flatMap(body.chunks, (chunk) => Chunk.fromIterable(chunk))))
    const raw = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: (): HttpJsonError => ({ status: 400, message: "Invalid UTF-8 request" }),
    })
    return yield* decode(raw).pipe(Effect.mapError((): HttpJsonError => ({ status: 400, message: "Invalid JSON request" })))
  })
}
