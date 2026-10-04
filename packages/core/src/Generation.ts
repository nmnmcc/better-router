/**
 * The generation ABI is intentionally protocol-neutral. Wire contracts such
 * as OpenResponses, Chat Completions, and Messages are projections of these
 * values; none of their generated types are imported here.
 */

/** A public route alias. Provider model identifiers are private deployment data. */
import type { Identifier } from "./Identifier.js"

export type ModelAlias<Value extends string = string> = Identifier<Value>

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue }
export type JsonObject = { readonly [key: string]: JsonValue }

/** Extension identifiers must use an implementor prefix, e.g. "acme:search_result". */
export type ExtensionType = `${string}:${string}`

/** Provider-specific items remain opaque until a projection explicitly handles them. */
export interface ExtensionItem {
	readonly type: ExtensionType
	readonly id: string
	readonly status: string
	readonly [key: string]: unknown
}

export interface ExtensionTool {
	readonly type: ExtensionType
	readonly [key: string]: unknown
}

/** Extension events are observational and never required for a portable response. */
export interface ExtensionEvent {
	readonly type: ExtensionType
	readonly sequence_number: number
	readonly [key: string]: unknown
}

export type ImageDetail = "low" | "high" | "auto"
export type MessageRole =
	"unknown" | "user" | "assistant" | "system" | "critic" | "discriminator" | "developer" | "tool"
export type InputMessageRole = "user" | "assistant" | "system" | "developer"
export type ItemStatus = "in_progress" | "completed" | "incomplete" | string

export interface Annotation {
	readonly type: "url_citation"
	readonly url: string
	readonly start_index: number
	readonly end_index: number
	readonly title: string
}

export interface TopLogProb {
	readonly token: string
	readonly logprob: number
	readonly bytes: readonly number[]
}

export interface LogProb extends TopLogProb {
	readonly top_logprobs: readonly TopLogProb[]
}

export interface InputTextContent {
	readonly type: "input_text"
	readonly text: string
}

export interface InputImageContent {
	readonly type: "input_image"
	readonly image_url?: string | null
	readonly detail?: ImageDetail | null
}

export interface InputFileContent {
	readonly type: "input_file"
	readonly file_id?: string | null
	readonly file_data?: string | null
	readonly file_url?: string | null
	readonly filename?: string | null
}

export interface InputVideoContent {
	readonly type: "input_video"
	readonly video_url?: string | null
}

export interface OutputTextContent {
	readonly type: "output_text"
	readonly text: string
	readonly annotations: readonly Annotation[]
	readonly logprobs?: readonly LogProb[]
}

/** Input assistant messages use the parameter form where annotations are optional. */
export interface OutputTextInputContent {
	readonly type: "output_text"
	readonly text: string
	readonly annotations?: readonly Annotation[]
}

export interface TextContent {
	readonly type: "text"
	readonly text: string
}

export interface SummaryTextContent {
	readonly type: "summary_text"
	readonly text: string
}

export interface ReasoningTextContent {
	readonly type: "reasoning_text"
	readonly text: string
}

export interface RefusalContent {
	readonly type: "refusal"
	readonly refusal: string
}

export type InputContentPart =
	InputTextContent | InputImageContent | InputFileContent | InputVideoContent
export type OutputContentPart =
	| InputContentPart
	| OutputTextContent
	| TextContent
	| SummaryTextContent
	| ReasoningTextContent
	| RefusalContent
export type MessageContentPart = InputContentPart | OutputTextInputContent | RefusalContent

export interface ItemReferenceInput {
	readonly type: "item_reference"
	readonly id: string
}

export interface ReasoningInput {
	readonly type: "reasoning"
	readonly id?: string | null
	readonly summary: readonly OutputContentPart[]
	readonly content?: null
	readonly encrypted_content?: string | null
}

export interface CompactionInput {
	readonly type: "compaction"
	readonly id?: string | null
	readonly encrypted_content: string
}

export interface MessageInput {
	readonly type: "message"
	readonly id?: string | null
	readonly role: InputMessageRole
	readonly content: string | readonly MessageContentPart[]
	readonly phase?: "commentary" | "final_answer"
	readonly status?: string | null
}

export interface FunctionCallInput {
	readonly type: "function_call"
	readonly id?: string | null
	readonly call_id: string
	readonly name: string
	readonly arguments: string
	readonly status?: ItemStatus | null
}

export interface FunctionCallOutputInput {
	readonly type: "function_call_output"
	readonly id?: string | null
	readonly call_id: string
	readonly output: string | readonly InputContentPart[]
	readonly status?: ItemStatus | null
}

export type GenerationInputItem =
	| ItemReferenceInput
	| ReasoningInput
	| CompactionInput
	| MessageInput
	| FunctionCallInput
	| FunctionCallOutputInput
	| ExtensionItem

export interface MessageOutput {
	readonly type: "message"
	readonly id: string
	readonly status: ItemStatus
	readonly role: MessageRole
	readonly content: readonly OutputContentPart[]
	readonly phase?: "commentary" | "final_answer"
}

export interface FunctionCallOutput {
	readonly type: "function_call_output"
	readonly id: string
	readonly call_id: string
	readonly output: string | readonly InputContentPart[]
	readonly status: ItemStatus
}

export interface FunctionCallOutputItem {
	readonly type: "function_call"
	readonly id: string
	readonly call_id: string
	readonly name: string
	readonly arguments: string
	readonly status: ItemStatus
}

export interface ReasoningOutput {
	readonly type: "reasoning"
	readonly id: string
	readonly content?: readonly OutputContentPart[]
	readonly summary: readonly OutputContentPart[]
	readonly encrypted_content?: string
}

export interface CompactionOutput {
	readonly type: "compaction"
	readonly id: string
	readonly encrypted_content: string
	readonly created_by?: string
}

export type GenerationOutputItem =
	| MessageOutput
	| FunctionCallOutputItem
	| FunctionCallOutput
	| ReasoningOutput
	| CompactionOutput
	| ExtensionItem

export interface GenerationTool {
	readonly type: "function"
	readonly name: string
	readonly description?: string | null
	readonly parameters?: JsonObject | null
	readonly strict?: boolean | null
}

export interface GenerationResponseTool {
	readonly type: "function"
	readonly name: string
	readonly description: string | null
	readonly parameters: JsonObject | null
	readonly strict: boolean | null
}

export type GenerationToolValue = GenerationTool | ExtensionTool

export type ToolChoiceValue = "none" | "auto" | "required"
export interface FunctionToolChoice {
	readonly type: "function"
	readonly name?: string
}
export interface AllowedToolChoice {
	readonly type: "allowed_tools"
	readonly tools: readonly FunctionToolChoice[]
	readonly mode?: ToolChoiceValue
}
export type ToolChoice = ToolChoiceValue | FunctionToolChoice | AllowedToolChoice

export interface TextFormatText {
	readonly type: "text"
}
export interface TextFormatJsonObject {
	readonly type: "json_object"
}
export interface TextFormatJsonSchema {
	readonly type: "json_schema"
	readonly name: string
	readonly description?: string | null
	readonly schema?: JsonObject | null
	readonly strict?: boolean | null
}
export type TextFormat = TextFormatText | TextFormatJsonObject | TextFormatJsonSchema

export interface TextConfig {
	readonly format?: TextFormat | null
	readonly verbosity?: "low" | "medium" | "high"
}

export interface ResponseTextConfig {
	readonly format: TextFormat
	readonly verbosity?: "low" | "medium" | "high"
}

export interface ReasoningConfig {
	readonly effort?: "none" | "low" | "medium" | "high" | "xhigh" | null
	readonly summary?: "concise" | "detailed" | "auto" | null
}

export interface ReasoningResponse {
	readonly effort: ReasoningConfig["effort"]
	readonly summary: ReasoningConfig["summary"]
}

export interface StreamOptions {
	readonly include_obfuscation?: boolean
}

export interface UsageDetails {
	readonly cached_tokens: number
}

export interface OutputUsageDetails {
	readonly reasoning_tokens: number
}

export interface GenerationUsage {
	readonly input_tokens: number
	readonly output_tokens: number
	readonly total_tokens: number
	readonly input_tokens_details: UsageDetails
	readonly output_tokens_details: OutputUsageDetails
}

export interface IncompleteDetails {
	readonly reason: string
}

export interface GenerationError {
	readonly code: string
	readonly message: string
}

/** The semantic request understood by a generation deployment. */
export interface GenerationRequest {
	readonly model: ModelAlias
	readonly input?: string | readonly GenerationInputItem[] | null
	readonly previous_response_id?: string | null
	readonly include?: readonly ("reasoning.encrypted_content" | "message.output_text.logprobs")[]
	readonly tools?: readonly GenerationToolValue[] | null
	readonly tool_choice?: ToolChoice | null
	readonly metadata?: Readonly<Record<string, string>> | null
	readonly text?: TextConfig | null
	readonly temperature?: number | null
	readonly top_p?: number | null
	readonly presence_penalty?: number | null
	readonly frequency_penalty?: number | null
	readonly parallel_tool_calls?: boolean | null
	readonly stream?: boolean
	readonly stream_options?: StreamOptions | null
	readonly background?: boolean
	readonly max_output_tokens?: number | null
	readonly max_tool_calls?: number | null
	readonly reasoning?: ReasoningConfig | null
	readonly safety_identifier?: string | null
	readonly prompt_cache_key?: string | null
	readonly truncation?: "auto" | "disabled"
	readonly instructions?: string | null
	readonly store?: boolean
	readonly service_tier?: "auto" | "default" | "flex" | "priority"
	readonly top_logprobs?: number | null
}

/** The semantic response reconstructed from a generation event stream. */
export interface GenerationResponse {
	readonly id: string
	readonly object: "response"
	readonly created_at: number
	readonly completed_at: number | null
	readonly status: string
	readonly incomplete_details: IncompleteDetails | null
	readonly model: string
	readonly previous_response_id: string | null
	readonly instructions: string | null
	readonly output: readonly GenerationOutputItem[]
	readonly error: GenerationError | null
	readonly tools: readonly (GenerationResponseTool | ExtensionTool)[]
	readonly tool_choice: ToolChoice
	readonly truncation: "auto" | "disabled"
	readonly parallel_tool_calls: boolean
	readonly text: ResponseTextConfig
	readonly top_p: number
	readonly presence_penalty: number
	readonly frequency_penalty: number
	readonly top_logprobs: number
	readonly temperature: number
	readonly reasoning: ReasoningResponse | null
	readonly usage: GenerationUsage | null
	readonly max_output_tokens: number | null
	readonly max_tool_calls: number | null
	readonly store: boolean
	readonly background: boolean
	readonly service_tier: string
	readonly metadata: Readonly<Record<string, string>> | null
	readonly safety_identifier: string | null
	readonly prompt_cache_key: string | null
}

type Sequenced<Type extends string> = {
	readonly type: Type
	readonly sequence_number: number
}

type ResponseSnapshotEvent<
	Type extends
		| "response.created"
		| "response.queued"
		| "response.in_progress"
		| "response.completed"
		| "response.failed"
		| "response.incomplete",
> = Sequenced<Type> & {
	readonly response: GenerationResponse
}

type OutputItemEvent<Type extends "response.output_item.added" | "response.output_item.done"> =
	Sequenced<Type> & {
		readonly output_index: number
		readonly item: GenerationOutputItem | null
	}

type ContentPartEvent<Type extends "response.content_part.added" | "response.content_part.done"> =
	Sequenced<Type> & {
		readonly item_id: string
		readonly output_index: number
		readonly content_index: number
		readonly part: OutputContentPart
	}

/** Canonical generation events. Protocol projections may encode a subset or add wire metadata. */
export type GenerationEvent =
	| ResponseSnapshotEvent<
			| "response.created"
			| "response.queued"
			| "response.in_progress"
			| "response.completed"
			| "response.failed"
			| "response.incomplete"
	  >
	| OutputItemEvent<"response.output_item.added" | "response.output_item.done">
	| (Sequenced<
			"response.reasoning_summary_part.added" | "response.reasoning_summary_part.done"
	  > & {
			readonly item_id: string
			readonly output_index: number
			readonly summary_index: number
			readonly part: OutputContentPart
	  })
	| ContentPartEvent<"response.content_part.added" | "response.content_part.done">
	| (Sequenced<"response.output_text.delta"> & {
			readonly item_id: string
			readonly output_index: number
			readonly content_index: number
			readonly delta: string
			readonly logprobs?: readonly LogProb[]
			readonly obfuscation?: string
	  })
	| (Sequenced<"response.output_text.done"> & {
			readonly item_id: string
			readonly output_index: number
			readonly content_index: number
			readonly text: string
			readonly logprobs?: readonly LogProb[]
	  })
	| (Sequenced<"response.refusal.delta"> & {
			readonly item_id: string
			readonly output_index: number
			readonly content_index: number
			readonly delta: string
	  })
	| (Sequenced<"response.refusal.done"> & {
			readonly item_id: string
			readonly output_index: number
			readonly content_index: number
			readonly refusal: string
	  })
	| (Sequenced<"response.reasoning.delta"> & {
			readonly item_id: string
			readonly output_index: number
			readonly content_index: number
			readonly delta: string
			readonly obfuscation?: string
	  })
	| (Sequenced<"response.reasoning.done"> & {
			readonly item_id: string
			readonly output_index: number
			readonly content_index: number
			readonly text: string
	  })
	| (Sequenced<"response.reasoning_summary_text.delta"> & {
			readonly item_id: string
			readonly output_index: number
			readonly summary_index: number
			readonly delta: string
			readonly obfuscation?: string
	  })
	| (Sequenced<"response.reasoning_summary_text.done"> & {
			readonly item_id: string
			readonly output_index: number
			readonly summary_index: number
			readonly text: string
	  })
	| (Sequenced<"response.output_text.annotation.added"> & {
			readonly item_id: string
			readonly output_index: number
			readonly content_index: number
			readonly annotation_index: number
			readonly annotation: Annotation | null
	  })
	| (Sequenced<"response.function_call_arguments.delta"> & {
			readonly item_id: string
			readonly output_index: number
			readonly delta: string
			readonly obfuscation?: string
	  })
	| (Sequenced<"response.function_call_arguments.done"> & {
			readonly item_id: string
			readonly output_index: number
			readonly arguments: string
	  })
	| (Sequenced<"error"> & {
			readonly error: {
				readonly type: string
				readonly code: string | null
				readonly message: string
				readonly param: string | null
				readonly headers?: Readonly<Record<string, string>>
			}
	  })
	| ExtensionEvent

export type Request = GenerationRequest
export type Response = GenerationResponse
export type Event = GenerationEvent

export { Process, ProcessError, complete } from "./GenerationProcess.js"
export type { Process as GenerationProcess, ProcessFailure } from "./GenerationProcess.js"
