import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"

const source = "https://www.openresponses.org/openapi/2026-04-24/openapi.json"
const sha256 = "d598753c3a86fd8a2434828fe39dcc8786a7a694bbe46080a0d24c9fa40e72df"
const output = "packages/plugin-openai-responses/src/generated/OpenResponses.ts"
const schemaOutput = "packages/plugin-openai-responses/src/generated/OpenResponsesSchema.json"
const parseJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))
const documentFields = Schema.Struct({
  info: Schema.Struct({ version: Schema.String }),
  components: Schema.Struct({ schemas: Schema.Record(Schema.String, Schema.Json) }),
})
const object = Schema.Record(Schema.String, Schema.Json)

const stripDiscriminators = (value) =>
  Array.isArray(value)
    ? value.map(stripDiscriminators)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== "discriminator")
            .map(([key, entry]) => [key, stripDiscriminators(entry)]),
        )
      : value

const run = (command, args) =>
  Effect.callback((resume) => {
    const child = spawn(command, args, { stdio: "inherit" })
    child.once("error", (cause) => resume(Effect.fail(cause)))
    child.once("exit", (code) => resume(code === 0 ? Effect.void : Effect.fail(new Error(`Generator exited with ${code}`))))
    return Effect.sync(() => child.kill())
  })

const program = Effect.scoped(
  Effect.gen(function* () {
    const temporary = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(join(tmpdir(), "better-router-openresponses-"))),
      (directory) => Effect.orDie(Effect.tryPromise(() => rm(directory, { recursive: true, force: true }))),
    )
    const response = yield* Effect.tryPromise(() => fetch(source))
    if (!response.ok) return yield* Effect.fail(new Error(`Failed to fetch ${source}: ${response.status}`))
    const body = yield* Effect.tryPromise(() => response.text())
    if (createHash("sha256").update(body).digest("hex") !== sha256) {
      return yield* Effect.fail(new Error(`OpenResponses schema has changed at ${source}`))
    }
    const parsed = yield* parseJson(body)
    const fields = yield* Schema.decodeUnknownEffect(documentFields)(parsed)
    if (fields.info.version !== "2026-04-24") {
      return yield* Effect.fail(new Error("Unexpected OpenResponses schema version"))
    }
    const schema = yield* Schema.decodeUnknownEffect(object)(parsed)
    const components = yield* Schema.decodeUnknownEffect(object)(schema.components)
    const schemas = yield* Schema.decodeUnknownEffect(object)(components.schemas)
    const empty = yield* Schema.decodeUnknownEffect(object)(schemas.EmptyModelParam)
    const normalized = stripDiscriminators({
      ...schema,
      components: {
        ...components,
        schemas: {
          ...schemas,
          EmptyModelParam: { ...empty, additionalProperties: true },
        },
      },
    })
    const encoded = JSON.stringify(normalized)
    const schemaFile = join(temporary, "openresponses.json")
    const typesFile = join(temporary, "OpenResponses.ts")
    yield* Effect.tryPromise(() => writeFile(schemaFile, encoded))
    const check = process.argv.includes("--check")
    yield* run("yarn", ["dlx", "-p", "openapi-typescript@7.13.0", "-p", "typescript@5.9.3", "openapi-typescript", schemaFile, "--immutable", "-o", typesFile])
    yield* run("prettier", ["--write", typesFile, "--config", ".prettierrc.json", "--print-width", "120"])
    const generated = yield* Effect.tryPromise(() => readFile(typesFile, "utf8"))
    if (!generated.includes('type: "message"') || generated.includes('type: "UserMessageItemParam"')) {
      return yield* Effect.fail(new Error("Generated discriminators do not match the OpenResponses wire format"))
    }
    if (check) {
      const previous = yield* Effect.tryPromise(() => readFile(schemaOutput, "utf8"))
      if (previous !== encoded + "\n") return yield* Effect.fail(new Error("Generated runtime schema is out of date"))
      const previousTypes = yield* Effect.tryPromise(() => readFile(output, "utf8"))
      if (previousTypes !== generated) return yield* Effect.fail(new Error("Generated types are out of date"))
    } else {
      yield* Effect.tryPromise(() => writeFile(schemaOutput, encoded + "\n"))
      yield* Effect.tryPromise(() => writeFile(output, generated))
    }
  }),
)

await Effect.runPromise(program)
