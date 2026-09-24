# Better Router

Effect-based, type-first LLM router workspace. The generic router and a Chat Completions to Responses HTTP gateway are runnable.

The application is configured once with model routes and a list of declarative plugins. The same configured router serves in-process SDK calls and, when plugins contribute HTTP endpoints, a hosted HTTP application. There is no gateway plugin or imperative plugin registry.

| Package                                         | Responsibility                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@better-router/core`                           | OpenResponses IR, deployments, routing, transforms, HTTP composition, and declarative plugin contracts |
| `@better-router/plugin-openai-chat-completions` | OpenAI Chat Completions conversion and authenticated HTTP endpoint                                     |
| `@better-router/plugin-openai-responses`        | OpenAI Responses upstream deployment                                                                   |
| `@better-router/plugin-anthropic-messages`      | Anthropic Messages deployment contracts (HTTP only)                                                   |

Packages are flat under `packages/`, with plugins named `plugin-{creator}-{protocol}`. Like Effect, each package exposes focused modules by name from its root and by subpath: `@better-router/core` exposes `Model`, `OpenResponses`, `Deployment`, `Routing`, `Transform`, `Http`, `Plugin`, and `Router`; `@better-router/core/Model` imports only the pinned OpenResponses schema types. The OpenAI Chat Completions plugin exposes `OpenAIChatCompletions`, `OpenAIChatCompletionsHttp`, and `OpenAIChatCompletionsPlugin`; the OpenAI Responses plugin exposes `OpenAIResponses` and `OpenAIResponsesPlugin`, while the Anthropic Messages plugin exposes `AnthropicMessages` and `AnthropicMessagesPlugin`. Future standalone example packages belong under `examples/` and are included through the `examples/*` workspace pattern.

The OpenAI Chat Completions plugin declares the `HttpApi` endpoint, independently of the OpenAI Responses plugin's deployment. The SDK calls `router.open`, `router.stream`, or `router.complete` directly; a server host serves `router.http.routes` with Effect's `HttpRouter`. A future plugin may contribute `/v1/responses` or mount a WebSocket upgrade as a raw HTTP route, without a separate gateway plugin.

The canonical request, event stream, and full response follow [OpenResponses 2026-04-24](https://www.openresponses.org/specification); `yarn generate:openresponses` regenerates the pinned types. See [Architecture](docs/architecture.md) for the proposed interfaces, lifecycle, and routing rules, and [Context](CONTEXT.md) for the terms used here.

`OpenAIChatCompletions.toResponseRequest` converts a Chat Completions request body into the OpenResponses request IR. `Router.make` validates and composes deployments, routing policies, transforms, and HTTP fragments. `OpenAIResponses.make` connects through Effect `HttpClient`; `OpenAIResponsesPlugin.make` declares deployments, while `OpenAIChatCompletionsPlugin.make` exposes the authenticated Chat endpoint and projects terminal JSON or streaming SSE results back into Chat Completions. Unsupported semantics produce explicit errors.

Build the library dependency and run the TypeScript example workspace with `tsx`, using a private upstream key and a separate key for clients:

```sh
devenv shell -- yarn build
OPENAI_API_KEY=your-upstream-key GATEWAY_API_KEY=your-client-key OPENAI_MODEL=your-responses-model devenv shell -- yarn workspace @better-router/example-chat-completions-gateway start
```

It listens on `127.0.0.1:8787` at `POST /v1/chat/completions`. Clients send `Authorization: Bearer your-client-key` and a Chat Completions JSON body. Optional `GATEWAY_MODEL` selects a public alias, `GATEWAY_PORT` / `GATEWAY_HOST` configure the listener, and `OPENAI_RESPONSES_URL` selects a trusted full upstream Responses URL. See [gateway details](docs/architecture.md#chat-completions-gateway).

Library packages build with tsdown to ESM-only `.mjs` entries, `.d.mts` declarations, and source maps. Root and PascalCase subpath exports resolve to `dist/`; the example package runs TypeScript directly with `tsx` and participates in project-reference type checking. TypeScript project references write intermediate declarations to ignored `.types/` directories. Yarn 4 manages the workspace.

```sh
devenv shell -- yarn install --immutable
devenv shell -- yarn check
devenv shell -- yarn build
```

Run `devenv shell -- treefmt` to format project files, or `devenv shell -- treefmt --ci` to fail if formatting changes are needed (`--ci` also writes those changes). The configuration excludes vendored `references/` projects and lockfiles.

Type contracts live in `type-tests/`: `architecture.mts` exercises a full configuration, while `*.tst.mts` files use Effect's `tstyche` pattern for exact inference and assignability assertions. Add invalid examples with `@ts-expect-error` where the rejected expression itself matters. Run `devenv shell -- yarn test-types` for focused type tests, or `check` for both compilation and type tests. TSTyche currently runs against TypeScript 6.0.3 (the latest stable version it supports); `check` also compiles the test files with the project's TypeScript 7.0.2.
