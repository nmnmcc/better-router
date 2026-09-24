import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const source = "https://www.openresponses.org/openapi/2026-04-24/openapi.json"
const sha256 = "d598753c3a86fd8a2434828fe39dcc8786a7a694bbe46080a0d24c9fa40e72df"
const output = "packages/core/src/OpenResponses.ts"
const temporary = await mkdtemp(join(tmpdir(), "better-router-openresponses-"))

try {
  const response = await fetch(source)
  if (!response.ok) throw new Error(`Failed to fetch ${source}: ${response.status}`)
  const body = await response.text()
  if (createHash("sha256").update(body).digest("hex") !== sha256) {
    throw new Error(`OpenResponses schema has changed at ${source}`)
  }
  const schema = JSON.parse(body)
  if (schema.info?.version !== "2026-04-24") throw new Error("Unexpected OpenResponses schema version")

  // OpenAPI allows extra object properties by default; the generator treats this
  // empty placeholder for function JSON schemas as Record<string, never>.
  schema.components.schemas.EmptyModelParam.additionalProperties = true

  // The generator otherwise replaces valid enum values like "message" with schema names.
  const stripDiscriminators = (value) => {
    if (Array.isArray(value)) return value.map(stripDiscriminators)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "discriminator")
        .map(([key, entry]) => [key, stripDiscriminators(entry)]),
    )
  }

  const schemaFile = join(temporary, "openresponses.json")
  await writeFile(schemaFile, JSON.stringify(stripDiscriminators(schema)))
  const result = spawnSync(
    "yarn",
    [
      "dlx",
      "-p",
      "openapi-typescript@7.13.0",
      "-p",
      "typescript@5.9.3",
      "openapi-typescript",
      schemaFile,
      "--immutable",
      "-o",
      output,
      ...process.argv.slice(2),
    ],
    { stdio: "inherit" },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status ?? 1
  else if (!process.argv.includes("--check")) {
    const generated = await readFile(output, "utf8")
    if (!generated.includes('type: "message"') || generated.includes('type: "UserMessageItemParam"')) {
      throw new Error("Generated discriminators do not match the OpenResponses wire format")
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
