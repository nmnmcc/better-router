import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { test } from "vitest"
import { Effect, Ref } from "effect"
import { snapshot } from "@better-router/core/ModelEvents"
import type { Protocol } from "../src/Matrix.js"

function writeEvent(response: import("node:http").ServerResponse, type: string, data: unknown) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
}

function respond(response: import("node:http").ServerResponse, protocol: Protocol, output: "text" | "tool") {
  response.writeHead(200, { "content-type": "text/event-stream" })
  if (protocol === "responses") {
    const item = output === "tool" ? { id: "fc_matrix", type: "function_call", status: "completed",
      call_id: "call_next", name: "lookup", arguments: '{"query":"A"}' } as const
      : { id: "msg_matrix", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: "Hello", annotations: [] }] } as const
    const usage = { input_tokens: 3, output_tokens: 2, total_tokens: 5,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
    const result = snapshot({ model: "private" }, "resp_matrix", 1234, "private", [item], "completed", usage, 1235)
    writeEvent(response, "response.created", { type: "response.created", sequence_number: 0,
      response: snapshot({ model: "private" }, "resp_matrix", 1234, "private", [], "in_progress", null, null) })
    writeEvent(response, "response.output_item.added", { type: "response.output_item.added", sequence_number: 1,
      output_index: 0, item })
    writeEvent(response, output === "tool" ? "response.function_call_arguments.delta" : "response.output_text.delta",
      { type: output === "tool" ? "response.function_call_arguments.delta" : "response.output_text.delta",
        sequence_number: 2, item_id: item.id, output_index: 0, content_index: 0, delta: output === "tool" ? '{"query":"A"}' : "Hello" })
    writeEvent(response, "response.completed", { type: "response.completed", sequence_number: 3, response: result })
    response.end("data: [DONE]\n\n")
  } else if (protocol === "chat") {
    const chunks = output === "tool" ? [
      [{ role: "assistant" }, null],
      [{ tool_calls: [{ index: 0, id: "call_next", type: "function", function: { name: "lookup", arguments: "" } }] }, null],
      [{ tool_calls: [{ index: 0, function: { arguments: '{"query":"A"}' } }] }, null],
      [{}, "tool_calls"],
    ] as const : [[{ role: "assistant" }, null], [{ content: "Hello" }, null], [{}, "stop"]] as const
    response.write(chunks.map(([delta, finish_reason]) => `data: ${JSON.stringify({ id: "chatcmpl_matrix", object: "chat.completion.chunk", created: 1234,
      model: "private", choices: [{ index: 0, delta, finish_reason }] })}\n\n`).join(""))
    response.write(`data: ${JSON.stringify({ id: "chatcmpl_matrix", object: "chat.completion.chunk", created: 1234,
      model: "private", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`)
    response.end("data: [DONE]\n\n")
  } else {
    const events = [
      { type: "message_start", message: { id: "msg_matrix", type: "message", role: "assistant", model: "private",
        content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: output === "tool"
        ? { type: "tool_use", id: "call_next", name: "lookup", input: {} } : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: output === "tool"
        ? { type: "input_json_delta", partial_json: '{"query":"A"}' } : { type: "text_delta", text: "Hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: output === "tool" ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]
    response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""))
  }
}

export function matrixCase(ingress: Protocol, upstreamProtocol: Protocol) {
  test(`${ingress} to ${upstreamProtocol} exchanges native JSON and SSE over HTTP`, async () => {
    const calls = Ref.makeUnsafe<readonly { readonly headers: import("node:http").IncomingHttpHeaders; readonly body: Record<string, unknown> }[]>([])
    const callsSnapshot = () => Effect.runSync(Ref.get(calls))
    const output = Ref.makeUnsafe<"text" | "tool">("text")
    const fault = Ref.makeUnsafe<"none" | "malformed" | "truncated" | "extra" | "rate" | "unavailable" | "hold" | "no-usage">("none")
    const upstreamClosed = Promise.withResolvers<void>()
    const upstream = createServer(async (request, response) => {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString())
      Effect.runSync(Ref.update(calls, (entries) => [...entries, { headers: request.headers, body }]))
      const currentFault = Effect.runSync(Ref.get(fault))
      if (currentFault === "rate" || currentFault === "unavailable") {
        response.writeHead(currentFault === "rate" ? 429 : 503, { "content-type": "application/json" })
        response.end('{"error":"unavailable"}')
        return
      }
      if (currentFault !== "none") {
        response.writeHead(200, { "content-type": "text/event-stream" })
        if (currentFault === "no-usage") {
          writeEvent(response, "response.created", { type: "response.created", sequence_number: 0,
            response: snapshot({ model: "private" }, "resp_no_usage", 1234, "private", [], "in_progress", null, null) })
          writeEvent(response, "response.completed", { type: "response.completed", sequence_number: 1,
            response: snapshot({ model: "private" }, "resp_no_usage", 1234, "private", [], "completed", null, 1235) })
          response.end("data: [DONE]\n\n")
        } else if (currentFault === "hold") {
          response.on("close", () => upstreamClosed.resolve())
          if (upstreamProtocol === "responses") writeEvent(response, "response.created", { type: "response.created", sequence_number: 0,
            response: snapshot({ model: "private" }, "resp_hold", 1234, "private", [], "in_progress", null, null) })
          else if (upstreamProtocol === "anthropic") writeEvent(response, "message_start", { type: "message_start",
            message: { id: "msg_hold", type: "message", role: "assistant", model: "private", content: [], usage: { input_tokens: 1 } } })
          else response.write('data: {"id":"chatcmpl_hold","object":"chat.completion.chunk","created":1234,"model":"private","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n')
        } else if (currentFault === "malformed") {
          response.end(upstreamProtocol === "chat"
            ? 'data: {"object":"chat.completion.chunk","choices":[{}]}\n\n'
            : upstreamProtocol === "anthropic" ? 'event: message_start\ndata: {"type":"message_start","message":17}\n\n'
              : 'event: response.created\ndata: {not json}\n\n')
        } else if (currentFault === "extra") {
          if (upstreamProtocol === "responses") {
            writeEvent(response, "response.completed", { type: "response.completed", sequence_number: 0,
              response: snapshot({ model: "private" }, "resp_extra", 1234, "private", [], "completed", null, 1235) })
            writeEvent(response, "response.output_text.delta", { type: "response.output_text.delta", sequence_number: 1,
              item_id: "msg_late", output_index: 0, content_index: 0, delta: "late" })
            response.end("data: [DONE]\n\n")
          } else if (upstreamProtocol === "chat") {
            response.write('data: {"id":"chatcmpl_extra","object":"chat.completion.chunk","created":1234,"model":"private","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
            response.write("data: [DONE]\n\n")
            response.end('data: {"unexpected":true}\n\n')
          } else {
            const events = [
              { type: "message_start", message: { id: "msg_extra", type: "message", role: "assistant", model: "private", content: [], usage: { input_tokens: 1 } } },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
              { type: "message_stop" }, { type: "ping" },
            ]
            response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""))
          }
        } else {
          response.end(upstreamProtocol === "chat"
            ? 'data: {"id":"chatcmpl_short","object":"chat.completion.chunk","created":1234,"model":"private","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n'
            : upstreamProtocol === "anthropic"
              ? 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_short","model":"private","usage":{"input_tokens":1}}}\n\n'
              : `event: response.created\ndata: ${JSON.stringify({ type: "response.created", sequence_number: 0,
                response: snapshot({ model: "private" }, "resp_short", 1234, "private", [], "in_progress", null, null) })}\n\n`)
        }
        return
      }
      respond(response, upstreamProtocol, Effect.runSync(Ref.get(output)))
    })
    upstream.listen(0, "127.0.0.1")
    const child = Ref.makeUnsafe<ReturnType<typeof spawn> | undefined>(undefined)
    try {
      await once(upstream, "listening")
      const address = upstream.address()
      if (!address || typeof address === "string") assert.fail("Expected an upstream port")
      const running = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
        cwd: `${process.cwd()}/examples/matrix/${ingress}-to-${upstreamProtocol}`,
        env: { ...process.env, GATEWAY_API_KEY: "client", GATEWAY_MODEL: "matrix", GATEWAY_PORT: "0",
          OPENAI_API_KEY: "provider", ANTHROPIC_API_KEY: "provider", OPENAI_MODEL: "private", ANTHROPIC_MODEL: "private",
          OPENAI_CHAT_URL: `http://127.0.0.1:${address.port}/v1/chat/completions`,
          OPENAI_RESPONSES_URL: `http://127.0.0.1:${address.port}/v1/responses`,
          ANTHROPIC_MESSAGES_URL: `http://127.0.0.1:${address.port}/v1/messages` },
        stdio: ["ignore", "pipe", "pipe"],
      })
      Effect.runSync(Ref.set(child, running))
      const logs = Ref.makeUnsafe("")
      const port = await Promise.race([
        new Promise<number>((resolve, reject) => {
          const onData = (data: Buffer) => {
            Effect.runSync(Ref.update(logs, (text) => text + data.toString()))
            const match = /Listening on (?:https?:\/\/)?127\.0\.0\.1:(\d+)/.exec(Effect.runSync(Ref.get(logs)))
            if (match) resolve(Number(match[1]))
          }
          running.stdout?.on("data", onData)
          running.stderr?.on("data", onData)
          running.once("exit", (code) => reject(new Error(`Matrix server exited (${code}): ${Effect.runSync(Ref.get(logs))}`)))
        }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Matrix startup timed out: ${Effect.runSync(Ref.get(logs))}`)), 10_000).unref()),
      ])
      const path = ingress === "chat" ? "/v1/chat/completions" : ingress === "responses" ? "/v1/responses" : "/v1/messages"
      const body = ingress === "chat" ? { model: "matrix", messages: [{ role: "user", content: "Hi" }] }
        : ingress === "responses" ? { model: "matrix", input: "Hi" }
          : { model: "matrix", max_tokens: 64, messages: [{ role: "user", content: "Hi" }] }
      const send = (stream: boolean, key = "client") => fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST", headers: ingress === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" }
          : { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ ...body, stream }),
      })
      assert.equal((await send(false, "wrong")).status, 401)
      assert.equal(callsSnapshot().length, 0)
      if (ingress === "anthropic") {
        const missingVersion = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST",
          headers: { "x-api-key": "client", "content-type": "application/json" }, body: JSON.stringify(body) })
        assert.equal(missingVersion.status, 400)
        assert.equal(callsSnapshot().length, 0)
      }
      const oversized = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST", headers: ingress === "anthropic"
          ? { "x-api-key": "client", "anthropic-version": "2023-06-01", "content-type": "application/json" }
          : { authorization: "Bearer client", "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new Uint8Array(1024 * 1024))
          controller.enqueue(new Uint8Array(1))
          controller.close()
        } }),
        duplex: "half", signal: AbortSignal.timeout(3000),
      } as RequestInit & { duplex: "half" })
      assert.equal(oversized.status, 413)
      assert.equal(callsSnapshot().length, 0)
      const json = await send(false)
      assert.equal(json.status, 200, await json.clone().text())
      const result = await json.json() as Record<string, unknown>
      assert.equal(result.model, "matrix")
      const text = ingress === "chat" ? ((result.choices as { message: { content: string } }[])[0].message.content)
        : ingress === "responses" ? ((result.output as { content: { text: string }[] }[])[0].content[0].text)
          : ((result.content as { text: string }[])[0].text)
      assert.equal(text, "Hello")
      const streamed = await send(true)
      assert.equal(streamed.status, 200, await streamed.clone().text())
      const frames = await streamed.text()
      assert.match(frames, /Hello/)
      assert.match(frames, ingress === "chat" ? /data: \[DONE\]/ : ingress === "responses" ? /event: response.completed/ : /event: message_stop/)
      assert.equal(callsSnapshot().length, 2)
      assert.equal(callsSnapshot()[0].body.model, "private")
      assert.equal(callsSnapshot()[0].body.stream, true)
      assert.equal(upstreamProtocol === "anthropic" ? callsSnapshot()[0].headers["x-api-key"] : callsSnapshot()[0].headers.authorization,
        upstreamProtocol === "anthropic" ? "provider" : "Bearer provider")
      if (upstreamProtocol === "anthropic") {
        assert.equal(callsSnapshot()[0].headers["anthropic-version"], "2023-06-01")
        assert.equal(callsSnapshot()[0].body.max_tokens, ingress === "anthropic" ? 64 : 1024)
      }
      const invalidBody = { ...body, stream: "yes" }
      const unsupportedBody = ingress === "chat"
        ? { model: "matrix", messages: [{ role: "user", content: [{ type: "input_audio", audio_url: "data:audio/wav;base64,AA==" }] }] }
        : ingress === "responses" ? { model: "matrix", input: [{ type: "reasoning", summary: [] }] }
          : { ...body, thinking: { type: "enabled", budget_tokens: 100 } }
      await Effect.runPromise(Effect.forEach([[invalidBody, 400], [unsupportedBody, 422]] as const,
        ([candidate, status]) => Effect.promise(async () => {
        const count: number = callsSnapshot().length
        const rejected = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST",
          headers: ingress === "anthropic"
            ? { "x-api-key": "client", "anthropic-version": "2023-06-01", "content-type": "application/json" }
            : { authorization: "Bearer client", "content-type": "application/json" },
          body: JSON.stringify(candidate),
        })
        assert.equal(rejected.status, status, await rejected.clone().text())
        assert.equal(callsSnapshot().length, count)
      })))
      const imageUrl = "https://example.com/photo.png"
      const imageData = "data:image/png;base64,aGVsbG8="
      const imageBody = ingress === "chat" ? { model: "matrix", messages: [{ role: "user", content: [
        { type: "text", text: "Describe" },
        { type: "image_url", image_url: { url: imageUrl } }, { type: "image_url", image_url: { url: imageData } },
      ] }] } : ingress === "responses" ? { model: "matrix", input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "Describe" }, { type: "input_image", image_url: imageUrl },
        { type: "input_image", image_url: imageData },
      ] }] } : { model: "matrix", max_tokens: 64, messages: [{ role: "user", content: [
        { type: "text", text: "Describe" }, { type: "image", source: { type: "url", url: imageUrl } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
      ] }] }
      const imageResponse = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST", headers: ingress === "anthropic"
          ? { "x-api-key": "client", "anthropic-version": "2023-06-01", "content-type": "application/json" }
          : { authorization: "Bearer client", "content-type": "application/json" },
        body: JSON.stringify(imageBody),
      })
      assert.equal(imageResponse.status, 200, await imageResponse.clone().text())
      const imageResult = await imageResponse.json() as Record<string, unknown>
      const inboundUsage = ingress === "chat" ? imageResult.usage as Record<string, number>
        : ingress === "responses" ? imageResult.usage as Record<string, number>
          : imageResult.usage as Record<string, number>
      assert.equal(inboundUsage[ingress === "chat" ? "prompt_tokens" : ingress === "responses" ? "input_tokens" : "input_tokens"], 3)
      assert.equal(inboundUsage[ingress === "chat" ? "completion_tokens" : ingress === "responses" ? "output_tokens" : "output_tokens"], 2)
      const sent = callsSnapshot().at(-1)!.body
      const nativeParts = upstreamProtocol === "chat"
        ? (sent.messages as { content: Record<string, unknown>[] }[])[0].content
        : upstreamProtocol === "anthropic" ? (sent.messages as { content: Record<string, unknown>[] }[])[0].content
          : (sent.input as { content: Record<string, unknown>[] }[])[0].content
      if (upstreamProtocol === "chat") {
        assert.deepEqual(nativeParts.slice(1), [
          { type: "image_url", image_url: { url: imageUrl, detail: "auto" } },
          { type: "image_url", image_url: { url: imageData, detail: "auto" } },
        ])
      } else if (upstreamProtocol === "anthropic") {
        assert.deepEqual(nativeParts.slice(1), [
          { type: "image", source: { type: "url", url: imageUrl } },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
        ])
      } else assert.deepEqual(nativeParts.slice(1).map((part) => part.image_url), [imageUrl, imageData])
      const invalidImage = ingress === "chat" ? { model: "matrix", messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: "javascript:alert(1)" } },
      ] }] } : ingress === "responses" ? { model: "matrix", input: [{ type: "message", role: "user", content: [
        { type: "input_image", image_url: "javascript:alert(1)" },
      ] }] } : { model: "matrix", max_tokens: 64, messages: [{ role: "user", content: [
        { type: "image", source: { type: "url", url: "javascript:alert(1)" } },
      ] }] }
      const imageCount: number = callsSnapshot().length
      const rejectedImage = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST",
        headers: ingress === "anthropic"
          ? { "x-api-key": "client", "anthropic-version": "2023-06-01", "content-type": "application/json" }
          : { authorization: "Bearer client", "content-type": "application/json" }, body: JSON.stringify(invalidImage),
      })
      assert.equal(rejectedImage.status, 422)
      assert.equal(callsSnapshot().length, imageCount)
      if (ingress === "anthropic") {
        const badChoice = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST",
          headers: { "x-api-key": "client", "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ ...body, tool_choice: { type: "auto", disable_parallel_tool_use: "yes" } }),
        })
        assert.equal(badChoice.status, 400)
        assert.equal(callsSnapshot().length, imageCount)
      }
      const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
      const toolBody = ingress === "chat" ? { model: "matrix", messages: [
        { role: "user", content: "Find A" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function",
          function: { name: "lookup", arguments: '{"query":"A"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "Found A" },
      ], tools: [{ type: "function", function: { name: "lookup", description: "Find", parameters: schema } }] }
        : ingress === "responses" ? { model: "matrix", input: [
          { type: "message", role: "user", content: "Find A" },
          { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"A"}' },
          { type: "function_call_output", call_id: "call_1", output: "Found A" },
        ], tools: [{ type: "function", name: "lookup", description: "Find", parameters: schema }] }
          : { model: "matrix", max_tokens: 64, messages: [
            { role: "user", content: "Find A" },
            { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "lookup", input: { query: "A" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "Found A" }] },
          ], tools: [{ name: "lookup", description: "Find", input_schema: schema }] }
      const toolResponse = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST", headers: ingress === "anthropic"
          ? { "x-api-key": "client", "anthropic-version": "2023-06-01", "content-type": "application/json" }
          : { authorization: "Bearer client", "content-type": "application/json" }, body: JSON.stringify(toolBody),
      })
      assert.equal(toolResponse.status, 200, await toolResponse.clone().text())
      const nativeTool = callsSnapshot().at(-1)!.body
      assert.equal(upstreamProtocol === "anthropic"
        ? (nativeTool.tools as { name: string }[])[0].name
        : upstreamProtocol === "chat"
          ? (nativeTool.tools as { function: { name: string } }[])[0].function.name
          : (nativeTool.tools as { name: string }[])[0].name, "lookup")
      if (upstreamProtocol === "responses") {
        const history = nativeTool.input as { type: string; call_id?: string; output?: string }[]
        assert.deepEqual(history.slice(1).map(({ type, call_id, output }) => [type, call_id, output]), [
          ["function_call", "call_1", undefined], ["function_call_output", "call_1", "Found A"],
        ])
      } else if (upstreamProtocol === "chat") {
        const history = nativeTool.messages as { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[]
        assert.equal(history[1].tool_calls?.[0].id, "call_1")
        assert.deepEqual([history[2].role, history[2].tool_call_id], ["tool", "call_1"])
      } else {
        const history = nativeTool.messages as { content: { type: string; id?: string; tool_use_id?: string }[] }[]
        assert.deepEqual([history[1].content[0].type, history[1].content[0].id], ["tool_use", "call_1"])
        assert.deepEqual([history[2].content[0].type, history[2].content[0].tool_use_id], ["tool_result", "call_1"])
      }
      const jsonSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] }
      const schemaBody = ingress === "chat"
        ? { ...body, response_format: { type: "json_schema", json_schema: { name: "answer", schema: jsonSchema, strict: true } } }
        : ingress === "responses" ? { ...body, text: { format: { type: "json_schema", name: "answer", schema: jsonSchema, strict: true } } }
          : { ...body, output_config: { format: { type: "json_schema", schema: jsonSchema } } }
      const schemaResponse = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST", headers: ingress === "anthropic"
          ? { "x-api-key": "client", "anthropic-version": "2023-06-01", "content-type": "application/json" }
          : { authorization: "Bearer client", "content-type": "application/json" }, body: JSON.stringify(schemaBody),
      })
      assert.equal(schemaResponse.status, 200, await schemaResponse.clone().text())
      const nativeSchema = callsSnapshot().at(-1)!.body
      assert.deepEqual(upstreamProtocol === "chat"
        ? (nativeSchema.response_format as { json_schema: { schema: unknown } }).json_schema.schema
        : upstreamProtocol === "anthropic"
          ? (nativeSchema.output_config as { format: { schema: unknown } }).format.schema
          : (nativeSchema.text as { format: { schema: unknown } }).format.schema, jsonSchema)
      const optionsBody = { ...body, temperature: 0.5, top_p: 0.7,
        ...(ingress === "chat" ? { max_completion_tokens: 96 } : ingress === "responses" ? { max_output_tokens: 96 } : { max_tokens: 96 }) }
      const optionsResponse = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST", headers: ingress === "anthropic"
          ? { "x-api-key": "client", "anthropic-version": "2023-06-01", "content-type": "application/json" }
          : { authorization: "Bearer client", "content-type": "application/json" }, body: JSON.stringify(optionsBody),
      })
      assert.equal(optionsResponse.status, 200, await optionsResponse.clone().text())
      const nativeOptions = callsSnapshot().at(-1)!.body
      assert.equal(nativeOptions[upstreamProtocol === "chat" ? "max_completion_tokens"
        : upstreamProtocol === "anthropic" ? "max_tokens" : "max_output_tokens"], 96)
      assert.deepEqual([nativeOptions.temperature, nativeOptions.top_p], [0.5, 0.7])
      Effect.runSync(Ref.set(output, "tool"))
      const toolJson = await send(false)
      assert.equal(toolJson.status, 200, await toolJson.clone().text())
      const toolResult = await toolJson.json() as Record<string, unknown>
      const nativeCall = ingress === "chat"
        ? ((toolResult.choices as { message: { tool_calls: { id: string; function: { arguments: string } }[] } }[])[0].message.tool_calls)[0]
        : ingress === "anthropic" ? (toolResult.content as { type: string; id: string; input: unknown }[])[0]
          : (toolResult.output as { type: string; call_id: string; arguments: string }[])[0]
      assert.equal(ingress === "responses" ? (nativeCall as { call_id: string }).call_id
        : (nativeCall as { id: string }).id, "call_next")
      assert.deepEqual("function" in nativeCall ? JSON.parse(nativeCall.function.arguments)
        : "input" in nativeCall ? nativeCall.input : JSON.parse(nativeCall.arguments), { query: "A" })
      const toolStream = await send(true)
      assert.equal(toolStream.status, 200, await toolStream.clone().text())
      const toolFrames = await toolStream.text()
      assert.match(toolFrames, /call_next/)
      assert.match(toolFrames, /lookup/)
      assert.match(toolFrames, ingress === "chat" ? /data: \[DONE\]/ : ingress === "responses" ? /event: response.completed/ : /event: message_stop/)
      if (ingress === "responses") {
        const count = callsSnapshot().length
        const unsupported = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { authorization: "Bearer client", "content-type": "application/json" },
          body: JSON.stringify({ model: "matrix", input: [{ type: "message", role: "user",
            content: [{ type: "input_text", text: "Hi", cache_control: { type: "ephemeral" } }] }] }),
        })
        assert.equal(unsupported.status, 422)
        assert.equal(callsSnapshot().length, count)
        const continuation = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: { authorization: "Bearer client", "content-type": "application/json" },
          body: JSON.stringify({ model: "matrix", input: "Continue", previous_response_id: "resp_previous" }),
        })
        assert.equal(continuation.status, upstreamProtocol === "responses" ? 200 : 422)
        assert.equal(callsSnapshot().length, count + (upstreamProtocol === "responses" ? 1 : 0))
        if (upstreamProtocol === "responses") assert.equal(callsSnapshot().at(-1)?.body.previous_response_id, "resp_previous")
      }
      await Effect.runPromise(Effect.forEach(["malformed", "truncated"] as const, (problem) =>
        Ref.set(fault, problem).pipe(Effect.flatMap(() => Effect.promise(async () => {
        const failed = await send(false)
        assert.equal(failed.status, 502, `${problem}: ${await failed.clone().text()}`)
        const streamedFailure = await send(true)
        assert.equal(streamedFailure.status, 200)
        const errorFrames = await streamedFailure.text()
        assert.match(errorFrames, ingress === "chat" ? /"error"/ : ingress === "responses" ? /event: error/ : /event: error/)
        assert.doesNotMatch(errorFrames, ingress === "anthropic" ? /event: message_stop/ : /data: \[DONE\]/)
      })))))
      await Effect.runPromise(Effect.forEach([["rate", 429], ["unavailable", 503]] as const, ([problem, status]) =>
        Ref.set(fault, problem).pipe(Effect.flatMap(() => Effect.forEach([false, true], (streaming) => Effect.promise(async () => {
          const failed = await send(streaming)
          assert.equal(failed.status, status, `${problem}: ${await failed.clone().text()}`)
          assert.match(failed.headers.get("content-type") ?? "", /application\/json/)
        }))))))
      Effect.runSync(Ref.set(fault, "extra"))
      const extra = await send(false)
      assert.equal(extra.status, 502, `post-terminal: ${await extra.clone().text()}`)
      const extraStream = await send(true)
      assert.equal(extraStream.status, 200)
      const extraFrames = await extraStream.text()
      assert.match(extraFrames, /event: error|"error"/)
      assert.doesNotMatch(extraFrames, ingress === "anthropic" ? /event: message_stop/ : /data: \[DONE\]/)
      if (ingress === "anthropic" && upstreamProtocol === "responses") {
        Effect.runSync(Ref.set(fault, "no-usage"))
        const missingUsage = await send(false)
        assert.equal(missingUsage.status, 502, await missingUsage.clone().text())
      }
      Effect.runSync(Ref.set(fault, "hold"))
      const holding = await send(true)
      assert.equal(holding.status, 200)
      const reader = holding.body!.getReader()
      assert.equal((await reader.read()).done, false)
      await reader.cancel()
      await Promise.race([upstreamClosed.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Upstream was not canceled")), 3000).unref())])
    } finally {
      const running = Effect.runSync(Ref.get(child))
      if (running) {
        const exited = running.exitCode === null ? once(running, "exit") : Promise.resolve()
        running.kill()
        await exited
      }
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  }, 15_000)
}
