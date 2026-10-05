import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { Persistence, Plugin, ProviderContract, Router } from "@better-router/core"
import * as OpenAI from "@better-router/provider-openai"
import * as PersistenceSql from "@better-router/persistence-sql"
import { Config, Effect, Layer, Match, Option, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const BootState = Schema.Struct({ runs: NonNegativeInt })
const bootDeclaration = {
	namespace: "example.sqlite.boot",
	schema: BootState,
	version: 1,
	migrations: [
		{
			id: 1,
			name: "create_boot_log",
			run: Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient
				yield* sql`CREATE TABLE IF NOT EXISTS better_router_example_boot_log (
					id INTEGER PRIMARY KEY,
					runs INTEGER NOT NULL
				)`
			}),
		},
	] as const,
} as const

const statePlugin = Plugin.make({
	id: "sqlite-example-state",
	capabilities: [] as const,
	config: { persistence: [bootDeclaration] as const },
	init: () =>
		Effect.gen(function* () {
			const persistence = yield* Persistence.Persistence
			const sql = yield* SqlClient.SqlClient
			const store = persistence.state(bootDeclaration)
			return yield* store.transaction(
				Effect.gen(function* () {
					const next = yield* store.update("router", (current) =>
						Option.some({
							runs:
								Option.match(current, {
									onNone: () => 0,
									onSome: ({ runs }) => runs,
								}) + 1,
						}),
					)
					const state = Option.getOrElse(next, () => ({ runs: 0 }))
					yield* sql`INSERT INTO better_router_example_boot_log (runs) VALUES (${state.runs})`
					return state
				}),
			)
		}),
})

const settings = Config.all({
	apiKey: Config.Redacted("OPENAI_API_KEY"),
	upstreamModel: Config.String("OPENAI_MODEL"),
	publicModel: Config.String("ROUTER_MODEL").pipe(Config.withDefault("sqlite-demo")),
	url: Config.URL("OPENAI_RESPONSES_URL").pipe(
		Config.withDefault(new URL("https://api.openai.com/v1/responses")),
	),
	database: Config.String("BETTER_ROUTER_SQLITE").pipe(
		Config.withDefault("./better-router.sqlite"),
	),
})

const program = Effect.gen(function* () {
	const config = yield* settings
	const router = yield* Effect.fromResult(
		Router.make({
			plugins: [
				OpenAI.Deployment.plugin({
					deployments: [
						{
							id: "sqlite-openai",
							provider: "openai",
							model: config.upstreamModel,
							protocol: "responses",
							credentialRef: "openai",
							baseUrl: config.url.toString(),
						},
					],
					modelRoutes: [{ model: config.publicModel, deployments: ["sqlite-openai"] }],
				}),
				statePlugin,
			] as const,
		}),
	)
	const run = Effect.gen(function* () {
		const runtime = yield* Router.RouterRuntime
		const process = yield* runtime.generate({
			model: config.publicModel,
			input: "Give me one practical tip for using a persistent model router.",
		})
		const response = yield* process.response.pipe(Effect.ensuring(process.cancel))
		const text = response.output
			.flatMap((item) =>
				Match.value(item).pipe(
					Match.when({ type: "message" }, (value) =>
						value.content.flatMap((part) => ("text" in part ? [part.text] : [])),
					),
					Match.orElse(() => []),
				),
			)
			.join("")
		const state = yield* Schema.decodeUnknownEffect(BootState)(
			runtime.plugins.find(({ id }) => id === statePlugin.id)?.runtime,
		)
		yield* Effect.log(
			JSON.stringify(
				{
					model: response.model,
					text,
					usage: response.usage,
					persistedRuns: state.runs,
				},
				null,
				2,
			),
		)
	}).pipe(
		Effect.provide(Router.layer(router)),
		Effect.provide(
			ProviderContract.credentialResolverLayer(() => Effect.succeed(config.apiKey)),
		),
		Effect.provide(sqlite(config.database)),
	)
	yield* run
})

const sqlite = (filename: string) =>
	PersistenceSql.layerSql().pipe(Layer.provideMerge(SqliteClient.layer({ filename })))

Effect.scoped(program).pipe(Effect.provide(NodeHttpClient.layerUndici), NodeRuntime.runMain)
