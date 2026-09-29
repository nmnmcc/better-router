import { Effect, Stream } from "effect"
import type { Scope } from "effect"
import { describe, expect, it } from "tstyche"
import { Catalog, Execution, Lifecycle, Projection, Router, Runtime } from "@better-router/core"
import type { Deployment, Identifier, Plugin, Routing } from "@better-router/core"
import type {
	GenerationEvent,
	GenerationRequest,
	GenerationResponse,
} from "@better-router/core/Generation"

const execute = (_request: GenerationRequest): Effect.Effect<Stream.Stream<GenerationEvent>> =>
	Effect.succeed(Stream.empty)

describe("generation ABI", () => {
	it("accepts standard items, tools, and namespaced extensions", () => {
		const request = {
			model: "chat",
			input: [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "Describe this image" },
						{ type: "input_image", image_url: "https://example.com/image.png" },
					],
				},
				{ type: "function_call_output", call_id: "call_1", output: "Done" },
				{ type: "acme:receipt", id: "receipt_1", status: "completed", data: { ok: true } },
			],
			tools: [
				{
					type: "function",
					name: "lookup",
					parameters: { type: "object", properties: { city: { type: "string" } } },
				},
			],
			previous_response_id: "resp_1",
			text: { format: { type: "json_schema", name: "result", schema: { type: "object" } } },
		} as const satisfies GenerationRequest
		expect(request.input[0].type).type.toBe<"message">()
		expect(request.tools[0].parameters.properties.city.type).type.toBe<"string">()

		expect<{
			type: "response.output_text.delta"
			sequence_number: number
			item_id: string
			output_index: number
			content_index: number
			delta: string
		}>().type.toBeAssignableTo<GenerationEvent>()
		expect<{
			type: "acme:trace"
			sequence_number: number
			trace_id: string
		}>().type.toBeAssignableTo<GenerationEvent>()
		expect<{
			type: "response.output_item.added"
			sequence_number: number
			output_index: number
			item: { type: "acme:receipt"; id: string; status: string }
		}>().type.toBeAssignableTo<GenerationEvent>()
		expect<{
			type: "response.completed"
			sequence_number: number
			response: GenerationResponse
		}>().type.toBeAssignableTo<GenerationEvent>()
		expect<{
			type: "response.incomplete"
			sequence_number: number
			response: GenerationResponse
		}>().type.toBeAssignableTo<GenerationEvent>()
		expect<{
			type: "response.failed"
			sequence_number: number
			response: GenerationResponse
		}>().type.toBeAssignableTo<GenerationEvent>()
	})

	it("rejects old fields, malformed items, and unprefixed extension events", () => {
		expect<{ input: string }>().type.not.toBeAssignableTo<GenerationRequest>()
		expect<{
			model: string
			input: [
				{ type: "message"; role: "user"; content: [{ type: "input_sound"; url: string }] },
			]
		}>().type.not.toBeAssignableTo<GenerationRequest>()
		expect<{
			model: string
			input: [{ type: "acme:receipt"; status: "completed" }]
		}>().type.not.toBeAssignableTo<GenerationRequest>()
		expect<{ type: "text-delta"; text: string }>().type.not.toBeAssignableTo<GenerationEvent>()
		expect<{
			type: "custom-event"
			sequence_number: number
		}>().type.not.toBeAssignableTo<GenerationEvent>()
		expect<{
			type: "response.completed"
			sequence_number: number
		}>().type.not.toBeAssignableTo<GenerationEvent>()
		expect<{ text: string; toolCalls: [] }>().type.not.toBeAssignableTo<GenerationResponse>()
	})
})

describe("deployment contracts", () => {
	it("requires an executable upstream transport", () => {
		expect<{ http: typeof execute }>().type.toBeAssignableTo<Deployment.GenerationExecutors>()
		expect<{
			websocket: typeof execute
		}>().type.toBeAssignableTo<Deployment.GenerationExecutors>()
		expect<{}>().type.not.toBeAssignableTo<Deployment.GenerationExecutors>()
		expect<
			() => Stream.Stream<GenerationEvent>
		>().type.not.toBeAssignableTo<Deployment.GenerationExecutor>()
	})
})

describe("router inference", () => {
	it("propagates plugin services into the acquisition effect", () => {
		interface AuditLog {
			readonly record: (message: string) => void
		}
		const audit: Plugin.RouterPlugin<"audit", AuditLog> = { id: "audit" }
		const router = Router.make({ plugins: [audit], routes: [] })
		expect(router).type.toBe<
			Effect.Effect<
				Router.Router<Router.ComposedHttpApi<readonly [typeof audit]>>,
				Plugin.SetupError,
				Scope.Scope | AuditLog
			>
		>()
		expect<Plugin.PluginRequirements<typeof audit>>().type.toBe<AuditLog>()
	})

	it("extracts literal declaration IDs and checks each route reference", () => {
		const plugin = {
			id: "fixture",
			deployments: [
				{
					id: "primary",
					provider: "test",
					model: "private",
					protocol: "test.protocol",
					execute: { http: execute },
				},
			],
			policies: [
				{ id: "balanced", rank: (_request, candidates) => Effect.succeed(candidates) },
			],
			pipelines: [
				{
					id: "primary:direct",
					deployment: "primary",
					source: "test.protocol",
					target: "test.protocol",
					execute: () => Effect.succeed({ status: 200, headers: {}, body: Stream.empty }),
				},
			],
			capabilities: [{ id: "custom", version: 1, projections: ["test.protocol"] }],
			middleware: [{ id: "audit", wrap: (next) => next }],
		} as const satisfies Plugin.RouterPlugin
		expect<Identifier.IdOf<typeof plugin>>().type.toBe<"fixture">()
		expect<Identifier.ItemIdsOf<typeof plugin, "deployments">>().type.toBe<"primary">()
		expect<Identifier.PreserveLiteral<"primary">>().type.toBe<"primary">()
		expect<Identifier.PreserveLiteral<string>>().type.toBe<string>()
		expect<Plugin.PluginIds<readonly [typeof plugin]>>().type.toBe<"fixture">()
		expect<Plugin.PluginDeploymentIds<typeof plugin>>().type.toBe<"primary">()
		expect<Plugin.PluginPolicyIds<typeof plugin>>().type.toBe<"balanced">()
		expect<Plugin.PluginPipelineIds<typeof plugin>>().type.toBe<"primary:direct">()
		expect<Plugin.PluginCapabilityIds<typeof plugin>>().type.toBe<"custom">()
		expect<Plugin.PluginMiddlewareIds<typeof plugin>>().type.toBe<"audit">()
		Router.make({
			plugins: [plugin],
			routes: [{ model: "chat", deployments: ["primary"], policy: "balanced" }],
		})
		const runtimeId: string = "primary"
		Router.make({ plugins: [plugin], routes: [{ model: "dynamic", deployments: [runtimeId] }] })
		Router.make({
			plugins: [plugin],
			// @ts-expect-error!
			routes: [{ model: "mixed", deployments: ["misspelled", runtimeId] }],
		})
		Router.make({
			plugins: [plugin],
			// @ts-expect-error!
			routes: [{ model: "chat", deployments: ["primary"], policy: "missing" }],
		})
		expect<
			Routing.DuplicateRouteModels<readonly [{ model: "chat" }, { model: "chat" }]>
		>().type.toBe<"chat">()
		expect<
			Routing.DuplicateRouteModels<readonly [{ model: "chat" | "other" }, { model: "chat" }]>
		>().type.toBe<"chat">()
	})
})

describe("core constructor modules", () => {
	it("exposes top-level make functions", () => {
		Catalog.make([])
		Runtime.make([])
		Lifecycle.make()
	})

	it("does not expose the old suffixed constructors", () => {
		// @ts-expect-error Property 'makeCatalog' does not exist
		Catalog.makeCatalog
		// @ts-expect-error Property 'makeRuntime' does not exist
		Projection.makeRuntime
		// @ts-expect-error Property 'makeLifecycle' does not exist
		Execution.makeLifecycle
	})
})
