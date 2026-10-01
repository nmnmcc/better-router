import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { AiError, LanguageModel, Model, Prompt, Tool, Toolkit } from "effect/ai"
import * as ResponseIdTracker from "effect/ai/ResponseIdTracker"
import { EffectAI } from "@better-router/core"
import * as Execution from "@better-router/core/Execution"
import type {
	GenerationEvent,
	GenerationOutputItem,
	GenerationRequest,
	GenerationResponse,
} from "@better-router/core/Generation"
import { ProviderError } from "@better-router/core/Deployment"
import { RouterError, RouterRuntime } from "@better-router/core/Router"
import type { Router } from "@better-router/core/Router"

const response = (overrides: Partial<GenerationResponse> = {}): GenerationResponse => ({
	id: "response_1",
	object: "response",
	created_at: 1,
	completed_at: 2,
	status: "completed",
	incomplete_details: null,
	model: "private-model",
	previous_response_id: null,
	instructions: null,
	output: [],
	error: null,
	tools: [],
	tool_choice: "none",
	truncation: "disabled",
	parallel_tool_calls: true,
	text: { format: { type: "text" } },
	top_p: 1,
	presence_penalty: 0,
	frequency_penalty: 0,
	top_logprobs: 0,
	temperature: 1,
	reasoning: null,
	usage: null,
	max_output_tokens: null,
	max_tool_calls: null,
	store: false,
	background: false,
	service_tier: "default",
	metadata: null,
	safety_identifier: null,
	prompt_cache_key: null,
	...overrides,
})

const message = (text: string): GenerationOutputItem => ({
	type: "message",
	id: "message_1",
	status: "completed",
	role: "assistant",
	content: [{ type: "output_text", text, annotations: [] }],
})

const functionCall = (argumentsValue = '{"city":"Paris"}'): GenerationOutputItem => ({
	type: "function_call",
	id: "function_1",
	call_id: "call_1",
	name: "lookup",
	arguments: argumentsValue,
	status: "completed",
})

const event = (type: GenerationEvent["type"], value: object): GenerationEvent =>
	({ type, sequence_number: 0, ...value }) as GenerationEvent

const completed = (
	output: readonly GenerationOutputItem[] = [],
	overrides: Partial<GenerationResponse> = {},
): GenerationEvent => event("response.completed", { response: response({ ...overrides, output }) })

const router = (
	requests: Ref.Ref<readonly GenerationRequest[]>,
	source: (request: GenerationRequest) => Stream.Stream<GenerationEvent, RouterError>,
	failure?: RouterError,
): Router =>
	({
		invoke: (command) =>
			command.type === "generation"
				? failure !== undefined
					? Effect.fail(failure)
					: Ref.update(requests, (current) => [...current, command.request]).pipe(
							Effect.flatMap((_) => Execution.generation(source(command.request))),
						)
				: Effect.fail(
						RouterError.cases.InvalidRequest.make({ message: "generation expected" }),
					),
		http: { api: undefined as never, routes: Layer.empty },
	}) as Router

const lookup = Tool.make("lookup", {
	description: "Look up a city",
	parameters: Schema.Struct({ city: Schema.String }),
	success: Schema.Struct({ temperature: Schema.Number }),
})

const lookupToolkit = Toolkit.make(lookup)
const toolkit = lookupToolkit.pipe(
	Effect.provide(lookupToolkit.toLayer({ lookup: () => Effect.succeed({ temperature: 20 }) })),
)

const runWith = <Value, Error, Requirements>(
	effect: Effect.Effect<Value, Error, Requirements>,
	runtime: Router,
) =>
	effect.pipe(
		Effect.provide(EffectAI.model("public-model")),
		Effect.provide(Layer.succeed(RouterRuntime, runtime)),
	)

it.effect("provides model metadata and converts prompts, tools, and JSON schema", () =>
	Effect.gen(function* () {
		const requests = yield* Ref.make<readonly GenerationRequest[]>([])
		const runtime = router(requests, (request) =>
			request.text?.format?.type === "json_schema"
				? Stream.make(
						event("response.completed", {
							response: response({ output: [message('{"answer":"ok"}')] }),
						}),
					)
				: Stream.make(completed([functionCall()])),
		)
		const result = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				const provider = yield* Model.ProviderName
				const modelName = yield* Model.ModelName
				const text = yield* languageModel.generateText({
					prompt: [
						{ role: "system", content: "You are a city assistant." },
						{ role: "user", content: [{ type: "text", text: "Weather?" }] },
					],
					toolkit,
					toolChoice: { tool: "lookup" },
					disableToolCallResolution: true,
				})
				const answer = yield* languageModel.generateObject({
					prompt: "Return an answer",
					objectName: "answer",
					schema: Schema.Struct({ answer: Schema.String }),
				})
				return { provider, modelName, text, answer }
			}),
			runtime,
		)
		assert.equal(result.provider, "better-router")
		assert.equal(result.modelName, "public-model")
		assert.equal(result.answer.value.answer, "ok")
		assert.deepEqual(result.text.text, "")
		assert.deepEqual(
			result.text.content.map((part) => part.type),
			["response-metadata", "tool-call", "finish"],
		)
		const captured = yield* Ref.get(requests)
		assert.equal(captured.length, 2)
		const toolRequest = captured[0]
		assert.equal(toolRequest.model, "public-model")
		assert.equal(toolRequest.stream, false)
		assert.deepEqual(toolRequest.tool_choice, { type: "function", name: "lookup" })
		assert.equal(toolRequest.tools?.[0]?.name, "lookup")
		assert.equal(toolRequest.tools?.[0]?.description, "Look up a city")
		assert.deepEqual(toolRequest.input, [
			{ type: "message", role: "system", content: "You are a city assistant." },
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "Weather?" }],
			},
		])
		const objectRequest = captured[1]
		assert.equal(objectRequest.stream, false)
		if (objectRequest.text?.format?.type === "json_schema") {
			assert.equal(objectRequest.text.format.name, "answer")
			assert.equal(objectRequest.text.format.strict, true)
		}
	}),
)

it.effect("uses tracked continuation IDs and keeps stream state local to each subscription", () =>
	Effect.gen(function* () {
		const requests = yield* Ref.make<readonly GenerationRequest[]>([])
		const source = (_request: GenerationRequest) =>
			Stream.make(
				event("response.created", { response: response({ status: "in_progress" }) }),
				event("response.output_text.delta", {
					item_id: "message_1",
					output_index: 0,
					content_index: 0,
					delta: "hello",
				}),
				event("response.output_text.done", {
					item_id: "message_1",
					output_index: 0,
					content_index: 0,
					text: "hello",
				}),
				completed([message("hello")]),
			)
		const runtime = router(requests, source)
		const result = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				const prompt = Prompt.make([
					{ role: "system", content: "Be concise." },
					{ role: "user", content: "First" },
				])
				const first = yield* languageModel.generateText({ prompt })
				const continuation = Prompt.concat(prompt, [
					{ role: "assistant", content: "hello" },
					{ role: "user", content: "Second" },
				])
				const second = yield* languageModel
					.streamText({ prompt: continuation })
					.pipe(Stream.runCollect)
				return { first, second }
			}).pipe(
				Effect.provide(
					Layer.effect(ResponseIdTracker.ResponseIdTracker, ResponseIdTracker.make),
				),
			),
			runtime,
		)
		assert.equal(result.first.content[0]?.type, "response-metadata")
		assert.deepEqual(
			result.second.map((part) => part.type),
			["response-metadata", "text-start", "text-delta", "text-end", "finish"],
		)
		const captured = yield* Ref.get(requests)
		assert.equal(captured.length, 2)
		assert.equal(captured[0].stream, false)
		assert.equal(captured[1].stream, true)
		assert.equal(captured[1].previous_response_id, "response_1")
		assert.deepEqual(captured[1].input, [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Second" }] },
		])
	}),
)

it.effect("maps reasoning, tool arguments, usage, finish reasons, and failed responses", () =>
	Effect.gen(function* () {
		const requests = yield* Ref.make<readonly GenerationRequest[]>([])
		const runtime = router(requests, (_request) =>
			Stream.make(
				completed(
					[
						{
							type: "reasoning",
							id: "reasoning_1",
							summary: [{ type: "summary_text", text: "Consider the city." }],
						},
						message("Done"),
						functionCall(),
					],
					{
						usage: {
							input_tokens: 10,
							output_tokens: 8,
							total_tokens: 18,
							input_tokens_details: { cached_tokens: 2 },
							output_tokens_details: { reasoning_tokens: 3 },
						},
					},
				),
			),
		)
		const result = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				return yield* languageModel.generateText({
					prompt: "Answer",
					toolkit,
					toolChoice: "auto",
					disableToolCallResolution: true,
				})
			}),
			runtime,
		)
		assert.deepEqual(
			result.content.map((part) => part.type),
			["response-metadata", "reasoning", "text", "tool-call", "finish"],
		)
		const finish = result.content.at(-1)
		if (finish?.type !== "finish") assert.fail("Expected finish part")
		assert.equal(finish.reason, "tool-calls")
		assert.equal(finish.usage.inputTokens.uncached, 8)
		assert.equal(finish.usage.inputTokens.cacheRead, 2)
		assert.equal(finish.usage.outputTokens.total, 8)
		assert.equal(finish.usage.outputTokens.text, 5)
		assert.equal(finish.usage.outputTokens.reasoning, 3)

		const failedRequests = yield* Ref.make<readonly GenerationRequest[]>([])
		const failedRuntime = router(failedRequests, (_request) =>
			Stream.make(
				event("response.failed", {
					response: response({
						status: "failed",
						error: { code: "provider_error", message: "No output" },
					}),
				}),
			),
		)
		const failed = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				return yield* languageModel.generateText({ prompt: "Fail" })
			}),
			failedRuntime,
		)
		assert.deepEqual(
			failed.content.map((part) => part.type),
			["response-metadata", "finish"],
		)
		const failedFinish = failed.content.at(-1)
		if (failedFinish?.type === "finish") assert.equal(failedFinish.reason, "error")
	}),
)

it.effect("emits ordered stream parts, decodes tool params, and propagates cancellation", () =>
	Effect.gen(function* () {
		const requests = yield* Ref.make<readonly GenerationRequest[]>([])
		const runtime = router(requests, (_request) =>
			Stream.make(
				event("response.created", { response: response({ status: "in_progress" }) }),
				event("response.reasoning_summary_text.delta", {
					item_id: "reasoning_1",
					output_index: 0,
					summary_index: 0,
					delta: "think",
				}),
				event("response.reasoning_summary_text.done", {
					item_id: "reasoning_1",
					output_index: 0,
					summary_index: 0,
					text: "think",
				}),
				event("response.output_text.delta", {
					item_id: "message_1",
					output_index: 0,
					content_index: 0,
					delta: "Hi",
				}),
				event("response.output_text.done", {
					item_id: "message_1",
					output_index: 0,
					content_index: 0,
					text: "Hi",
				}),
				event("response.output_item.added", {
					output_index: 1,
					item: functionCall(),
				}),
				event("response.function_call_arguments.delta", {
					item_id: "function_1",
					output_index: 1,
					delta: '{"city":',
				}),
				event("response.function_call_arguments.delta", {
					item_id: "function_1",
					output_index: 1,
					delta: '"Paris"}',
				}),
				event("response.function_call_arguments.done", {
					item_id: "function_1",
					output_index: 1,
					arguments: '{"city":"Paris"}',
				}),
				completed([message("Hi"), functionCall()]),
			),
		)
		const result = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				return yield* languageModel
					.streamText({
						prompt: "Stream",
						toolkit,
						disableToolCallResolution: true,
					})
					.pipe(Stream.runCollect)
			}),
			runtime,
		)
		assert.deepEqual(
			result.map((part) => part.type),
			[
				"response-metadata",
				"reasoning-start",
				"reasoning-delta",
				"reasoning-end",
				"text-start",
				"text-delta",
				"text-end",
				"tool-params-start",
				"tool-params-delta",
				"tool-params-delta",
				"tool-params-end",
				"tool-call",
				"finish",
			],
		)
		const toolCall = result.find((part) => part.type === "tool-call")
		if (toolCall?.type !== "tool-call") assert.fail("Expected a tool call")
		assert.deepEqual(toolCall.params, { city: "Paris" })

		const closed = yield* Ref.make(false)
		const started = yield* Deferred.make<void>()
		const cancellationRequests = yield* Ref.make<readonly GenerationRequest[]>([])
		const cancellationRuntime = router(cancellationRequests, (_request) =>
			Stream.unwrap(
				Deferred.succeed(started, void 0).pipe(
					Effect.as(Stream.never as Stream.Stream<GenerationEvent, never>),
				),
			).pipe(Stream.ensuring(Ref.set(closed, true))),
		)
		const fiber = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				return yield* languageModel.streamText({ prompt: "Cancel" }).pipe(Stream.runDrain)
			}),
			cancellationRuntime,
		).pipe(Effect.forkChild)
		yield* Deferred.await(started)
		yield* Fiber.interrupt(fiber)
		assert.equal(yield* Ref.get(closed), true)
	}),
)

it.effect("returns typed errors for unsupported inputs and provider failures", () =>
	Effect.gen(function* () {
		const requests = yield* Ref.make<readonly GenerationRequest[]>([])
		const runtime = router(requests, (_request) => Stream.make(completed()))
		const unsupported = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				return yield* Effect.flip(
					languageModel.generateText({
						prompt: [
							{
								role: "user",
								content: [
									{
										type: "file",
										mediaType: "image/png",
										data: "data:image/png;base64,AA==",
									},
								],
							},
						],
					}),
				)
			}),
			runtime,
		)
		assert.equal(unsupported.reason._tag, "InvalidUserInputError")

		const approval = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				return yield* Effect.flip(
					languageModel.generateText({
						prompt: [
							{
								role: "assistant",
								content: [
									{
										type: "tool-call",
										id: "call_1",
										name: "lookup",
										params: {},
										providerExecuted: false,
									},
									{
										type: "tool-approval-request",
										approvalId: "approval_1",
										toolCallId: "call_1",
									},
								],
							},
							{
								role: "tool",
								content: [
									{
										type: "tool-approval-response",
										approvalId: "approval_1",
										approved: true,
									},
								],
							},
						],
					}),
				)
			}),
			runtime,
		)
		assert.equal(approval.reason._tag, "ToolkitRequiredError")

		const providerFailure = RouterError.cases.ProviderFailed.make({
			deployment: "primary",
			cause: ProviderError.make({
				kind: "rate_limited",
				message: "slow down",
				retryable: true,
			}),
		})
		const failed = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				return yield* Effect.flip(languageModel.generateText({ prompt: "Retry" }))
			}),
			router(
				yield* Ref.make<readonly GenerationRequest[]>([]),
				(_request) => Stream.empty,
				providerFailure,
			),
		)
		assert.equal(failed.reason._tag, "RateLimitError")
		assert.equal(failed.reason.isRetryable, true)

		const invalidJson = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				return yield* Effect.flip(
					languageModel.generateText({
						prompt: "Bad tool",
						toolkit,
						disableToolCallResolution: true,
					}),
				)
			}),
			router(yield* Ref.make<readonly GenerationRequest[]>([]), (_request) =>
				Stream.make(completed([functionCall("not-json")])),
			),
		)
		assert.equal(invalidJson.reason._tag, "InvalidOutputError")

		const providerDefined = Tool.providerDefined({
			id: "example.search",
			customName: "search",
			providerName: "search",
		})()
		const dynamic = Tool.dynamic("dynamic", {
			parameters: { type: "object", properties: {} },
		})
		const unsupportedTools = yield* runWith(
			Effect.gen(function* () {
				const languageModel = yield* LanguageModel.LanguageModel
				return yield* Effect.flip(
					languageModel.generateText({
						prompt: "Tools",
						toolkit: Toolkit.make(providerDefined, dynamic).pipe(
							Effect.provide(
								Toolkit.make(providerDefined, dynamic).toLayer({
									dynamic: () => Effect.succeed({}),
								}),
							),
						),
						disableToolCallResolution: true,
					}),
				)
			}),
			runtime,
		)
		assert.equal(unsupportedTools.reason._tag, "ToolConfigurationError")
		assert.equal((unsupportedTools.reason as AiError.ToolConfigurationError).toolName, "search")
	}),
)
