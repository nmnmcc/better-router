# Testing

Tests protect the public contract at the smallest useful boundary. Package-local runtime tests live in `packages/<name>/test/*.test.ts`, and type contracts live in `packages/<name>/typetest/*.tst.ts`. Cross-package compile-time examples belong in `typetest/`; a full host and its local fake upstream belong in the example's `test/*.integration.test.ts`. Use `.ts` for every TypeScript test and config file; the root and each workspace package declare ESM in `package.json`.

## Choose the test boundary

- Use ordinary Vitest `it` for pure conversions, Schema decoding/encoding, and public HTTP API metadata. Assert the accepted result and rejected input or unsupported semantics explicitly.
- Use `it.effect` from `@effect/vitest` for Effects, Streams, Layers, fibers, and scoped resources. It supplies a test Scope and test services. Test a typed failure with `Effect.exit` or `Effect.flip`, distinguishing failures from defects when that distinction matters. Check finalizers after success, failure, and interruption where resources are acquired. Open a nested `Effect.scoped` only when the test must assert that a particular inner Scope has closed.
- Use TSTyche's `expect(...).type` for inference and assignability, including both accepted and rejected shapes. Use `@ts-expect-error` in compile-only examples when the exact offending expression is the contract. TypeScript 7 compiles the test files; TSTyche separately checks `*.tst.ts` against its pinned TypeScript 6.0.3.
- Keep tests for current behavior. A declaration-only module needs type contracts; add runtime cases when its executor exists.

## Cover observable behavior

For a changed router or plugin capability, cover successful output, typed errors and Schema wire shapes, service requirements, routing and fallback before the first event, and refusal to replay after an event. For a scoped capability, cover cancellation and resource release. For an HTTP endpoint, check authentication before upstream invocation, input validation and size limits, JSON and SSE projections, terminal `[DONE]` only on success, post-header failures, and client cancellation. Put assertions on stable fields and event order rather than opaque error strings or whole-object snapshots.

Provide a fresh test Layer or fake `HttpClient` at the external boundary; leave the domain operation itself unchanged. Use `TestClock` for timeouts and retries, not real sleeps. Host integration tests may use a fake upstream on `127.0.0.1` with port `0`; register teardown for the server, child process, and streams before asserting. Bound startup and cancellation waits. Required checks use no real provider, credentials, or external service.

Keep fixtures immutable: build events and byte frames from pure collection transforms, sequence case effects with `Effect.forEach`, and use scoped `Ref`/`Deferred` only when a host callback must communicate with an Effect test. Verify Schema decode and encode against the pinned request, response and event shapes, including extension variants and nested failure paths. For pure conversions, compare input before and after projection; for stateful streams, consume the same source twice and compare independently numbered output. Assert cancellation and finalization on suspended streams.

Host fixtures with a shared `Ref` run sequentially; independently created fixtures may run concurrently. Each case owns its Layer, server, counters, and cleanup. Review all owned code, tests, examples and scripts for loops, `let`/`var`, reassignment and in-place mutation: there is no syntax gate. Avoid `only` and committed skips in required suites. Add a regression test when fixing a bug, with a case that fails for the original behavior.

## Run the checks

Run project commands inside `devenv`. Runtime commands build workspace exports before running Vitest:

```sh
devenv shell -- yarn test:runtime packages/core/test/Router.test.ts
devenv shell -- yarn test-types
devenv shell -- yarn check
devenv shell -- yarn generate:openresponses --check
devenv shell -- yarn test:coverage
```

`check` builds, compiles workspace and test TypeScript, runs TSTyche, then runs every package and local-host runtime test. `test:coverage` builds and produces terminal and ignored `coverage/` HTML reports for package source, excluding generated OpenResponses types and barrel files. Coverage has no percentage gate; inspect the report for missed behavior. CI runs the same immutable install and checks and uploads the report.
