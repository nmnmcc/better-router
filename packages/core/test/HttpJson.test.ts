import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import type { HttpServerRequest } from "effect/unstable/http"
import { HttpJsonError, read } from "@better-router/core/HttpJson"

const request = (
	headers: Readonly<Record<string, string>>,
	stream: Stream.Stream<Uint8Array, unknown>,
): HttpServerRequest.HttpServerRequest =>
	({ headers, stream }) as HttpServerRequest.HttpServerRequest

const bytes = (value: string) => new TextEncoder().encode(value)

it.effect("authenticates before consuming and validates content type and size", () =>
	Effect.gen(function* () {
		const unauthorized = yield* Effect.flip(
			read(
				request({ "content-type": "application/json" }, Stream.fail("must not consume")),
				false,
			),
		)
		assert.deepEqual(
			unauthorized,
			HttpJsonError.make({ status: 401, message: "Invalid gateway key" }),
		)

		const contentType = yield* Effect.flip(
			read(request({ "content-type": "text/plain" }, Stream.succeed(bytes("{}"))), true),
		)
		assert.equal(contentType.status, 415)

		const tooLarge = yield* Effect.flip(
			read(
				request(
					{ "content-type": "application/json", "content-length": "1048577" },
					Stream.empty,
				),
				true,
			),
		)
		assert.equal(tooLarge.status, 413)
	}),
)

it.effect("decodes split JSON and reports body, UTF-8, and JSON failures", () =>
	Effect.gen(function* () {
		const decoded = yield* read(
			request(
				{ "content-type": "application/json" },
				Stream.fromIterable([bytes('{"answer":'), bytes("42}")]),
			),
			true,
		)
		assert.deepEqual(decoded, { answer: 42 })

		const invalidUtf8 = yield* Effect.flip(
			read(
				request(
					{ "content-type": "application/json" },
					Stream.succeed(new Uint8Array([0xc3, 0x28])),
				),
				true,
			),
		)
		assert.equal(invalidUtf8.status, 400)
		assert.equal(invalidUtf8.message, "Invalid UTF-8 request")

		const invalidJson = yield* Effect.flip(
			read(request({ "content-type": "application/json" }, Stream.succeed(bytes("{"))), true),
		)
		assert.equal(invalidJson.message, "Invalid JSON request")

		const streamFailure = yield* Effect.flip(
			read(request({ "content-type": "application/json" }, Stream.fail("broken")), true),
		)
		assert.equal(streamFailure.message, "Invalid request body")
	}),
)

it.effect("drains chunked bodies before returning the size error", () =>
	Effect.gen(function* () {
		const oversized = yield* Effect.flip(
			read(
				request(
					{ "content-type": "application/json" },
					Stream.fromIterable([new Uint8Array(1024 * 1024), new Uint8Array([1])]),
				),
				true,
			),
		)
		assert.equal(oversized.status, 413)
	}),
)
