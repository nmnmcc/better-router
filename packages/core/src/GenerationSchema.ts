import { Schema } from "effect"
import type { GenerationEvent, GenerationRequest, GenerationResponse } from "./Generation.js"

/**
 * Schemas for the semantic generation ABI. This module deliberately has no
 * dependency on an HTTP protocol or on generated provider types. Protocol
 * plugins decode their own wire documents first and then use these schemas at
 * the core boundary.
 */

const extensionPattern = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_.-]*$/
const extensionType = Schema.String.pipe(Schema.check(Schema.isPattern(extensionPattern)))
const json = Schema.Json
const jsonObject = Schema.Record(Schema.String, json)

const extensionItem = Schema.StructWithRest(
  Schema.Struct({
    type: extensionType,
    id: Schema.String,
    status: Schema.String,
  }),
  [Schema.Record(Schema.String, json)],
)

const extensionEvent = Schema.StructWithRest(
  Schema.Struct({
    type: extensionType,
    sequence_number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  [Schema.Record(Schema.String, json)],
)

const extensionTool = Schema.StructWithRest(Schema.Struct({ type: extensionType }), [Schema.Record(Schema.String, json)])

const annotation = Schema.Struct({
  type: Schema.Literal("url_citation"),
  url: Schema.String,
  start_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  end_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  title: Schema.String,
})

const topLogProb = Schema.Struct({
  token: Schema.String,
  logprob: Schema.Number,
  bytes: Schema.Array(Schema.Int),
})

const logProb = Schema.Struct({
  token: Schema.String,
  logprob: Schema.Number,
  bytes: Schema.Array(Schema.Int),
  top_logprobs: Schema.Array(topLogProb),
})

const inputText = Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })
const inputImage = Schema.Struct({
  type: Schema.Literal("input_image"),
  image_url: Schema.optional(Schema.NullOr(Schema.String)),
  detail: Schema.optional(Schema.NullOr(Schema.Literals(["low", "high", "auto"] as const))),
})
const inputFile = Schema.Struct({
  type: Schema.Literal("input_file"),
  file_id: Schema.optional(Schema.NullOr(Schema.String)),
  file_data: Schema.optional(Schema.NullOr(Schema.String)),
  file_url: Schema.optional(Schema.NullOr(Schema.String)),
  filename: Schema.optional(Schema.NullOr(Schema.String)),
})
const inputVideo = Schema.Struct({
  type: Schema.Literal("input_video"),
  video_url: Schema.optional(Schema.NullOr(Schema.String)),
})
const outputText = Schema.Struct({
  type: Schema.Literal("output_text"),
  text: Schema.String,
  annotations: Schema.Array(annotation),
  logprobs: Schema.optional(Schema.Array(logProb)),
})
const outputTextInput = Schema.Struct({
  type: Schema.Literal("output_text"),
  text: Schema.String,
  annotations: Schema.optional(Schema.Array(annotation)),
})
const text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const summaryText = Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String })
const reasoningText = Schema.Struct({ type: Schema.Literal("reasoning_text"), text: Schema.String })
const refusal = Schema.Struct({ type: Schema.Literal("refusal"), refusal: Schema.String })

const inputContent = Schema.Union([inputText, inputImage, inputFile, inputVideo])
const outputContent = Schema.Union([inputText, inputImage, inputFile, inputVideo, outputText, text, summaryText, reasoningText, refusal])
const messageContent = Schema.Union([inputText, inputImage, inputFile, inputVideo, outputTextInput, refusal])

const itemReference = Schema.Struct({ type: Schema.Literal("item_reference"), id: Schema.String })
const reasoningInput = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  summary: Schema.Array(outputContent),
  content: Schema.optional(Schema.Null),
  encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
})
const compactionInput = Schema.Struct({
  type: Schema.Literal("compaction"),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  encrypted_content: Schema.String,
})
const messageInput = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.Literals(["user", "assistant", "system", "developer"] as const),
  content: Schema.Union([Schema.String, Schema.Array(messageContent)]),
  phase: Schema.optional(Schema.Literals(["commentary", "final_answer"] as const)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
})
const functionCallInput = Schema.Struct({
  type: Schema.Literal("function_call"),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  status: Schema.optional(Schema.NullOr(Schema.String)),
})
const functionCallOutputInput = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  id: Schema.optional(Schema.NullOr(Schema.String)),
  call_id: Schema.String,
  output: Schema.Union([Schema.String, Schema.Array(inputContent)]),
  status: Schema.optional(Schema.NullOr(Schema.String)),
})
const inputItem = Schema.Union([itemReference, reasoningInput, compactionInput, messageInput, functionCallInput, functionCallOutputInput, extensionItem])

const messageOutput = Schema.Struct({
  type: Schema.Literal("message"),
  id: Schema.String,
  status: Schema.String,
  role: Schema.Literals(["unknown", "user", "assistant", "system", "critic", "discriminator", "developer", "tool"] as const),
  content: Schema.Array(outputContent),
  phase: Schema.optional(Schema.Literals(["commentary", "final_answer"] as const)),
})
const functionCallOutputItem = Schema.Struct({
  type: Schema.Literal("function_call"),
  id: Schema.String,
  call_id: Schema.String,
  name: Schema.String,
  arguments: Schema.String,
  status: Schema.String,
})
const functionCallOutput = Schema.Struct({
  type: Schema.Literal("function_call_output"),
  id: Schema.String,
  call_id: Schema.String,
  output: Schema.Union([Schema.String, Schema.Array(inputContent)]),
  status: Schema.String,
})
const reasoningOutput = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  content: Schema.optional(Schema.Array(outputContent)),
  summary: Schema.Array(outputContent),
  encrypted_content: Schema.optional(Schema.String),
})
const compactionOutput = Schema.Struct({
  type: Schema.Literal("compaction"),
  id: Schema.String,
  encrypted_content: Schema.String,
  created_by: Schema.optional(Schema.String),
})
const outputItem = Schema.Union([messageOutput, functionCallOutputItem, functionCallOutput, reasoningOutput, compactionOutput, extensionItem])

const generationTool = Schema.Struct({
  type: Schema.Literal("function"),
  name: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  parameters: Schema.optional(Schema.NullOr(jsonObject)),
  strict: Schema.optional(Schema.NullOr(Schema.Boolean)),
})
const tool = Schema.Union([generationTool, extensionTool])
const functionChoice = Schema.Struct({ type: Schema.Literal("function"), name: Schema.optional(Schema.String) })
const allowedToolChoice = Schema.Struct({
  type: Schema.Literal("allowed_tools"),
  tools: Schema.Array(functionChoice),
  mode: Schema.optional(Schema.Literals(["none", "auto", "required"] as const)),
})
const toolChoice = Schema.Union([Schema.Literals(["none", "auto", "required"] as const), functionChoice, allowedToolChoice])

const textFormat = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text") }),
  Schema.Struct({ type: Schema.Literal("json_object") }),
  Schema.Struct({
    type: Schema.Literal("json_schema"),
    name: Schema.String,
    description: Schema.optional(Schema.NullOr(Schema.String)),
    schema: Schema.optional(Schema.NullOr(jsonObject)),
    strict: Schema.optional(Schema.NullOr(Schema.Boolean)),
  }),
])
const textConfig = Schema.Struct({
  format: Schema.optional(Schema.NullOr(textFormat)),
  verbosity: Schema.optional(Schema.Literals(["low", "medium", "high"] as const)),
})
const responseTextConfig = Schema.Struct({
  format: textFormat,
  verbosity: Schema.optional(Schema.Literals(["low", "medium", "high"] as const)),
})
const reasoningConfig = Schema.Struct({
  effort: Schema.optional(Schema.NullOr(Schema.Literals(["none", "low", "medium", "high", "xhigh"] as const))),
  summary: Schema.optional(Schema.NullOr(Schema.Literals(["concise", "detailed", "auto"] as const))),
})
const streamOptions = Schema.Struct({ include_obfuscation: Schema.optional(Schema.Boolean) })
const usage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  total_tokens: Schema.Number,
  input_tokens_details: Schema.Struct({ cached_tokens: Schema.Number }),
  output_tokens_details: Schema.Struct({ reasoning_tokens: Schema.Number }),
})
const incompleteDetails = Schema.Struct({ reason: Schema.String })
const generationError = Schema.Struct({ code: Schema.String, message: Schema.String })

const requestSchema = Schema.Struct({
  model: Schema.NonEmptyString,
  input: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(inputItem)]))),
  previous_response_id: Schema.optional(Schema.NullOr(Schema.String)),
  include: Schema.optional(Schema.Array(Schema.Literals(["reasoning.encrypted_content", "message.output_text.logprobs"] as const))),
  tools: Schema.optional(Schema.NullOr(Schema.Array(tool))),
  tool_choice: Schema.optional(Schema.NullOr(toolChoice)),
  metadata: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  text: Schema.optional(Schema.NullOr(textConfig)),
  temperature: Schema.optional(Schema.NullOr(Schema.Number)),
  top_p: Schema.optional(Schema.NullOr(Schema.Number)),
  presence_penalty: Schema.optional(Schema.NullOr(Schema.Number)),
  frequency_penalty: Schema.optional(Schema.NullOr(Schema.Number)),
  parallel_tool_calls: Schema.optional(Schema.NullOr(Schema.Boolean)),
  stream: Schema.optional(Schema.Boolean),
  stream_options: Schema.optional(Schema.NullOr(streamOptions)),
  background: Schema.optional(Schema.Boolean),
  max_output_tokens: Schema.optional(Schema.NullOr(Schema.Int)),
  max_tool_calls: Schema.optional(Schema.NullOr(Schema.Int)),
  reasoning: Schema.optional(Schema.NullOr(reasoningConfig)),
  safety_identifier: Schema.optional(Schema.NullOr(Schema.String)),
  prompt_cache_key: Schema.optional(Schema.NullOr(Schema.String)),
  truncation: Schema.optional(Schema.Literals(["auto", "disabled"] as const)),
  instructions: Schema.optional(Schema.NullOr(Schema.String)),
  store: Schema.optional(Schema.Boolean),
  service_tier: Schema.optional(Schema.Literals(["auto", "default", "flex", "priority"] as const)),
  top_logprobs: Schema.optional(Schema.NullOr(Schema.Int)),
})

const responseSchema = Schema.Struct({
  id: Schema.String,
  object: Schema.Literal("response"),
  created_at: Schema.Number,
  completed_at: Schema.NullOr(Schema.Number),
  status: Schema.String,
  incomplete_details: Schema.NullOr(incompleteDetails),
  model: Schema.String,
  previous_response_id: Schema.NullOr(Schema.String),
  instructions: Schema.NullOr(Schema.String),
  output: Schema.Array(outputItem),
  error: Schema.NullOr(generationError),
  tools: Schema.Array(tool),
  tool_choice: toolChoice,
  truncation: Schema.Literals(["auto", "disabled"] as const),
  parallel_tool_calls: Schema.Boolean,
  text: responseTextConfig,
  top_p: Schema.Number,
  presence_penalty: Schema.Number,
  frequency_penalty: Schema.Number,
  top_logprobs: Schema.Number,
  temperature: Schema.Number,
  reasoning: Schema.NullOr(reasoningConfig),
  usage: Schema.NullOr(usage),
  max_output_tokens: Schema.NullOr(Schema.Int),
  max_tool_calls: Schema.NullOr(Schema.Int),
  store: Schema.Boolean,
  background: Schema.Boolean,
  service_tier: Schema.String,
  metadata: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
  safety_identifier: Schema.NullOr(Schema.String),
  prompt_cache_key: Schema.NullOr(Schema.String),
})

const sequenced = { sequence_number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }
const responseSnapshotEvent = Schema.Struct({
  type: Schema.Literals(["response.created", "response.queued", "response.in_progress", "response.completed", "response.failed", "response.incomplete"] as const),
  ...sequenced,
  response: responseSchema,
})
const outputItemEvent = Schema.Struct({
  type: Schema.Literals(["response.output_item.added", "response.output_item.done"] as const),
  ...sequenced,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  item: Schema.NullOr(outputItem),
})
const reasoningSummaryPartEvent = Schema.Struct({
  type: Schema.Literals(["response.reasoning_summary_part.added", "response.reasoning_summary_part.done"] as const),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  summary_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  part: outputContent,
})
const contentPartEvent = Schema.Struct({
  type: Schema.Literals(["response.content_part.added", "response.content_part.done"] as const),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  part: outputContent,
})
const outputTextDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.output_text.delta"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  delta: Schema.String,
  logprobs: Schema.optional(Schema.Array(logProb)),
  obfuscation: Schema.optional(Schema.String),
})
const outputTextDoneEvent = Schema.Struct({
  type: Schema.Literal("response.output_text.done"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  text: Schema.String,
  logprobs: Schema.optional(Schema.Array(logProb)),
})
const refusalDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.refusal.delta"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  delta: Schema.String,
})
const refusalDoneEvent = Schema.Struct({
  type: Schema.Literal("response.refusal.done"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  refusal: Schema.String,
})
const reasoningDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.reasoning.delta"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  delta: Schema.String,
  obfuscation: Schema.optional(Schema.String),
})
const reasoningDoneEvent = Schema.Struct({
  type: Schema.Literal("response.reasoning.done"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  text: Schema.String,
})
const reasoningSummaryTextDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_text.delta"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  summary_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  delta: Schema.String,
  obfuscation: Schema.optional(Schema.String),
})
const reasoningSummaryTextDoneEvent = Schema.Struct({
  type: Schema.Literal("response.reasoning_summary_text.done"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  summary_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  text: Schema.String,
})
const annotationEvent = Schema.Struct({
  type: Schema.Literal("response.output_text.annotation.added"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  annotation_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  annotation: Schema.NullOr(annotation),
})
const functionArgumentsDeltaEvent = Schema.Struct({
  type: Schema.Literal("response.function_call_arguments.delta"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  delta: Schema.String,
  obfuscation: Schema.optional(Schema.String),
})
const functionArgumentsDoneEvent = Schema.Struct({
  type: Schema.Literal("response.function_call_arguments.done"),
  ...sequenced,
  item_id: Schema.String,
  output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  arguments: Schema.String,
})
const errorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  ...sequenced,
  error: Schema.Struct({
    type: Schema.String,
    code: Schema.NullOr(Schema.String),
    message: Schema.String,
    param: Schema.NullOr(Schema.String),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
})

const eventSchema = Schema.Union([responseSnapshotEvent, outputItemEvent, reasoningSummaryPartEvent, contentPartEvent, outputTextDeltaEvent, outputTextDoneEvent, refusalDeltaEvent, refusalDoneEvent, reasoningDeltaEvent, reasoningDoneEvent, reasoningSummaryTextDeltaEvent, reasoningSummaryTextDoneEvent, annotationEvent, functionArgumentsDeltaEvent, functionArgumentsDoneEvent, errorEvent, extensionEvent])

export const Request = Schema.make<Schema.Codec<GenerationRequest>>(requestSchema.ast)
export const Response = Schema.make<Schema.Codec<GenerationResponse>>(responseSchema.ast)
export const Event = Schema.make<Schema.Codec<GenerationEvent>>(eventSchema.ast)

/** Canonical aliases for callers that distinguish standard from extension-aware values. */
export const StandardRequest = Request
export const StandardResponse = Response
export const StandardEvent = Event

export const ExtensionItem = extensionItem
export const ExtensionEvent = extensionEvent
export const ExtensionTool = extensionTool
