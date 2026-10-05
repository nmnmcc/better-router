import type { GenerationResponse } from "@better-router/core/Generation"

export const openAiResponse = (model: string, text: string): GenerationResponse => ({
	id: "response-host",
	object: "response",
	created_at: 1,
	completed_at: 2,
	status: "completed",
	incomplete_details: null,
	model,
	previous_response_id: null,
	instructions: null,
	output: [
		{
			type: "message",
			id: "message-host",
			status: "completed",
			role: "assistant",
			content: [{ type: "output_text", text, annotations: [] }],
		},
	],
	error: null,
	tools: [],
	tool_choice: "auto",
	truncation: "disabled",
	parallel_tool_calls: true,
	text: { format: { type: "text" } },
	top_p: 1,
	presence_penalty: 0,
	frequency_penalty: 0,
	top_logprobs: 0,
	temperature: 1,
	reasoning: null,
	usage: {
		input_tokens: 3,
		output_tokens: 2,
		total_tokens: 5,
		input_tokens_details: { cached_tokens: 0 },
		output_tokens_details: { reasoning_tokens: 0 },
	},
	max_output_tokens: null,
	max_tool_calls: null,
	store: false,
	background: false,
	service_tier: "default",
	metadata: null,
	safety_identifier: null,
	prompt_cache_key: null,
})

export const openAiStream = (model: string, text: string): string => {
	const response = openAiResponse(model, text)
	const created = {
		type: "response.created",
		sequence_number: 0,
		response: {
			...response,
			status: "in_progress",
			completed_at: null,
			output: [],
			usage: null,
		},
	}
	const delta = {
		type: "response.output_text.delta",
		sequence_number: 1,
		item_id: "message-host",
		output_index: 0,
		content_index: 0,
		delta: text,
	}
	const completed = { type: "response.completed", sequence_number: 2, response }
	return [created, delta, completed]
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.concat("data: [DONE]\n\n")
		.join("")
}

export const anthropicStream = (model: string, text: string): string =>
	[
		{
			type: "message_start",
			message: {
				id: "message-fallback",
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 3, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 2 },
		},
		{ type: "message_stop" },
	]
		.map((event) => `data: ${JSON.stringify(event)}\n\n`)
		.join("")
