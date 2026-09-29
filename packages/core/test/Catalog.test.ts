import assert from "node:assert/strict"
import { it } from "@effect/vitest"
import { Effect, Option, Result, Schema } from "effect"
import { Capability, generation } from "@better-router/core/Capability"
import { CapabilityCatalog, make, layer } from "@better-router/core/Catalog"

const search: Capability = { id: "search", version: 1, projections: ["test.search"] }

it("constructs a capability catalog and rejects duplicate identifiers", () => {
	const catalog = make([generation, search])
	assert.equal(Result.isSuccess(catalog), true)
	if (Result.isFailure(catalog)) return

	const listed = Result.isSuccess(catalog) ? catalog.success : undefined
	assert.ok(listed)
	assert.deepEqual([...Effect.runSync(listed.list)].map(({ id }) => id).sort(), [
		"generation",
		"search",
	])
	assert.deepEqual(Effect.runSync(listed.get("search")), Option.some(search))
	assert.equal(Effect.runSync(listed.has("generation")), true)
	assert.equal(Effect.runSync(listed.has("missing")), false)

	const duplicate = make([search, search])
	assert.equal(Result.isFailure(duplicate), true)
	if (Result.isSuccess(duplicate)) return
	assert.deepEqual(Schema.encodeSync(Capability)(search), {
		id: "search",
		version: 1,
		projections: ["test.search"],
	})
	assert.equal(duplicate.failure.id, "search")
})

it.effect("provides the default generation capability through a Layer", () =>
	Effect.gen(function* () {
		const catalog = yield* CapabilityCatalog
		assert.equal(yield* catalog.has("generation"), true)
		assert.equal((yield* catalog.get("generation"))._tag, "Some")
	}).pipe(Effect.provide(layer())),
)
