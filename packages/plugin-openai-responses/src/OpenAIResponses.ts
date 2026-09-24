import { Effect, Schema, Stream } from "effect"
import type { Redacted } from "effect"
import type { ModelDeployment, ModelExecutor } from "@better-router/core/Deployment"
import type { ModelEvent } from "@better-router/core/Model"
import { ProviderError } from "@better-router/core/Deployment"
import { Sse } from "effect/unstable/encoding"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

export interface OpenAIResponsesDeploymentConfig {
  readonly id: string
  readonly model: string
  readonly apiKey: Redacted.Redacted<string>
  readonly url?: URL
  readonly organization?: string
}

/** The WebSocket path is optional per deployment, not per provider or ingress. */
export interface OpenAIResponsesDeployment<Requirements = never> extends ModelDeployment<Requirements> {
  readonly provider: "openai"
  readonly protocol: "openai.responses"
  readonly execute: {
    readonly http: ModelExecutor<Requirements>
    readonly websocket?: ModelExecutor<Requirements>
  }
}

const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const eventType = Schema.decodeUnknownEffect(Schema.Struct({ type: Schema.String }))
const isProviderError = Schema.is(ProviderError)

export class OpenAIResponsesInvalidDeploymentUrl extends Schema.TaggedError<OpenAIResponsesInvalidDeploymentUrl>()(
  "OpenAIResponsesInvalidDeploymentUrl",
  { message: Schema.String },
) {}

function failure(kind: ProviderError["kind"], message: string, retryable = false, cause?: unknown): ProviderError {
  return { kind, message, retryable, ...(cause === undefined ? {} : { cause }) }
}

function statusError(status: number): ProviderError {
  if (status === 429) return failure("rate_limited", "Upstream rate limited the request", true)
  if (status === 401 || status === 403) return failure("unauthorized", "Upstream authentication failed")
  if (status === 408 || status === 504) return failure("timeout", "Upstream request timed out")
  if (status >= 500) return failure("unavailable", "Upstream is unavailable")
  return failure("invalid_request", `Upstream rejected the request (${status})`)
}

function events(bytes: Stream.Stream<Uint8Array, unknown>): Stream.Stream<ModelEvent, ProviderError> {
  return Stream.suspend(() => {
    let terminal = false
    return bytes.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1024 * 1024 })),
      Stream.mapEffect((frame) =>
        Effect.gen(function* () {
          if (frame.data === "[DONE]") {
            if (!terminal) return yield* Effect.fail(failure("unknown", "Upstream ended before a terminal response"))
            return null
          }
          if (terminal) return yield* Effect.fail(failure("unknown", "Events followed the terminal response"))
          const value = yield* json(frame.data).pipe(
            Effect.mapError((cause) => failure("unknown", "Invalid upstream SSE JSON", false, cause)),
          )
          const parsed = yield* eventType(value).pipe(
            Effect.mapError((cause) => failure("unknown", "Invalid upstream event", false, cause)),
          )
          if (frame.event !== "message" && frame.event !== parsed.type) {
            return yield* Effect.fail(failure("unknown", "Upstream SSE event type mismatch"))
          }
          if (
            parsed.type === "response.completed" ||
            parsed.type === "response.incomplete" ||
            parsed.type === "response.failed"
          ) {
            if (
              !value ||
              typeof value !== "object" ||
              !("response" in value) ||
              !value.response ||
              typeof value.response !== "object" ||
              !("output" in value.response) ||
              !Array.isArray(value.response.output) ||
              !("id" in value.response) ||
              typeof value.response.id !== "string" ||
              !("object" in value.response) ||
              value.response.object !== "response" ||
              !("model" in value.response) ||
              typeof value.response.model !== "string" ||
              !("created_at" in value.response) ||
              typeof value.response.created_at !== "number" ||
              !Number.isFinite(value.response.created_at) ||
              !("status" in value.response) ||
              value.response.status !== parsed.type.slice("response.".length)
            ) {
              return yield* Effect.fail(failure("unknown", "Invalid terminal response snapshot"))
            }
            terminal = true
          }
          return value as ModelEvent
        }),
      ),
      Stream.filter((value) => value !== null),
      Stream.map((value) => value as ModelEvent),
      Stream.concat(
        Stream.unwrap(
          Effect.sync(() =>
            terminal
              ? Stream.empty
              : Stream.fail(failure("unknown", "Upstream stream ended without a terminal response")),
          ),
        ),
      ),
      Stream.mapError((cause): ProviderError =>
        isProviderError(cause) ? cause : failure("unknown", "Upstream event stream failed", false, cause),
      ),
    )
  })
}

/** Bind a private OpenAI Responses model and credentials to an Effect HTTP executor. */
export function make(config: OpenAIResponsesDeploymentConfig): OpenAIResponsesDeployment<HttpClient.HttpClient> {
  const url = config.url ?? new URL("https://api.openai.com/v1/responses")
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OpenAIResponsesInvalidDeploymentUrl({ message: "Responses URL must use HTTP(S)" })
  }
  return {
    id: config.id,
    provider: "openai",
    protocol: "openai.responses",
    model: config.model,
    execute: {
      http: (request) =>
        Effect.gen(function* () {
          const extension = [...(Array.isArray(request.input) ? request.input : []), ...(request.tools ?? [])].some(
            (item) =>
              typeof item === "object" &&
              item !== null &&
              "type" in item &&
              typeof item.type === "string" &&
              item.type.includes(":"),
          )
          if (extension || request.background) {
            return yield* Effect.fail(
              failure(
                "unsupported",
                extension
                  ? "OpenResponses extension items require a provider adapter"
                  : "Background responses are not supported by this deployment",
              ),
            )
          }
          const client = yield* HttpClient.HttpClient
          const organization = config.organization
            ? HttpClientRequest.setHeader("openai-organization", config.organization)
            : (outgoing: HttpClientRequest.HttpClientRequest) => outgoing
          const outgoing = HttpClientRequest.post(url.toString()).pipe(
            HttpClientRequest.bearerToken(config.apiKey),
            HttpClientRequest.setHeader("content-type", "application/json"),
            HttpClientRequest.bodyJsonUnsafe({ ...request, stream: true }),
            organization,
          )
          const response = yield* client
            .execute(outgoing)
            .pipe(Effect.mapError((cause) => failure("unavailable", "Upstream connection failed", false, cause)))
          if (response.status < 200 || response.status >= 300) return yield* Effect.fail(statusError(response.status))
          if (!response.headers["content-type"]?.toLowerCase().startsWith("text/event-stream")) {
            return yield* Effect.fail(failure("unknown", "Expected an upstream event stream"))
          }
          return events(response.stream)
        }),
    },
  }
}
