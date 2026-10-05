import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Ref, Schema } from "effect"
import { Request as RequestSchema } from "@better-router/core/GenerationSchema"
import { example, upstream } from "../../test/Host.js"
import { openAiResponse, openAiStream } from "../../test/Fixtures.js"

const upstreamResponse = openAiResponse("private-upstream-model", "router test output")

const requestBody = Schema.decodeUnknownEffect(Schema.fromJsonString(RequestSchema))
const printedOutput = Schema.decodeUnknownEffect(
	Schema.fromJsonString(
		Schema.Struct({ model: Schema.String, text: Schema.String, usage: Schema.Json }),
	),
)

it.live("runs the SDK example through a declared Responses deployment", () =>
	Effect.gen(function* () {
		const fakeUpstream = yield* upstream((_request, serverResponse) => {
			serverResponse.writeHead(200, { "content-type": "text/event-stream" })
			serverResponse.end(openAiStream(upstreamResponse.model, "router test output"))
		})
		const process = yield* example("sdk-call", {
			OPENAI_API_KEY: "test-secret",
			OPENAI_MODEL: "private-upstream-model",
			ROUTER_MODEL: "sdk-local",
			OPENAI_RESPONSES_URL: `${fakeUpstream.url}/v1/responses`,
		})
		const exit = yield* process.awaitExit
		const output = (yield* Ref.get(process.output)).join("")

		assert.equal(exit.code, 0, output)
		assert.equal(exit.signal, null)

		const requests = yield* Ref.get(fakeUpstream.requests)
		assert.equal(requests.length, 1)
		const request = requests[0]
		assert.ok(request)
		assert.equal(request.method, "POST")
		assert.equal(request.path, "/v1/responses")
		assert.equal(request.headers.authorization, "Bearer test-secret")
		assert.equal(request.headers["content-type"], "application/json")
		assert.deepEqual(yield* requestBody(request.body), {
			model: "private-upstream-model",
			input: "Give me one practical tip for designing a model router.",
			stream: true,
		})

		const json = output.match(/\{[\s\S]*\}/)?.[0]
		assert.ok(json, output)
		assert.deepEqual(yield* printedOutput(json), {
			model: "sdk-local",
			text: "router test output",
			usage: upstreamResponse.usage,
		})
	}),
)
