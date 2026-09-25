import type { components, operations } from "./OpenResponses.js"

export type ModelName = string

type Schemas = components["schemas"]
type CreateResponse = Schemas["CreateResponseBody"]
type StandardEvent = operations["createResponse"]["responses"][200]["content"]["text/event-stream"]

export type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T
  : T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[]
  : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T

/** Extension identifiers must use an implementor prefix, e.g. "acme:search_result". */
export type ExtensionType = `${string}:${string}`

/** Extension items are not portable between deployments without an adapter. */
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

/** Extension events must not be required to reconstruct the standard response. */
export interface ExtensionEvent {
  readonly type: ExtensionType
  readonly sequence_number: number
  readonly [key: string]: unknown
}

export type InputItem = DeepReadonly<Schemas["ItemParam"]> | ExtensionItem
export type OutputItem = DeepReadonly<Schemas["ItemField"]> | ExtensionItem
export type ModelTool = DeepReadonly<Schemas["ResponsesToolParam"]> | ExtensionTool

/** OpenResponses create body with the router's public model alias required. */
export type ModelRequest = DeepReadonly<Omit<CreateResponse, "model" | "input" | "tools">> & {
  readonly model: ModelName
  readonly input?: string | readonly InputItem[] | null
  readonly tools?: readonly ModelTool[] | null
}

/** The full OpenResponses response, including ordered output items and metadata. */
export type ModelResponse = DeepReadonly<Omit<Schemas["ResponseResource"], "output" | "tools">> & {
  readonly output: readonly OutputItem[]
  readonly tools: readonly (DeepReadonly<Schemas["Tool"]> | ExtensionTool)[]
}

type WithExtensions<Event> = Event extends { readonly response: unknown }
  ? Omit<Event, "response"> & { readonly response: ModelResponse }
  : Event extends { readonly item: unknown }
    ? Omit<Event, "item"> & { readonly item: Event["item"] | ExtensionItem }
    : Event

/** OpenResponses semantic events, with namespaced extensions kept opaque. */
export type ModelEvent = DeepReadonly<WithExtensions<StandardEvent>> | ExtensionEvent
