import { Clock, Effect, HashMap, Match, Option, Result, Stream } from "effect"
import { ProviderError } from "./Deployment.js"
import type {
	GenerationEvent,
	GenerationRequest,
	GenerationResponse,
	GenerationOutputItem,
} from "./Generation.js"

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

export function snapshot(
	request: GenerationRequest,
	id: string,
	createdAt: number,
	model: string,
	output: readonly GenerationOutputItem[],
	status: "in_progress" | "completed" | "incomplete",
	usage: GenerationResponse["usage"],
	completedAt: number | null,
): GenerationResponse {
	return {
		id,
		object: "response",
		created_at: createdAt,
		completed_at: completedAt,
		status,
		incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
		model,
		previous_response_id: request.previous_response_id ?? null,
		instructions: request.instructions ?? null,
		output,
		error: null,
		tools: (request.tools ?? []).map((tool) =>
			Match.value(tool.type).pipe(
				Match.when("function", () => {
					const value = tool as Extract<typeof tool, { readonly type: "function" }>
					return {
						...value,
						description: value.description ?? null,
						parameters: value.parameters ?? null,
						strict: value.strict ?? null,
					}
				}),
				Match.orElse(() => tool),
			),
		),
		tool_choice: request.tool_choice ?? "auto",
		truncation: request.truncation ?? "disabled",
		parallel_tool_calls: request.parallel_tool_calls ?? true,
		text: {
			format: Match.value(request.text?.format).pipe(
				Match.when({ type: "json_schema" }, (format) => ({
					type: "json_schema" as const,
					name: format.name,
					description: format.description ?? null,
					schema: null,
					strict: format.strict ?? false,
				})),
				Match.when({ type: "json_object" }, () => ({ type: "json_object" as const })),
				Match.orElse(() => ({ type: "text" as const })),
			),
			...(request.text?.verbosity ? { verbosity: request.text.verbosity } : {}),
		},
		top_p: request.top_p ?? 1,
		presence_penalty: request.presence_penalty ?? 0,
		frequency_penalty: request.frequency_penalty ?? 0,
		top_logprobs: request.top_logprobs ?? 0,
		temperature: request.temperature ?? 1,
		reasoning: request.reasoning ?? null,
		usage,
		max_output_tokens: request.max_output_tokens ?? null,
		max_tool_calls: request.max_tool_calls ?? null,
		store: request.store ?? false,
		background: request.background ?? false,
		service_tier: request.service_tier ?? "default",
		metadata: request.metadata ?? null,
		safety_identifier: request.safety_identifier ?? null,
		prompt_cache_key: request.prompt_cache_key ?? null,
	} as GenerationResponse
}

type Identity = { readonly id: string; readonly createdAt: number; readonly model: string }
interface State {
	readonly identity: Option.Option<Identity>
	readonly sequence: number
	readonly finished: boolean
	readonly messageIndex: Option.Option<number>
	readonly output: readonly GenerationOutputItem[]
	readonly tools: HashMap.HashMap<string, number>
}
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
		(entry, index) =>
			({ ...entry, sequence_number: state.sequence + index }) as GenerationEvent,
	),
]

function transition(
	request: GenerationRequest,
	state: State,
	chunk: NativeChunk | { readonly type: "end" },
	completedAt: number | null,
): Result.Result<readonly [State, readonly GenerationEvent[]], ProviderError> {
	return Match.value(chunk).pipe(
		Match.discriminatorsExhaustive("type")({
			end: () =>
				state.finished
					? Result.succeed([state, []] as const)
					: Result.fail(invalid("Upstream ended without a terminal response")),
			start: (value) => {
				if (state.finished)
					return Result.fail(invalid("Events followed the terminal response"))
				if (Option.isSome(state.identity) || !value.id || !Number.isFinite(value.createdAt))
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
								response: snapshot(
									request,
									value.id,
									value.createdAt,
									value.model,
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
					const item = first
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
					if (item.type !== "message" || item.content[0]?.type !== "output_text")
						return yield* Result.fail(invalid("Invalid message state"))
					const updated = {
						...item,
						content: [{ ...item.content[0], text: item.content[0].text + value.value }],
					}
					const output = first
						? [...state.output, updated]
						: state.output.map((current, position) =>
								position === index ? updated : current,
							)
					return emit(
						{
							...state,
							messageIndex: Option.some(index),
							output: output as readonly GenerationOutputItem[],
						},
						[
							...(first
								? [
										{
											type: "response.output_item.added",
											output_index: index,
											item,
										},
										{
											type: "response.content_part.added",
											item_id: item.id,
											output_index: index,
											content_index: 0,
											part: item.content[0],
										},
									]
								: []),
							{
								type: "response.output_text.delta",
								item_id: item.id,
								output_index: index,
								content_index: 0,
								delta: value.value,
							},
						],
					)
				}),
			tool_start: (value) =>
				Result.gen(function* () {
					if (state.finished)
						return yield* Result.fail(invalid("Events followed the terminal response"))
					const identity = yield* Result.fromOption(state.identity, () =>
						invalid("Output before response identity"),
					)
					if (HashMap.has(state.tools, value.id) || !value.id || !value.name)
						return yield* Result.fail(invalid("Duplicate or invalid tool call"))
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
							output: state.output.map((current, position) =>
								position === index
									? { ...item, arguments: item.arguments + value.value }
									: current,
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
					const items = state.output.flatMap(
						(item, index): readonly UnnumberedEvent[] => {
							const completed = Match.value(item).pipe(
								Match.when({ type: "message" }, (message) =>
									message.content[0]?.type === "output_text"
										? [
												{
													type: "response.output_text.done",
													item_id: message.id,
													output_index: index,
													content_index: 0,
													text: message.content[0].text,
												},
												{
													type: "response.content_part.done",
													item_id: message.id,
													output_index: index,
													content_index: 0,
													part: message.content[0],
												},
											]
										: [],
								),
								Match.when({ type: "function_call" }, (call) => [
									{
										type: "response.function_call_arguments.done",
										item_id: call.id,
										output_index: index,
										arguments: call.arguments,
									},
								]),
								Match.orElse(() => []),
							)
							return [
								...completed,
								{
									type: "response.output_item.done",
									output_index: index,
									item: output[index],
								},
							]
						},
					)
					const response = snapshot(
						request,
						identity.id,
						identity.createdAt,
						identity.model,
						output,
						status,
						value.usage ?? null,
						completedAt,
					)
					const terminal =
						status === "incomplete" && value.reason === "content_filter"
							? { ...response, incomplete_details: { reason: "content_filter" } }
							: response
					return emit({ ...state, output, finished: true }, [
						...items,
						{ type: `response.${status}`, response: terminal },
					])
				}),
		}),
	)
}

/** Assemble provider-native deltas with subscription-local immutable state. */
export function fromNative(
	request: GenerationRequest,
	source: Stream.Stream<NativeChunk, ProviderError>,
): Stream.Stream<GenerationEvent, ProviderError> {
	return Stream.concat(source, Stream.succeed({ type: "end" as const })).pipe(
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
}
