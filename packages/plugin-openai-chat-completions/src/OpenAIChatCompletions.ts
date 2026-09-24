import { Schema } from "effect"
import type { InputItem, ModelRequest } from "@better-router/core/Model"

export class OpenAIChatCompletionsConversionError extends Schema.TaggedError<OpenAIChatCompletionsConversionError>()(
  "OpenAIChatCompletionsConversionError",
  {
    path: Schema.String,
    reason: Schema.Literals(["invalid", "unsupported"]),
    message: Schema.String,
  },
) {
  static at(path: string, reason: "invalid" | "unsupported", message: string) {
    return new OpenAIChatCompletionsConversionError({ path, reason, message: `${path}: ${message}` })
  }
}

type RecordValue = Record<string, unknown>

function record(value: unknown, path: string): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw OpenAIChatCompletionsConversionError.at(path, "invalid", "expected an object")
  }
  return value as RecordValue
}

function fields(value: RecordValue, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw OpenAIChatCompletionsConversionError.at(`${path}.${key}`, "unsupported", "no OpenResponses mapping")
  }
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw OpenAIChatCompletionsConversionError.at(path, "invalid", "expected a string")
  return value
}

function nonempty(value: unknown, path: string): string {
  const result = string(value, path)
  if (!result) throw OpenAIChatCompletionsConversionError.at(path, "invalid", "must not be empty")
  return result
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw OpenAIChatCompletionsConversionError.at(path, "invalid", "expected a boolean")
  return value
}

function number(value: unknown, path: string, min: number, max = Infinity, integer = false): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    throw OpenAIChatCompletionsConversionError.at(
      path,
      "invalid",
      `expected ${integer ? "an integer" : "a number"} between ${min} and ${max}`,
    )
  }
  return value
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw OpenAIChatCompletionsConversionError.at(path, "invalid", "expected an array")
  return value
}

function textParts(value: unknown, path: string): { type: "input_text"; text: string }[] {
  return list(value, path).map((part, index) => {
    const partPath = `${path}[${index}]`
    const source = record(part, partPath)
    fields(source, partPath, ["type", "text"])
    if (source.type !== "text")
      throw OpenAIChatCompletionsConversionError.at(`${partPath}.type`, "unsupported", "only text parts are supported")
    return { type: "input_text", text: string(source.text, `${partPath}.text`) }
  })
}

function userContent(value: unknown, path: string) {
  if (typeof value === "string") return value
  return list(value, path).map((part, index) => {
    const partPath = `${path}[${index}]`
    const source = record(part, partPath)
    if (source.type === "text") {
      fields(source, partPath, ["type", "text"])
      return { type: "input_text" as const, text: string(source.text, `${partPath}.text`) }
    }
    if (source.type === "image_url") {
      fields(source, partPath, ["type", "image_url"])
      const image = record(source.image_url, `${partPath}.image_url`)
      fields(image, `${partPath}.image_url`, ["url", "detail"])
      const detail = image.detail
      if (detail !== undefined && detail !== "auto" && detail !== "low" && detail !== "high") {
        throw OpenAIChatCompletionsConversionError.at(`${partPath}.image_url.detail`, "invalid", "expected auto, low, or high")
      }
      const imagePart: { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" } = {
        type: "input_image",
        image_url: nonempty(image.url, `${partPath}.image_url.url`),
        ...(detail === undefined ? {} : { detail }),
      }
      return imagePart
    }
    throw OpenAIChatCompletionsConversionError.at(`${partPath}.type`, "unsupported", "no OpenResponses input content mapping")
  })
}

function messages(value: unknown): readonly InputItem[] {
  const output: InputItem[] = []
  for (const [index, item] of list(value, "messages").entries()) {
    const path = `messages[${index}]`
    const message = record(item, path)
    switch (message.role) {
      case "system":
      case "developer": {
        fields(message, path, ["role", "content"])
        const content =
          typeof message.content === "string" ? message.content : textParts(message.content, `${path}.content`)
        output.push({ type: "message", role: message.role, content })
        break
      }
      case "user": {
        fields(message, path, ["role", "content"])
        output.push({ type: "message", role: "user", content: userContent(message.content, `${path}.content`) })
        break
      }
      case "assistant": {
        fields(message, path, ["role", "content", "tool_calls"])
        let callCount = 0
        if (message.content !== undefined && message.content !== null) {
          const content =
            typeof message.content === "string"
              ? message.content
              : list(message.content, `${path}.content`).map((part, partIndex) => {
                  const partPath = `${path}.content[${partIndex}]`
                  const source = record(part, partPath)
                  fields(source, partPath, ["type", "text"])
                  if (source.type !== "text")
                    throw OpenAIChatCompletionsConversionError.at(`${partPath}.type`, "unsupported", "only text parts are supported")
                  return { type: "output_text" as const, text: string(source.text, `${partPath}.text`) }
                })
          output.push({ type: "message", role: "assistant", content })
        }
        if (message.tool_calls !== undefined) {
          for (const [callIndex, call] of list(message.tool_calls, `${path}.tool_calls`).entries()) {
            callCount++
            const callPath = `${path}.tool_calls[${callIndex}]`
            const source = record(call, callPath)
            fields(source, callPath, ["id", "type", "function"])
            if (source.type !== "function")
              throw OpenAIChatCompletionsConversionError.at(`${callPath}.type`, "unsupported", "only function calls are supported")
            const fn = record(source.function, `${callPath}.function`)
            fields(fn, `${callPath}.function`, ["name", "arguments"])
            output.push({
              type: "function_call",
              call_id: nonempty(source.id, `${callPath}.id`),
              name: nonempty(fn.name, `${callPath}.function.name`),
              arguments: string(fn.arguments, `${callPath}.function.arguments`),
            })
          }
        }
        if (message.content == null && callCount === 0) {
          throw OpenAIChatCompletionsConversionError.at(path, "invalid", "assistant message needs content or function calls")
        }
        break
      }
      case "tool": {
        fields(message, path, ["role", "tool_call_id", "content"])
        const content =
          typeof message.content === "string" ? message.content : textParts(message.content, `${path}.content`)
        output.push({
          type: "function_call_output",
          call_id: nonempty(message.tool_call_id, `${path}.tool_call_id`),
          output: content,
        })
        break
      }
      default:
        throw OpenAIChatCompletionsConversionError.at(`${path}.role`, "unsupported", "unknown chat message role")
    }
  }
  return output
}

function tools(value: unknown): NonNullable<ModelRequest["tools"]> {
  return list(value, "tools").map((tool, index) => {
    const path = `tools[${index}]`
    const source = record(tool, path)
    fields(source, path, ["type", "function"])
    if (source.type !== "function")
      throw OpenAIChatCompletionsConversionError.at(`${path}.type`, "unsupported", "only function tools are supported")
    const fn = record(source.function, `${path}.function`)
    fields(fn, `${path}.function`, ["name", "description", "parameters", "strict"])
    return {
      type: "function" as const,
      name: nonempty(fn.name, `${path}.function.name`),
      ...(fn.description === undefined ? {} : { description: string(fn.description, `${path}.function.description`) }),
      ...(fn.parameters === undefined ? {} : { parameters: record(fn.parameters, `${path}.function.parameters`) }),
      ...(fn.strict === undefined ? {} : { strict: boolean(fn.strict, `${path}.function.strict`) }),
    }
  })
}

function toolChoice(value: unknown): NonNullable<ModelRequest["tool_choice"]> {
  if (value === "auto" || value === "none" || value === "required") return value
  const choice = record(value, "tool_choice")
  fields(choice, "tool_choice", ["type", "function"])
  if (choice.type !== "function")
    throw OpenAIChatCompletionsConversionError.at("tool_choice.type", "unsupported", "only function tools are supported")
  const fn = record(choice.function, "tool_choice.function")
  fields(fn, "tool_choice.function", ["name"])
  return { type: "function", name: nonempty(fn.name, "tool_choice.function.name") }
}

function responseFormat(value: unknown): NonNullable<ModelRequest["text"]> {
  const format = record(value, "response_format")
  if (format.type === "text") {
    fields(format, "response_format", ["type"])
    return { format: { type: "text" } }
  }
  if (format.type !== "json_schema")
    throw OpenAIChatCompletionsConversionError.at("response_format.type", "unsupported", "only text and json_schema are supported")
  fields(format, "response_format", ["type", "json_schema"])
  const schema = record(format.json_schema, "response_format.json_schema")
  fields(schema, "response_format.json_schema", ["name", "description", "schema", "strict"])
  return {
    format: {
      type: "json_schema",
      name: nonempty(schema.name, "response_format.json_schema.name"),
      ...(schema.description === undefined
        ? {}
        : { description: string(schema.description, "response_format.json_schema.description") }),
      ...(schema.schema === undefined ? {} : { schema: record(schema.schema, "response_format.json_schema.schema") }),
      ...(schema.strict === undefined ? {} : { strict: boolean(schema.strict, "response_format.json_schema.strict") }),
    },
  }
}

function streamOptions(value: unknown): NonNullable<ModelRequest["stream_options"]> {
  const options = record(value, "request.stream_options")
  fields(options, "request.stream_options", ["include_obfuscation"])
  return options.include_obfuscation === undefined
    ? {}
    : {
        include_obfuscation: boolean(options.include_obfuscation, "request.stream_options.include_obfuscation"),
      }
}

/** Convert a Chat Completions request body to the OpenResponses request IR. */
export function toResponseRequest(value: unknown): ModelRequest {
  const source = record(value, "request")
  fields(source, "request", [
    "model",
    "messages",
    "tools",
    "tool_choice",
    "response_format",
    "max_completion_tokens",
    "max_tokens",
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "parallel_tool_calls",
    "stream",
    "stream_options",
    "store",
    "metadata",
    "n",
  ])
  if (source.max_tokens !== undefined && source.max_completion_tokens !== undefined) {
    throw OpenAIChatCompletionsConversionError.at("request.max_tokens", "invalid", "cannot combine max_tokens with max_completion_tokens")
  }
  if (source.n !== undefined && number(source.n, "request.n", 1, Infinity, true) !== 1) {
    throw OpenAIChatCompletionsConversionError.at("request.n", "unsupported", "OpenResponses produces one response per request")
  }
  const metadata = source.metadata === undefined ? undefined : record(source.metadata, "request.metadata")
  if (metadata) {
    if (Object.keys(metadata).length > 16)
      throw OpenAIChatCompletionsConversionError.at("request.metadata", "unsupported", "OpenResponses allows at most 16 pairs")
    for (const [key, entry] of Object.entries(metadata)) {
      if (key.length > 64 || string(entry, `request.metadata.${key}`).length > 512) {
        throw OpenAIChatCompletionsConversionError.at(
          `request.metadata.${key}`,
          "unsupported",
          "OpenResponses metadata size limit exceeded",
        )
      }
    }
  }
  const limit = source.max_completion_tokens !== undefined ? source.max_completion_tokens : source.max_tokens
  const limitPath = source.max_completion_tokens !== undefined ? "request.max_completion_tokens" : "request.max_tokens"
  const validatedLimit = limit === undefined ? undefined : number(limit, limitPath, 1, Infinity, true)
  if (validatedLimit !== undefined && validatedLimit < 16) {
    throw OpenAIChatCompletionsConversionError.at(limitPath, "unsupported", "OpenResponses requires at least 16 output tokens")
  }
  return {
    model: nonempty(source.model, "request.model"),
    input: messages(source.messages),
    ...(source.tools === undefined ? {} : { tools: tools(source.tools) }),
    ...(source.tool_choice === undefined ? {} : { tool_choice: toolChoice(source.tool_choice) }),
    ...(source.response_format === undefined ? {} : { text: responseFormat(source.response_format) }),
    ...(validatedLimit === undefined ? {} : { max_output_tokens: validatedLimit }),
    ...(source.temperature === undefined
      ? {}
      : { temperature: number(source.temperature, "request.temperature", 0, 2) }),
    ...(source.top_p === undefined ? {} : { top_p: number(source.top_p, "request.top_p", 0, 1) }),
    ...(source.presence_penalty === undefined
      ? {}
      : { presence_penalty: number(source.presence_penalty, "request.presence_penalty", -2, 2) }),
    ...(source.frequency_penalty === undefined
      ? {}
      : { frequency_penalty: number(source.frequency_penalty, "request.frequency_penalty", -2, 2) }),
    ...(source.parallel_tool_calls === undefined
      ? {}
      : { parallel_tool_calls: boolean(source.parallel_tool_calls, "request.parallel_tool_calls") }),
    ...(source.stream === undefined ? {} : { stream: boolean(source.stream, "request.stream") }),
    ...(source.stream_options === undefined ? {} : { stream_options: streamOptions(source.stream_options) }),
    ...(source.store === undefined ? {} : { store: boolean(source.store, "request.store") }),
    ...(metadata === undefined ? {} : { metadata: metadata as Record<string, string> }),
  }
}
