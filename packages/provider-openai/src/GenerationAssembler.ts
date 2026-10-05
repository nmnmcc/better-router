import { Clock, Effect, HashMap, Match, Option, Result, Stream } from "effect"
import type {
	GenerationEvent,
	GenerationOutputItem,
	GenerationRequest,
	GenerationResponse,
} from "@better-router/core/Generation"
import { Error as ProviderError } from "@better-router/core/Provider"

/** The small native vocabulary shared by OpenAI's two streaming endpoints. */
export type NativeChunk =
	| {
			readonly type: "start"
			readonly id: string
			readonly createdAt: number
			readonly model: string
	  }
	| { readonly type: "text"; readonly value: string }
	| { readonly type: "tool_start"; readonly id: string; readonly name: string }
	| { readonly type: "tool_delta"; readonly id: string; readonly value: string }
	| {
			readonly type: "finish"
			readonly reason: "stop" | "tool_calls" | "length" | "content_filter"
			readonly usage?: GenerationResponse["usage"]
	  }

const invalid = (message: string): ProviderError =>
	ProviderError.make({ kind: "unknown", message, retryable: false })

const response = (
	request: GenerationRequest,
	identity: Identity,
	output: readonly GenerationOutputItem[],
	status: "in_progress" | "completed" | "incomplete",
	usage: GenerationResponse["usage"],
	completedAt: number | null,
): GenerationResponse => ({
	id: identity.id,
	object: "response",
	created_at: identity.createdAt,
	completed_at: completedAt,
	status,
	incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
	model: identity.model,
	previous_response_id: request.previous_response_id ?? null,
	instructions: request.instructions ?? null,
	output,
	error: null,
	tools: (request.tools ?? []).map((tool) =>
		tool.type === "function"
			? {
					...tool,
					description: tool.description ?? null,
					parameters: tool.parameters ?? null,
					strict: tool.strict ?? null,
				}
			: tool,
	),
	tool_choice: request.tool_choice ?? "auto",
	truncation: request.truncation ?? "disabled",
	parallel_tool_calls: request.parallel_tool_calls ?? true,
	text: {
		format:
			request.text?.format?.type === "json_schema"
				? {
						type: "json_schema",
						name: request.text.format.name,
						description: request.text.format.description ?? null,
						schema: request.text.format.schema ?? null,
						strict: request.text.format.strict ?? false,
					}
				: request.text?.format?.type === "json_object"
					? { type: "json_object" }
					: { type: "text" },
		...(request.text?.verbosity ? { verbosity: request.text.verbosity } : {}),
	},
	top_p: request.top_p ?? 1,
	presence_penalty: request.presence_penalty ?? 0,
	frequency_penalty: request.frequency_penalty ?? 0,
	top_logprobs: request.top_logprobs ?? 0,
	temperature: request.temperature ?? 1,
	reasoning: request.reasoning
		? {
				effort: request.reasoning.effort ?? null,
				summary: request.reasoning.summary ?? null,
			}
		: null,
	usage,
	max_output_tokens: request.max_output_tokens ?? null,
	max_tool_calls: request.max_tool_calls ?? null,
	store: request.store ?? false,
	background: request.background ?? false,
	service_tier: request.service_tier ?? "default",
	metadata: request.metadata ?? null,
	safety_identifier: request.safety_identifier ?? null,
	prompt_cache_key: request.prompt_cache_key ?? null,
})

type Identity = Readonly<{ id: string; createdAt: number; model: string }>
type State = Readonly<{
	identity: Option.Option<Identity>
	sequence: number
	finished: boolean
	messageIndex: Option.Option<number>
	output: readonly GenerationOutputItem[]
	tools: HashMap.HashMap<string, number>
}>
type UnnumberedEvent = { readonly type: string; readonly [key: string]: unknown }

const initial = (): State => ({
	identity: Option.none(),
	sequence: 0,
	finished: false,
	messageIndex: Option.none(),
	output: [],
	tools: HashMap.empty(),
})

const emit = (
	state: State,
	events: readonly UnnumberedEvent[],
): readonly [State, readonly GenerationEvent[]] => [
	{ ...state, sequence: state.sequence + events.length },
	events.map(
		(event, index) =>
			({ ...event, sequence_number: state.sequence + index }) as GenerationEvent,
	),
]

const transition = (
	request: GenerationRequest,
	state: State,
	chunk: NativeChunk | { readonly type: "end" },
	completedAt: number | null,
): Result.Result<readonly [State, readonly GenerationEvent[]], ProviderError> =>
	Match.value(chunk).pipe(
		Match.discriminatorsExhaustive("type")({
			end: () =>
				state.finished
					? Result.succeed([state, []] as const)
					: Result.fail(invalid("Upstream ended without a terminal response")),
			start: (value) => {
				if (state.finished || Option.isSome(state.identity) || !value.id)
					return Result.fail(invalid("Invalid response identity"))
				return Result.succeed(
					emit(
						{
							...state,
							identity: Option.some({
								id: value.id,
								createdAt: value.createdAt,
								model: value.model,
							}),
						},
						[
							{
								type: "response.created",
								response: response(
									request,
									{
										id: value.id,
										createdAt: value.createdAt,
										model: value.model,
									},
									[],
									"in_progress",
									null,
									null,
								),
							},
						],
					),
				)
			},
			text: (value) =>
				Result.gen(function* () {
					if (state.finished)
						return yield* Result.fail(invalid("Events followed the terminal response"))
					const identity = yield* Result.fromOption(state.identity, () =>
						invalid("Output before response identity"),
					)
					const first = Option.isNone(state.messageIndex)
					const index = first ? state.output.length : state.messageIndex.value
					const current = first
						? {
								type: "message" as const,
								id: `${identity.id}-message`,
								status: "in_progress" as const,
								role: "assistant" as const,
								content: [
									{ type: "output_text" as const, text: "", annotations: [] },
								],
							}
						: state.output[index]
					if (current.type !== "message" || current.content[0]?.type !== "output_text")
						return yield* Result.fail(invalid("Invalid message state"))
					const updated = {
						...current,
						content: [
							{ ...current.content[0], text: current.content[0].text + value.value },
						],
					}
					const output = first
						? [...state.output, updated]
						: state.output.map((item, position) =>
								position === index ? updated : item,
							)
					return emit({ ...state, messageIndex: Option.some(index), output }, [
						...(first
							? [
									{
										type: "response.output_item.added",
										output_index: index,
										item: current,
									},
									{
										type: "response.content_part.added",
										item_id: current.id,
										output_index: index,
										content_index: 0,
										part: current.content[0],
									},
								]
							: []),
						{
							type: "response.output_text.delta",
							item_id: current.id,
							output_index: index,
							content_index: 0,
							delta: value.value,
						},
					])
				}),
			tool_start: (value) =>
				Result.gen(function* () {
					if (
						state.finished ||
						!value.id ||
						!value.name ||
						HashMap.has(state.tools, value.id)
					)
						return yield* Result.fail(invalid("Duplicate or invalid tool call"))
					const identity = yield* Result.fromOption(state.identity, () =>
						invalid("Output before response identity"),
					)
					const index = state.output.length
					const item = {
						type: "function_call" as const,
						id: `${identity.id}-call-${index}`,
						status: "in_progress" as const,
						call_id: value.id,
						name: value.name,
						arguments: "",
					}
					return emit(
						{
							...state,
							output: [...state.output, item],
							tools: HashMap.set(state.tools, value.id, index),
						},
						[{ type: "response.output_item.added", output_index: index, item }],
					)
				}),
			tool_delta: (value) =>
				Result.gen(function* () {
					if (state.finished)
						return yield* Result.fail(invalid("Events followed the terminal response"))
					const index = yield* Result.fromOption(HashMap.get(state.tools, value.id), () =>
						invalid("Tool arguments before tool call"),
					)
					const item = state.output[index]
					if (item.type !== "function_call")
						return yield* Result.fail(invalid("Invalid tool state"))
					return emit(
						{
							...state,
							output: state.output.map((entry, position) =>
								position === index
									? { ...item, arguments: item.arguments + value.value }
									: entry,
							),
						},
						[
							{
								type: "response.function_call_arguments.delta",
								item_id: item.id,
								output_index: index,
								delta: value.value,
							},
						],
					)
				}),
			finish: (value) =>
				Result.gen(function* () {
					if (state.finished)
						return yield* Result.fail(invalid("Events followed the terminal response"))
					const identity = yield* Result.fromOption(state.identity, () =>
						invalid("Output before response identity"),
					)
					const status =
						value.reason === "length" || value.reason === "content_filter"
							? "incomplete"
							: "completed"
					const output = state.output.map((item) => ({
						...item,
						status,
					})) as readonly GenerationOutputItem[]
					const itemEvents = state.output.flatMap(
						(item, index): readonly UnnumberedEvent[] => [
							...(item.type === "message" && item.content[0]?.type === "output_text"
								? [
										{
											type: "response.output_text.done",
											item_id: item.id,
											output_index: index,
											content_index: 0,
											text: item.content[0].text,
										},
										{
											type: "response.content_part.done",
											item_id: item.id,
											output_index: index,
											content_index: 0,
											part: item.content[0],
										},
									]
								: item.type === "function_call"
									? [
											{
												type: "response.function_call_arguments.done",
												item_id: item.id,
												output_index: index,
												arguments: item.arguments,
											},
										]
									: []),
							{
								type: "response.output_item.done",
								output_index: index,
								item: output[index],
							},
						],
					)
					return emit({ ...state, output, finished: true }, [
						...itemEvents,
						{
							type: `response.${status}`,
							response: {
								...response(
									request,
									identity,
									output,
									status,
									value.usage ?? null,
									completedAt,
								),
								...(status === "incomplete"
									? { incomplete_details: { reason: value.reason } }
									: {}),
							},
						},
					])
				}),
		}),
	)

/** Assemble provider-native chunks into a fresh semantic stream per subscriber. */
export const fromNative = (
	request: GenerationRequest,
	source: Stream.Stream<NativeChunk, ProviderError>,
): Stream.Stream<GenerationEvent, ProviderError> =>
	Stream.concat(source, Stream.succeed({ type: "end" as const })).pipe(
		Stream.mapAccumEffect(initial, (state, chunk) =>
			Effect.gen(function* () {
				const completedAt =
					chunk.type === "finish"
						? Math.floor((yield* Clock.currentTimeMillis) / 1000)
						: null
				return yield* Effect.fromResult(transition(request, state, chunk, completedAt))
			}),
		),
	)
