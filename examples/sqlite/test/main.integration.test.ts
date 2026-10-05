import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { it } from "@effect/vitest"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Persistence from "@better-router/core/Persistence"
import * as RoutingRuntime from "@better-router/core/RoutingRuntime"
import * as PersistenceSql from "@better-router/persistence-sql"
import { example, upstream } from "../../test/Host.js"
import { openAiResponse, openAiStream } from "../../test/Fixtures.js"

const BootState = Schema.Struct({ runs: Schema.Natural })
const bootDeclaration = {
	namespace: "example.sqlite.boot",
	schema: BootState,
} as const

const BootLogRow = Schema.Struct({
	id: Schema.Natural,
	runs: Schema.Natural,
})

const PersistedRow = Schema.Struct({
	value: Schema.Union([Schema.String, Schema.Uint8Array]),
})

const PrintedOutput = Schema.fromJsonString(
	Schema.Struct({
		model: Schema.String,
		text: Schema.String,
		usage: Schema.Json,
		persistedRuns: Schema.Natural,
	}),
)

const printedOutput = (output: string) => {
	const json = output.match(/\{[\s\S]*\}/)?.[0]
	assert.ok(json, output)
	return Schema.decodeUnknownEffect(PrintedOutput)(json)
}

const expectedOutput = (persistedRuns: number) => ({
	model: "sqlite-demo",
	text: "sqlite response",
	usage: openAiResponse("gpt-sqlite", "sqlite response").usage,
	persistedRuns,
})

const temporaryDirectory = Effect.acquireRelease(
	Effect.tryPromise(() => mkdtemp(join(tmpdir(), "better-router-example-sqlite-"))),
	(directory) =>
		Effect.tryPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
)

const sqlite = (filename: string) =>
	PersistenceSql.layerSql().pipe(Layer.provideMerge(SqliteClient.layer({ filename })))

const persistedText = (value: Uint8Array | string): string =>
	typeof value === "string" ? value : new TextDecoder().decode(value)

it.live(
	"persists plugin boot state and routing usage across SQLite host restarts",
	() =>
		Effect.gen(function* () {
			const directory = yield* temporaryDirectory
			const database = join(directory, "router.sqlite")
			const state = yield* upstream((_request, response) => {
				response.writeHead(200, { "content-type": "text/event-stream" })
				response.end(openAiStream("gpt-sqlite", "sqlite response"))
			})
			const environment = {
				OPENAI_API_KEY: "provider-secret",
				OPENAI_MODEL: "gpt-sqlite",
				ROUTER_MODEL: "sqlite-demo",
				OPENAI_RESPONSES_URL: `${state.url}/v1/responses`,
				BETTER_ROUTER_SQLITE: database,
			}

			const first = yield* example("sqlite", environment)
			const firstExit = yield* first.awaitExit
			const firstOutput = (yield* Ref.get(first.output)).join("")
			assert.equal(firstExit.code, 0, firstOutput)
			assert.equal(firstExit.signal, null)
			assert.deepEqual(yield* printedOutput(firstOutput), expectedOutput(1))

			const second = yield* example("sqlite", environment)
			const secondExit = yield* second.awaitExit
			const secondOutput = (yield* Ref.get(second.output)).join("")
			assert.equal(secondExit.code, 0, secondOutput)
			assert.equal(secondExit.signal, null)
			assert.deepEqual(yield* printedOutput(secondOutput), expectedOutput(2))

			const requests = yield* Ref.get(state.requests)
			assert.equal(requests.length, 2)
			assert.equal(
				requests.every(
					({ path, headers }) =>
						path === "/v1/responses" &&
						headers.authorization === "Bearer provider-secret",
				),
				true,
			)

			yield* Effect.gen(function* () {
				const persistence = yield* Persistence.Persistence
				const sql = yield* SqlClient.SqlClient
				const boot = yield* persistence.state(bootDeclaration).get("router")
				assert.deepEqual(Option.getOrUndefined(boot), { runs: 2 })

				const runtime = yield* persistence.state(RoutingRuntime.declaration).get("snapshot")
				assert.equal(Option.isSome(runtime), true)
				if (Option.isNone(runtime))
					return assert.fail("Expected a persisted routing snapshot")
				const deployment = runtime.value.deployments["sqlite-openai"]
				assert.ok(deployment)
				assert.equal(deployment.healthy, true)
				assert.equal(deployment.successCount, 2)
				assert.equal(deployment.failureCount, 0)
				assert.equal(deployment.inputTokens, 6)
				assert.equal(deployment.outputTokens, 4)

				const rows = yield* sql<{
					readonly id: number
					readonly runs: number
				}>`SELECT id, runs FROM better_router_example_boot_log ORDER BY id`
				const decodedRows = yield* Schema.decodeUnknownEffect(Schema.Array(BootLogRow))(
					rows,
				)
				assert.deepEqual(
					decodedRows.map(({ runs }) => runs),
					[1, 2],
				)

				const persisted = yield* sql<{
					readonly value: Uint8Array
				}>`SELECT value FROM effect_key_value_store`
				const decodedPersisted = yield* Schema.decodeUnknownEffect(
					Schema.Array(PersistedRow),
				)(persisted)
				assert.equal(
					decodedPersisted.some(({ value }) =>
						persistedText(value).includes("provider-secret"),
					),
					false,
				)
			}).pipe(Effect.provide(sqlite(database)))
		}),
	30_000,
)
